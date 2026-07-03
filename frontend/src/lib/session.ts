// session is the top-level client state machine: it wires the relay transport,
// the SPAKE2 pairing, and the secretbox app layer into the nine PWA screens.
//
//   pair -> (handshake) -> listening -> (request arrives) -> yesno|choice|text
//        -> (decision sealed & sent) -> confirmed -> listening
//   any transport drop -> offline (Reconnecting…); paired key is kept in RAM.
//
// It owns: box seal/open of wire messages, de-dupe by request id, and the
// single source of UI truth (SessionState). It depends on injectable factories
// so it is unit-testable without a real WebSocket or DOM.

import { open as boxOpen, seal as boxSeal } from './crypto.ts';
import { Pairing, type PairingSend } from './pairing.ts';
import { RelayClient, type ConnState, type RelayEvents, type RelayOptions } from './relay.ts';
import type { PairPayload } from './payload.ts';
import {
  type Decision,
  type PushSubscription,
  type Request,
  KindPushSub,
  KindVAPIDKey,
  decodeRequest,
  decodeVapidKey,
  encodeDecision,
  encodePushSub,
} from './wire.ts';

/** Screen is one of the nine PWA states the App renders. */
export type Screen =
  | 'lock'
  | 'home'
  | 'pair'
  | 'listening'
  | 'yesno'
  | 'choice'
  | 'text'
  | 'confirmed'
  | 'offline';

/** ResultLabel is the confirmed-screen headline + detail. */
export interface ConfirmedResult {
  icon: '✓' | '✗';
  label: 'Approved' | 'Declined' | 'Choice sent' | 'Reply sent';
  approved: boolean; // drives color (approve vs decline)
  detail: string;
}

/** SessionState is the immutable snapshot the React island renders. */
export interface SessionState {
  screen: Screen;
  conn: ConnState;
  attempt: number; // reconnect attempt counter (offline screen)
  peerPresent: boolean;
  paired: boolean;
  roomID: string;
  agent: string; // last-known agent label, for badges
  request: Request | null; // the active (deduped) request
  result: ConfirmedResult | null; // last decision (confirmed screen)
  pairError: string | null; // handshake failure message
}

/** RelayFactory builds a RelayClient (override in tests). */
export type SessionRelayFactory = (
  relayURL: string,
  roomID: string,
  events: RelayEvents,
) => RelayClient;

/** SessionOptions injects factories/clock for tests. */
export interface SessionOptions {
  relayOptions?: RelayOptions;
  relayFactory?: SessionRelayFactory;
  /**
   * onVapidKey fires when the agent delivers its VAPID public key (sealed). The
   * App subscribes for Web Push with this exact key so the signer == subscribe
   * key; the resulting subscription is sent back via sendPushSubscription.
   */
  onVapidKey?: (publicKey: string) => void;
}

/** initialState is the pre-pairing snapshot (the pair screen). */
export function initialState(): SessionState {
  return {
    screen: 'pair',
    conn: 'closed',
    attempt: 0,
    peerPresent: false,
    paired: false,
    roomID: '',
    agent: 'your agent',
    request: null,
    result: null,
    pairError: null,
  };
}

/**
 * Session is the orchestrator. Construct with a parsed pair payload, subscribe
 * with onChange, then start(). It transitions through the nine screens.
 */
export class Session {
  private state: SessionState;
  private readonly relay: RelayClient;
  private readonly pairing: Pairing;
  private sessionKey?: Uint8Array;
  // vapidKey is the agent-delivered VAPID public key (sealed during pairing); the
  // App subscribes for Web Push with exactly this key. Undefined until received.
  private vapidKey?: string;
  private readonly onVapidKey?: (publicKey: string) => void;
  private readonly seenIDs = new Set<string>();
  // sentDecisions retains each decision we believe we sent, keyed by request
  // id. If the agent re-announces an id that is in seenIDs, our decision never
  // arrived (the socket was half-open when we wrote it — iOS freezes a
  // backgrounded socket without erroring); re-send the retained decision so
  // the request doesn't hang unanswerable until its deadline. Bounded FIFO.
  private readonly sentDecisions = new Map<string, Decision>();
  private readonly listeners = new Set<(s: SessionState) => void>();
  private confirmedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(payload: PairPayload, opts: SessionOptions = {}) {
    this.state = { ...initialState(), roomID: payload.room };
    this.onVapidKey = opts.onVapidKey;

    const relayEvents: RelayEvents = {
      onState: (conn, attempt) => this.onConnState(conn, attempt),
      onSignal: (signal) => this.onSignal(signal),
      onPake: (b64) => this.pairing.onPeerPake(b64),
      onConfirm: (b64) => this.pairing.onPeerConfirm(b64),
      onBox: (b64) => this.onBox(b64),
    };
    this.relay = (opts.relayFactory ?? defaultRelayFactory(opts.relayOptions))(
      payload.r,
      payload.room,
      relayEvents,
    );

    const send: PairingSend = {
      sendPake: (b64) => this.relay.sendPake(b64),
      sendConfirm: (b64) => this.relay.sendConfirm(b64),
    };
    this.pairing = new Pairing(payload.code, send, {
      onPaired: (key) => this.onPaired(key),
      onError: (err) => this.onPairError(err),
    });
  }

