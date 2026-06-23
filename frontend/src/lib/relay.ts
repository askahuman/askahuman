// relay is the WebSocket client for the dumb rendezvous relay.
//
// Contract (task brief + plan §5): connect to <r>?room=<roomID>; the relay
// forwards every DATA frame verbatim to the other room member and injects only
// control frames carrying `_relay` (peer_joined | peer_left | undeliverable).
// We distinguish frames by JSON key: has `_relay` => control; else app frame
// ({pake} | {confirm} | {box}). This module owns transport + reconnect; it does
// no crypto and never inspects box contents.

import {
  type Frame,
  type RelaySignal,
  isRelayControl,
  parseFrame,
} from './wire.ts';

/** ConnState is the transport's lifecycle as surfaced to the UI. */
export type ConnState = 'connecting' | 'open' | 'closed';

/** RelayEvents are the callbacks a consumer (the session) wires in. */
export interface RelayEvents {
  /** onState fires on every transport state transition. */
  onState?: (state: ConnState, attempt: number) => void;
  /** onSignal fires for a relay control frame (peer_joined/left/undeliverable). */
  onSignal?: (signal: RelaySignal) => void;
  /** onPake fires for an app {pake:...} frame from the peer. */
  onPake?: (b64: string) => void;
  /** onConfirm fires for an app {confirm:...} frame from the peer. */
  onConfirm?: (b64: string) => void;
  /** onBox fires for an app {box:...} frame from the peer. */
  onBox?: (b64: string) => void;
}

/** WSLike is the subset of WebSocket this client uses (mockable in tests). */
export interface WSLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

/** WSFactory builds a WSLike for a url (defaults to the global WebSocket). */
export type WSFactory = (url: string) => WSLike;

/** RelayOptions configures backoff and the WebSocket factory (for tests). */
export interface RelayOptions {
  /** wsFactory overrides the transport (default: new WebSocket(url)). */
  wsFactory?: WSFactory;
  /** baseDelayMs is the first reconnect delay (default 500). */
  baseDelayMs?: number;
  /** maxDelayMs caps exponential backoff (default 15000). */
  maxDelayMs?: number;
  /** now/setTimer are injectable for deterministic backoff tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  /**
   * heartbeatMs is the client keepalive interval while a socket is open
   * (default 25000). On iOS the WebSocket dies silently when backgrounded and a
   * frozen timer never reconnects; a periodic tiny frame keeps the load
   * balancer's idle timer warm and surfaces a dead socket sooner (its close
   * fires reconnect). Set 0 to disable (tests). Uses the same injectable timer.
   */
  heartbeatMs?: number;
}

const defaultFactory: WSFactory = (url) => new WebSocket(url) as unknown as WSLike;

/**
 * roomURL appends ?room=<roomID> to the relay base ws url. Defense-in-depth: the
 * URL must be a WebSocket scheme ("wss:", or "ws:" only for localhost/127.0.0.1)
 * before we ever hand it to `new WebSocket` — payload.validPayload already gates
 * deep links, but this is the last barrier against opening a non-WS scheme.
 */
export function roomURL(relayURL: string, roomID: string): string {
  const u = new URL(relayURL);
  const wsOK =
    u.protocol === 'wss:' ||
    (u.protocol === 'ws:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'));
  if (!wsOK) throw new Error(`relay: refusing non-WebSocket scheme "${u.protocol}"`);
  u.searchParams.set('room', roomID);
  return u.toString();
}

/**
 * RelayClient owns one logical connection to a room. It auto-reconnects with
 * exponential backoff after an unexpected close (the agent owns retries; the
 * phone just needs to be present), until close() is called.
 */
export class RelayClient {
  private readonly url: string;
  private readonly events: RelayEvents;
  private readonly factory: WSFactory;
  private readonly baseDelay: number;
  private readonly maxDelay: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;
  private readonly heartbeatMs: number;

  private ws: WSLike | null = null;
  private state: ConnState = 'closed';
  private attempt = 0;
  private stopped = false;
  private reconnectHandle: unknown = null;
  private heartbeatHandle: unknown = null;

  constructor(relayURL: string, roomID: string, events: RelayEvents, opts: RelayOptions = {}) {
    this.url = roomURL(relayURL, roomID);
    this.events = events;
    this.factory = opts.wsFactory ?? defaultFactory;
    this.baseDelay = opts.baseDelayMs ?? 500;
    this.maxDelay = opts.maxDelayMs ?? 15000;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.heartbeatMs = opts.heartbeatMs ?? 25_000;
  }