  /** getState returns the current snapshot. */
  getState(): SessionState {
    return this.state;
  }

  /** getVapidKey returns the agent-delivered VAPID public key, or undefined if
   *  the agent has not sent one yet (App falls back to the build-time key). */
  getVapidKey(): string | undefined {
    return this.vapidKey;
  }

  /** onChange subscribes to state snapshots; returns an unsubscribe. */
  onChange(fn: (s: SessionState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** start opens the relay; pairing kicks off when the peer is present. */
  start(): void {
    this.relay.connect();
  }

  /** retry forces an immediate reconnect (offline screen Retry button). */
  retry(): void {
    this.relay.retryNow();
  }

  /** close tears down the transport and timers. */
  close(): void {
    if (this.confirmedTimer) clearTimeout(this.confirmedTimer);
    this.relay.close();
  }

  // --- decisions (phone -> agent) -----------------------------------------

  /** approve/decline send a yesno decision and advance to confirmed. */
  approve(): void {
    this.sendDecision(this.req().id, { kind: 'decision', id: this.req().id, result: { approved: true } }, {
      icon: '✓',
      label: 'Approved',
      approved: true,
      detail: this.req().summary,
    });
  }
  decline(): void {
    this.sendDecision(this.req().id, { kind: 'decision', id: this.req().id, result: { approved: false } }, {
      icon: '✗',
      label: 'Declined',
      approved: false,
      detail: this.req().summary,
    });
  }
  /** choose sends a choice decision. */
  choose(label: string): void {
    this.sendDecision(this.req().id, { kind: 'decision', id: this.req().id, result: { choice: label } }, {
      icon: '✓',
      label: 'Choice sent',
      approved: true,
      detail: `“${label}”`,
    });
  }
  /** reply sends a text decision (caller trims/clamps to max_len). */
  reply(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.sendDecision(this.req().id, { kind: 'decision', id: this.req().id, result: { text: t } }, {
      icon: '✓',
      label: 'Reply sent',
      approved: true,
      detail: `“${t}”`,
    });
  }

  /**
   * expire drives the session out of the actionable card once the agent has
   * timed the request out, so the user can't approve a dead request. No
   * decision is sent (the agent already gave up); mirrors sendDecision cleanup.
   */
  expire(id: string): void {
    if (this.state.request?.id !== id) return; // stale tick: card already gone
    this.seenIDs.add(id);
    this.set({ screen: 'listening', request: null, result: null });
  }

  /** sendPushSubscription seals + sends the phone's Web Push subscription. */
  sendPushSubscription(sub: PushSubscription): boolean {
    if (!this.sessionKey) return false;
    const bytes = encodePushSub({ kind: KindPushSub, subscription: sub });
    return this.relay.sendBox(boxSeal(this.sessionKey, bytes));
  }

  // --- internals -----------------------------------------------------------

  private sendDecision(id: string, decision: Decision, result: ConfirmedResult): void {
    if (!this.sessionKey) return;
    const bytes = encodeDecision(decision);
    if (!this.relay.sendBox(boxSeal(this.sessionKey, bytes))) {
      // Send dropped (socket not open / threw): do NOT claim "sent". Keep the
      // request so it stays answerable, leave id OUT of seenIDs so a resend is
      // accepted, and surface offline (its copy: no answer was sent).
      this.set({ screen: 'offline' });
      return;
    }
    // De-dupe: a re-announced request with this id won't reopen the card.
    this.seenIDs.add(id);
    this.retainDecision(id, decision);
    this.set({ screen: 'confirmed', result, request: null });
    // After a beat, return to the listening idle state (mirror the mockup).
    if (this.confirmedTimer) clearTimeout(this.confirmedTimer);
    this.confirmedTimer = setTimeout(() => {
      if (this.state.screen === 'confirmed') this.set({ screen: 'listening', result: null });
    }, 2600);
  }

  /** MAX_RETAINED_DECISIONS bounds sentDecisions (FIFO eviction). */
  private static readonly MAX_RETAINED_DECISIONS = 32;

  private retainDecision(id: string, decision: Decision): void {
    this.sentDecisions.set(id, decision);
    if (this.sentDecisions.size > Session.MAX_RETAINED_DECISIONS) {
      const oldest = this.sentDecisions.keys().next().value;
      if (oldest !== undefined) this.sentDecisions.delete(oldest);
    }
  }

  private onConnState(conn: ConnState, attempt: number): void {
    // Offline only matters once we've gotten somewhere; pre-pair stays on pair.
    if (conn === 'open') {
      // Reconnected: if paired, restore where we were; else show pair and (re)send pake.
      if (this.state.paired) {
        // Coming back from offline: if a request is still pending, restore its
        // card so a transient reconnect keeps it answerable; else go listening.
        // Any non-offline screen (open card / confirmed) is left untouched.
        const screen =
          this.state.screen === 'offline'
            ? this.state.request
              ? cardScreen(this.state.request)
              : 'listening'
            : this.state.screen;
        this.set({ conn, attempt, screen });
      } else {
        this.set({ conn, attempt });
      }
      return;
    }
    if (conn === 'closed') {
      // A drop after pairing surfaces the offline screen (key kept in RAM).
      const screen = this.state.paired && this.state.screen !== 'pair' ? 'offline' : this.state.screen;
      this.set({ conn, attempt, peerPresent: false, screen });
      return;
    }
    this.set({ conn, attempt });
  }

  private onSignal(signal: string): void {
    if (signal === 'peer_joined') {
      this.set({ peerPresent: true });
      // Peer present => start (or re-send) our pake; harmless if already paired.
      if (!this.state.paired) this.pairing.start();
      return;
    }
    if (signal === 'peer_left') {
      // If a card is open, the agent that asked has departed: surface offline so
      // the card isn't answerable against a gone agent (key kept in RAM; a
      // returning agent + re-announce restores it via onConnState/onBox).
      const onCard =
        this.state.screen === 'yesno' ||
        this.state.screen === 'choice' ||
        this.state.screen === 'text';
      this.set({ peerPresent: false, screen: onCard ? 'offline' : this.state.screen });
      return;
    }
    // undeliverable: our frame had no peer. The agent owns retries; we just
    // re-announce our pake so a returning agent can pair.
    if (signal === 'undeliverable' && !this.state.paired) {
      this.pairing.start();
    }
  }

  private onBox(b64: string): void {
    if (!this.sessionKey) return; // not paired yet; ignore stray box
    let plaintext: Uint8Array;
    try {
      plaintext = boxOpen(this.sessionKey, b64);
    } catch {
      return; // authentication failed: drop silently (never trust it)
    }
    // The agent's VAPID public key arrives sealed during pairing: store it and
    // notify so the App subscribes for Web Push with exactly this key. Decode
    // best-effort; a malformed frame is ignored (push stays best-effort).
    if (peekKind(plaintext) === KindVAPIDKey) {
      try {
        const vk = decodeVapidKey(plaintext);
        this.vapidKey = vk.public_key;
        this.onVapidKey?.(vk.public_key);
      } catch {
        /* not a usable vapid_key — ignore */
      }
      return;
    }
    let req: Request;
    try {
      req = decodeRequest(plaintext);
    } catch {
      return; // not a request we render (e.g. an ack) — ignore
    }
    if (this.seenIDs.has(req.id)) {
      // The agent re-announced an id we already handled. If we answered it,
      // the agent is still asking, so our decision was lost in flight —
      // re-send it (idempotent: the agent takes the first matching decision).
      // A seen id WITHOUT a retained decision was expired locally; stay
      // silent (the agent timed it out on its side too).
      const dec = this.sentDecisions.get(req.id);
      if (dec) this.relay.sendBox(boxSeal(this.sessionKey, encodeDecision(dec)));
      return;
    }
    this.seenIDs.add(req.id);
    this.set({
      request: req,
      screen: cardScreen(req),
      agent: req.agent || this.state.agent,
      result: null,
    });
  }

  private onPaired(key: Uint8Array): void {
    this.sessionKey = key;
    this.set({ paired: true, screen: 'listening', pairError: null });
  }

  private onPairError(err: Error): void {
    this.set({ pairError: err.message });
  }

  private req(): Request {
    if (!this.state.request) throw new Error('session: no active request');
    return this.state.request;
  }

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }
}

/** peekKind reads just the `kind` tag off a sealed-box plaintext so onBox can
 *  route to the right decoder. Returns '' if it isn't parseable JSON / no kind. */
function peekKind(plaintext: Uint8Array): string {
  try {
    const v = JSON.parse(new TextDecoder().decode(plaintext)) as { kind?: unknown };
    return typeof v.kind === 'string' ? v.kind : '';
  } catch {
    return '';
  }
}

/** cardScreen maps a request's response kind to its answerable card screen. */
function cardScreen(req: Request): Screen {
  if (req.response.kind === 'choice') return 'choice';
  if (req.response.kind === 'text') return 'text';
  return 'yesno';
}

function defaultRelayFactory(opts?: RelayOptions): SessionRelayFactory {
  return (relayURL, roomID, events) => new RelayClient(relayURL, roomID, events, opts);
}