  /** connect opens the socket and wires handlers; idempotent while open. */
  connect(): void {
    if (this.stopped) return;
    if (this.ws) return;
    this.setState('connecting');
    const ws = this.factory(this.url);
    this.ws = ws;
    // Guard every handler against a STALE socket. Browsers fire onclose
    // ASYNCHRONOUSLY, so a socket we already replaced (retryNow on an iOS resume)
    // can still deliver a late onclose/onmessage; if it ran it would null out or
    // schedule a reconnect over the live replacement. Ignore any event whose
    // socket is no longer the current one.
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.setState('open');
      this.startHeartbeat();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.handleMessage(ev.data);
    };
    ws.onerror = () => {
      // An error precedes onclose; the close handler drives reconnect.
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.handleClose(ev?.code);
    };
  }

  /** send transmits one app frame verbatim; no-op if not open. */
  send(frame: Frame): boolean {
    if (this.state !== 'open' || !this.ws) return false;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch {
      return false; // half-open socket: report drop (mirror heartbeat path)
    }
    return true;
  }

  /** sendPake / sendConfirm / sendBox are typed conveniences over send(). */
  sendPake(b64: string): boolean {
    return this.send({ pake: b64 });
  }
  sendConfirm(b64: string): boolean {
    return this.send({ confirm: b64 });
  }
  sendBox(b64: string): boolean {
    return this.send({ box: b64 });
  }

  /** currentState exposes the live connection state. */
  currentState(): ConnState {
    return this.state;
  }
  /** currentAttempt exposes the reconnect attempt counter. */
  currentAttempt(): number {
    return this.attempt;
  }

  /**
   * retryNow forces an immediate, clean reconnect — the offline Retry button and
   * the App's visibility/online recovery (iOS silently kills a backgrounded
   * socket and its frozen reconnect timer never fires). dropSocket detaches the
   * old socket's handlers BEFORE closing, so its asynchronous onclose cannot
   * reconnect over or null out the replacement we open here.
   */
  retryNow(): void {
    if (this.stopped) return;
    if (this.reconnectHandle !== null) {
      this.clearTimer(this.reconnectHandle);
      this.reconnectHandle = null;
    }
    this.stopHeartbeat();
    this.dropSocket();
    this.connect();
  }

  /** close stops reconnection and closes the socket for good. */
  close(): void {
    this.stopped = true;
    this.stopHeartbeat();
    if (this.reconnectHandle !== null) {
      this.clearTimer(this.reconnectHandle);
      this.reconnectHandle = null;
    }
    this.dropSocket();
    this.setState('closed');
  }

  /**
   * dropSocket detaches the current socket's handlers — so a late, asynchronous
   * onclose/onmessage from it is inert and cannot mutate state — then closes it.
   * Used by retryNow/close where WE intentionally discard the socket (vs an
   * unexpected server close, which flows through the guarded onclose).
   */
  private dropSocket(): void {
    const ws = this.ws;
    if (!ws) return;
    ws.onopen = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    this.ws = null;
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  // --- internals -----------------------------------------------------------

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return; // relay speaks JSON text only
    const frame = parseFrame(data);
    if (!frame) return; // never crash on a malformed/opaque frame
    // A genuine relay control frame carries ONLY `_relay`. The relay strips any
    // client-set `_relay`, but defend in depth: a peer could try to smuggle a
    // spoofed signal alongside an app field. Honor `_relay` only when no app
    // payload rides with it; otherwise ignore the signal entirely.
    if (isRelayControl(frame)) {
      const hasAppField =
        frame.pake !== undefined || frame.confirm !== undefined || frame.box !== undefined;
      if (!hasAppField) this.events.onSignal?.(frame._relay);
      return;
    }
    if (typeof frame.pake === 'string') {
      this.events.onPake?.(frame.pake);
      return;
    }
    if (typeof frame.confirm === 'string') {
      this.events.onConfirm?.(frame.confirm);
      return;
    }
    if (typeof frame.box === 'string') {
      this.events.onBox?.(frame.box);
      return;
    }
    // Unknown app frame: ignore (forward-compat; relay is content-blind).
  }

  private handleClose(code?: number): void {
    this.ws = null;
    this.stopHeartbeat();
    // 4001 = room full (a third joiner). Do not loop on a fatal close.
    if (this.stopped || code === 4001) {
      this.setState('closed');
      return;
    }
    this.setState('closed');
    this.scheduleReconnect();
  }

  /**
   * startHeartbeat sends a tiny empty app frame every heartbeatMs while open.
   * The relay forwards it verbatim to the peer (which ignores an unknown app
   * frame) and answers `undeliverable` when alone — both harmless. Purpose is
   * to keep the LB idle timer warm and to fail fast on a half-open socket: a
   * send on a dead socket throws -> we force a reconnect. Self-reschedules via
   * the injectable one-shot setTimer so backoff tests stay deterministic.
   */
  private startHeartbeat(): void {
    if (this.heartbeatMs <= 0) return;
    this.stopHeartbeat();
    const beat = () => {
      if (this.stopped || this.state !== 'open' || !this.ws) return;
      try {
        this.ws.send('{}'); // empty Frame: relay-forwarded, peer ignores it
      } catch {
        // Half-open socket: drop it and reconnect rather than believe it open.
        this.retryNow();
        return;
      }
      this.heartbeatHandle = this.setTimer(beat, this.heartbeatMs);
    };
    this.heartbeatHandle = this.setTimer(beat, this.heartbeatMs);
  }

  /** stopHeartbeat clears the keepalive timer (close/reconnect). */
  private stopHeartbeat(): void {
    if (this.heartbeatHandle !== null) {
      this.clearTimer(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.attempt += 1;
    const delay = Math.min(this.maxDelay, this.baseDelay * 2 ** (this.attempt - 1));
    this.reconnectHandle = this.setTimer(() => {
      this.reconnectHandle = null;
      this.connect();
    }, delay);
  }

  private setState(s: ConnState): void {
    this.state = s;
    this.events.onState?.(s, this.attempt);
  }
}
