import {
  loadProtocolLedger,
  protocolScope,
  type ProtocolLedger,
  type ProtocolLedgerLoader,
} from './protocol-state.ts';
// Session owns the phone's authenticated pairing, displayed requests, and
// durable pending answers. A socket write is not an agent acceptance receipt.
import { open as boxOpen, seal as boxSeal } from './crypto.ts';
import {
  type DeviceKey as DeviceSigner,
  loadOrCreateDeviceKey,
} from './devicekey.ts';
import { Pairing } from './pairing.ts';
import {
  RelayClient,
  type ConnState,
  type RelayEvents,
  type RelayOptions,
} from './relay.ts';
import type { PairPayload } from './payload.ts';
import {
  type Decision,
  type Result,
  type PushSubscription,
  type PushSub,
  type Request,
  type VapidKey,
  decodeRequest,
  encodeDecision,
  encodePushSub,
} from './wire.ts';
import {
  PROTOCOL,
  UPGRADE_MESSAGE,
  MAX_TEXT,
  MAX_PLAINTEXT,
  fields,
  importSigner,
  verify,
  strictJSON,
  object,
  bounded,
  scalarLength,
  requestHash,
  requestSigningMessage,
  boundDecisionSigningMessage,
  decisionHash,
  decodeAck,
  ackSigningMessage,
  pushSigningMessage,
  vapidSigningMessage,
  validateDecision,
  type Ack,
} from './protocol.ts';

export type Screen =
  | 'lock'
  | 'home'
  | 'pair'
  | 'listening'
  | 'yesno'
  | 'choice'
  | 'text'
  | 'pending'
  | 'confirmed'
  | 'offline';
export type DeliveryState =
  'signing' | 'awaiting' | 'uncertain' | 'expired' | null;
export interface ConfirmedResult {
  icon: '✓' | '✗';
  label: 'Answer received by agent';
  approved: boolean;
  detail: string;
}
export interface SessionState {
  screen: Screen;
  conn: ConnState;
  attempt: number;
  peerPresent: boolean;
  paired: boolean;
  roomID: string;
  agent: string;
  request: Request | null;
  result: ConfirmedResult | null;
  pairError: string | null;
  delivery?: DeliveryState;
  answerError?: string | null;
}
export type SessionRelayFactory = (
  relayURL: string,
  roomID: string,
  events: RelayEvents,
) => RelayClient;
export interface SessionOptions {
  relayOptions?: RelayOptions;
  relayFactory?: SessionRelayFactory;
  onVapidKey?: (publicKey: string) => void;
  deviceKeyLoader?: () => Promise<DeviceSigner | null>;
  now?: () => number;
  protocolLedgerLoader?: ProtocolLedgerLoader;
}
export interface PersistedProtocolState {
  protocol?: number;
  agentSigner?: string;
  deviceSigner?: string;
  request?: Request;
  seen?: string[];
  decisions?: Record<string, Decision>;
  receipts?: Record<string, Ack>;
}
export interface RestoredSession extends PersistedProtocolState {
  key: Uint8Array;
  agent?: string;
  vapid?: string;
}
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
    delivery: null,
  };
}

export class Session {
  private state: SessionState;
  private readonly relay: RelayClient;
  private pairing: Pairing | null = null;
  private sessionKey?: Uint8Array;
  private canPersist = false;
  private deviceKey: DeviceSigner | null = null;
  private agentPublic?: CryptoKey;
  private agentSigner?: string;
  private pinnedDeviceSigner?: string;
  private protocol?: number;
  private vapidKey?: string;
  private readonly onVapidKey?: (publicKey: string) => void;
  private readonly now: () => number;
  private readonly ready: Promise<void>;
  private readonly ledgerLoader: ProtocolLedgerLoader;
  private ledger?: ProtocolLedger;
  private protocolReady: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly seenIDs = new Set<string>();
  private readonly sentDecisions = new Map<string, Decision>();
  private readonly receipts = new Map<string, Ack>();
  private readonly listeners = new Set<(s: SessionState) => void>();
  private confirmedTimer: ReturnType<typeof setTimeout> | null = null;
  private receiptTimer: ReturnType<typeof setInterval> | null = null;
  private readonly inbox: string[] = [];
  private draining = false;

  constructor(
    payload: PairPayload,
    opts: SessionOptions = {},
    restored?: RestoredSession,
  ) {
    this.state = { ...initialState(), roomID: payload.room };
    this.onVapidKey = opts.onVapidKey;
    this.now = opts.now ?? Date.now;
    this.ledgerLoader = opts.protocolLedgerLoader ?? loadProtocolLedger;
    const events: RelayEvents = {
      onState: (conn, attempt) => this.onConnState(conn, attempt),
      onSignal: (signal) => this.onSignal(signal),
      onPake: (b64) => {
        void this.pairing?.onPeerPake(b64);
      },
      onConfirm: (b64) => this.pairing?.onPeerConfirm(b64),
      onBox: (b64) => this.enqueueBox(b64),
    };
    this.relay = (
      opts.relayFactory ??
      ((r, room, e) => new RelayClient(r, room, e, opts.relayOptions))
    )(payload.r, payload.room, events);
    // Retain legacy entries and identities for actionable repair. They may not
    // connect, display authorization cards, or silently enroll a fresh signer.
    if (restored) {
      this.sessionKey = restored.key;
      this.canPersist = true;
      this.protocol = restored.protocol;
      this.agentSigner = restored.agentSigner;
      this.pinnedDeviceSigner = restored.deviceSigner;
      this.state.agent = restored.agent || this.state.agent;
    }
    this.ready = this.initialize(payload, opts, restored).catch(() => {
      if (!this.closed)
        this.onPairError(
          new Error(`Secure signing is unavailable. ${UPGRADE_MESSAGE}`),
        );
    });
  }

  private async initialize(
    payload: PairPayload,
    opts: SessionOptions,
    restored?: RestoredSession,
  ): Promise<void> {
    if (
      restored &&
      (restored.protocol !== PROTOCOL ||
        !restored.agentSigner ||
        !restored.deviceSigner)
    ) {
      this.onPairError(
        new Error(`This saved pairing needs an upgrade. ${UPGRADE_MESSAGE}`),
      );
      return;
    }
    const device = await (opts.deviceKeyLoader ?? loadOrCreateDeviceKey)();
    if (this.closed) return;
    if (!device) throw new Error('No secure signer');
    const pub = await importSigner(device.spkiB64);
    const proof = fields('aah:device-key-check:v2', device.spkiB64);
    if (!(await verify(pub, proof, await device.sign(proof))))
      throw new Error('Stored signer mismatch');
    if (restored && device.spkiB64 !== restored.deviceSigner) {
      this.onPairError(
        new Error(
          `The signing key for this pairing is unavailable. ${UPGRADE_MESSAGE}`,
        ),
      );
      return;
    }
    if (this.closed) return;
    this.deviceKey = device;
    this.pinnedDeviceSigner = device.spkiB64;
    if (restored) {
      this.agentPublic = await importSigner(restored.agentSigner!);
      this.ledger = await this.ledgerLoader(
        protocolScope(payload.room, restored.agentSigner!, device.spkiB64),
        true,
      );
      if (this.closed) return;
      for (const id of (restored.seen ?? []).slice(-50)) {
        if (typeof id === 'string') this.seenIDs.add(id);
      }
      // Persistence is untrusted. Verify restored decisions/receipts before any
      // retransmission or success UI; a copied session key cannot manufacture them.
      for (const [id, d] of Object.entries(restored.decisions ?? {}).slice(
        -32,
      )) {
        try {
          validateDecision(d);
          if (
            d.id === id &&
            d.room === payload.room &&
            (await verify(pub, boundDecisionSigningMessage(d), d.sig))
          )
            this.sentDecisions.set(id, d);
        } catch {
          /* discard corrupt pending record */
        }
      }
      for (const [id, a] of Object.entries(restored.receipts ?? {}).slice(
        -32,
      )) {
        try {
          const ack = decodeAck(new TextEncoder().encode(JSON.stringify(a)));
          const d = this.sentDecisions.get(id);
          if (
            d &&
            this.matchesAck(ack, d) &&
            (await verify(this.agentPublic, ackSigningMessage(ack), ack.sig))
          )
            this.receipts.set(id, ack);
        } catch {
          /* no verified receipt means uncertain */
        }
      }
      let request: Request | null = null;
      if (restored.request) {
        try {
          const r = decodeRequest(
            new TextEncoder().encode(JSON.stringify(restored.request)),
          );
          if (
            r.room === payload.room &&
            (await verify(this.agentPublic, requestSigningMessage(r), r.sig))
          )
            request = r;
        } catch {
          /* wait for an authenticated re-announcement */
        }
      }
      if (
        request &&
        !(await this.ledger.currentRequest(
          request.request_seq!,
          requestHash(request),
        ))
      )
        request = null;
      if (this.closed) return;
      this.vapidKey = restored.vapid;
      const sent = request && this.sentDecisions.get(request.id);
      // Even an expired pending answer can recover an earlier acceptance receipt.
      if (request && !sent && this.expired(request)) {
        this.seenIDs.add(request.id);
        request = null;
      }
      this.set({
        paired: true,
        screen: request
          ? sent
            ? 'pending'
            : cardScreen(request)
          : 'listening',
        request,
        delivery: sent
          ? this.receipts.get(sent.id)?.status === 'expired'
            ? 'expired'
            : 'uncertain'
          : null,
        pairError: null,
      });
      return;
    }
    this.pairing = new Pairing(
      payload.code,
      {
        sendPake: (b64) => this.relay.sendPake(b64),
        sendConfirm: (b64) => this.relay.sendConfirm(b64),
      },
      {
        onPaired: (key, agentSigner, publicKey) =>
          this.onPaired(key, agentSigner, publicKey),
        onError: (err) => this.onPairError(err),
      },
      { room: payload.room, signer: device.spkiB64 },
    );
  }

  getState(): SessionState {
    return this.state;
  }
  getVapidKey(): string | undefined {
    return this.vapidKey;
  }
  getSessionKey(): Uint8Array | undefined {
    return this.canPersist ? this.sessionKey : undefined;
  }
  persistState(): PersistedProtocolState {
    return {
      protocol: this.protocol,
      agentSigner: this.agentSigner,
      deviceSigner: this.pinnedDeviceSigner,
      request: this.state.request ?? undefined,
      seen: Array.from(this.seenIDs).slice(-50),
      decisions: Object.fromEntries(this.sentDecisions),
      receipts: Object.fromEntries(this.receipts),
    };
  }
  onChange(fn: (s: SessionState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  start(): void {
    void this.ready.then(() => {
      if (!this.closed && !this.state.pairError) this.relay.connect();
    });
  }
  retry(): void {
    if (this.closed || this.state.pairError) return;
    this.retryPending();
    this.relay.retryNow(); // iOS can freeze a socket while it still looks open.
  }
  close(): void {
    this.closed = true;
    if (this.confirmedTimer) clearTimeout(this.confirmedTimer);
    if (this.receiptTimer) clearInterval(this.receiptTimer);
    this.inbox.length = 0;
    this.relay.close();
  }
  forget(): Promise<void> {
    this.close();
    return this.ready
      .then(() => this.protocolReady)
      .then(() => this.ledger?.forget());
  }
  private ledgerFailed(): void {
    this.onPairError(
      new Error(
        `Secure pairing sequence storage is unavailable. ${UPGRADE_MESSAGE}`,
      ),
    );
  }
  approve(): void {
    void this.sendDecision({ approved: true }, 'yesno');
  }
  decline(): void {
    void this.sendDecision({ approved: false }, 'yesno');
  }
  choose(choice: string): void {
    void this.sendDecision({ choice }, 'choice');
  }
  reply(text: string): void {
    void this.sendDecision({ text }, 'text');
  }
  expire(id: string): void {
    if (this.state.request?.id !== id) return;
    if (this.sentDecisions.has(id)) {
      this.set({
        screen: 'pending',
        delivery:
          this.receipts.get(id)?.status === 'expired' ? 'expired' : 'uncertain',
      });
      return;
    }
    this.seenIDs.add(id);
    this.set({
      screen: 'listening',
      request: null,
      result: null,
      delivery: null,
    });
  }
  /** Check durable pair membership before touching a native push registration.
   * A different tab can forget the pairing while this Session remains alive.
   * Restored mode validates the existing ledger without allocating counters or
   * recreating a missing record. The caller holds the room's push lock. */
  async canReconcilePush(): Promise<boolean> {
    if (this.closed) return false;
    await this.ready;
    if (this.closed) return false;
    await this.protocolReady;
    const ledger = this.ledger;
    if (!ledger || !this.state.paired || !this.agentSigner ||
        !this.pinnedDeviceSigner || !this.sessionKey || !this.deviceKey || this.closed)
      return false;
    try {
      await this.ledgerLoader(protocolScope(
        this.state.roomID, this.agentSigner, this.pinnedDeviceSigner,
      ), true);
      return !this.closed && this.state.paired && this.ledger === ledger;
    } catch {
      if (!this.closed) this.ledgerFailed();
      return false;
    }
  }
  async sendPushSubscription(sub: PushSubscription): Promise<boolean> {
    await this.ready;
    await this.protocolReady;
    if (
      !this.ledger ||
      !this.state.paired ||
      !this.sessionKey ||
      !this.deviceKey ||
      this.closed
    )
      return false;
    const ps: PushSub = {
      kind: 'push_sub',
      protocol: PROTOCOL,
      room: this.state.roomID,
      subscription: sub,
    };
    try {
      ps.push_seq = await this.ledger.nextPush();
      ps.sig = await this.deviceKey.sign(pushSigningMessage(ps));
      if (!(await this.ledger.currentPush(ps.push_seq))) return false;
      return (
        !this.closed &&
        this.relay.sendBox(boxSeal(this.sessionKey, encodePushSub(ps)))
      );
    } catch {
      if (!this.closed) this.ledgerFailed();
      return false;
    }
  }

  private expired(req: Request): boolean {
    return !!req.deadline_ms && this.now() >= req.deadline_ms;
  }
  private async sendDecision(
    result: Result,
    kind: Request['response']['kind'],
  ): Promise<void> {
    const req = this.state.request;
    if (
      !req ||
      !this.sessionKey ||
      !this.deviceKey ||
      !this.state.paired ||
      this.closed ||
      req.response.kind !== kind ||
      this.state.delivery ||
      this.sentDecisions.has(req.id)
    )
      return;
    if (this.expired(req)) {
      this.expire(req.id);
      return;
    }
    const d: Decision = {
      kind: 'decision',
      protocol: PROTOCOL,
      room: this.state.roomID,
      id: req.id,
      request_hash: requestHash(req),
      response_kind: kind,
      result,
    };
    try {
      validateDecision(d);
      if (kind === 'choice' && !req.response.options?.includes(result.choice!))
        return;
      if (
        kind === 'text' &&
        scalarLength(result.text ?? '') > (req.response.max_len || MAX_TEXT)
      )
        return;
      // Check the complete encoded answer (including signature space) before
      // persisting or signing it. Long Unicode/control text can hit the shared
      // transport cap before its scalar limit; keep the card editable.
      try {
        encodeDecision({ ...d, sig: 'A'.repeat(88) });
      } catch {
        this.set({
          answerError:
            'This reply is too large to send. Shorten it and try again.',
        });
        return;
      }
      this.set({
        screen: 'pending',
        delivery: 'signing',
        result: null,
        answerError: null,
      });
      if (
        !this.ledger ||
        !(await this.ledger.currentRequest(req.request_seq!, d.request_hash!))
      ) {
        if (!this.closed && this.state.request === req) {
          this.set({ delivery: null });
          this.expire(req.id);
        }
        return;
      }
      if (this.closed || this.state.request !== req) return;
      d.sig = await this.deviceKey.sign(boundDecisionSigningMessage(d));
      if (this.closed || this.state.request !== req) return;
      if (
        !(await this.ledger.currentRequest(req.request_seq!, d.request_hash!))
      ) {
        this.set({ delivery: null });
        this.expire(req.id);
        return;
      }
      if (this.closed || this.state.request !== req) return;
      if (this.expired(req)) {
        this.set({ delivery: null });
        this.expire(req.id);
        return;
      }
      // Register/persist before the socket write. A synchronous test transport
      // (or a very fast peer) must never deliver an ack before pending exists.
      this.retainDecision(d);
      this.seenIDs.add(req.id);
      this.set({ screen: 'pending', delivery: 'awaiting' });
      const sent = this.relay.sendBox(
        boxSeal(this.sessionKey, encodeDecision(d)),
      );
      if (!sent) this.set({ screen: 'pending', delivery: 'uncertain' });
      this.armReceiptRetry();
    } catch {
      if (!this.closed && this.state.request === req) this.ledgerFailed();
    }
  }
  private retainDecision(d: Decision): void {
    this.sentDecisions.set(d.id, d);
    if (this.sentDecisions.size > 32) {
      const id = this.sentDecisions.keys().next().value;
      if (id !== undefined) {
        this.sentDecisions.delete(id);
        this.receipts.delete(id);
      }
    }
  }
  private armReceiptRetry(): void {
    if (this.receiptTimer) return;
    this.receiptTimer = setInterval(() => {
      if (this.closed) return;
      // A lost write or ack never becomes success just because time elapsed.
      if (this.state.screen === 'pending' && this.state.delivery !== 'expired')
        this.set({ delivery: 'uncertain' });
      this.retryPending();
    }, 5000);
  }
  private retryPending(): void {
    if (!this.sessionKey || this.closed) return;
    for (const [id, d] of this.sentDecisions) {
      if (
        this.receipts.get(id)?.status === 'accepted' ||
        this.receipts.get(id)?.status === 'expired'
      )
        continue;
      this.relay.sendBox(boxSeal(this.sessionKey, encodeDecision(d)));
    }
  }
  private onConnState(conn: ConnState, attempt: number): void {
    if (this.closed) return;
    let screen = this.state.screen;
    if (this.state.paired && screen !== 'pending' && screen !== 'confirmed') {
      if (conn === 'closed') screen = 'offline';
      else if (conn === 'open' && screen === 'offline')
        screen = this.state.request
          ? cardScreen(this.state.request)
          : 'listening';
    }
    this.set({
      conn,
      attempt,
      screen,
      ...(conn === 'closed' ? { peerPresent: false } : {}),
    });
    if (conn === 'open' && this.state.paired) {
      this.retryPending();
      this.armReceiptRetry();
    }
  }
  private onSignal(signal: string): void {
    if (this.closed) return;
    if (signal === 'peer_joined') {
      this.set({ peerPresent: true });
      if (!this.state.paired) this.pairing?.start();
      else this.retryPending();
    } else if (signal === 'peer_left') {
      const onCard = ['yesno', 'choice', 'text'].includes(this.state.screen);
      this.set({
        peerPresent: false,
        screen: onCard ? 'offline' : this.state.screen,
        ...(this.state.screen === 'pending' && this.state.delivery !== 'expired'
          ? { delivery: 'uncertain' }
          : {}),
      });
    } else if (signal === 'undeliverable') {
      if (!this.state.paired) this.pairing?.start();
      else if (
        this.state.screen === 'pending' &&
        this.state.delivery !== 'expired'
      )
        this.set({ delivery: 'uncertain' });
    }
  }
  private enqueueBox(b64: string): void {
    if (
      this.closed ||
      !this.sessionKey ||
      b64.length > Math.ceil((MAX_PLAINTEXT + 40) / 3) * 4 ||
      this.inbox.length >= 32
    )
      return;
    this.inbox.push(b64);
    if (!this.draining) void this.drainBoxes();
  }
  private async drainBoxes(): Promise<void> {
    this.draining = true;
    try {
      while (!this.closed && this.inbox.length) {
        const b64 = this.inbox.shift()!;
        try {
          await this.onBox(b64);
        } catch {
          /* malformed/invalid identity: fail closed */
        }
      }
    } finally {
      this.draining = false;
    }
  }
  private async onBox(b64: string): Promise<void> {
    await this.protocolReady;
    if (!this.sessionKey || !this.agentPublic || !this.state.paired) return;
    const plain = boxOpen(this.sessionKey, b64);
    const tag = object(strictJSON(plain), [
      'kind',
      'protocol',
      'room',
      'id',
      'request_hash',
      'decision_hash',
      'status',
      'sig',
      'public_key',
      'deadline_ms',
      'request_seq',
      'title',
      'category',
      'summary',
      'agent',
      'response',
      'expires_in_s',
    ]);
    if (tag.kind === 'ack') {
      await this.onAck(decodeAck(plain));
      return;
    }
    if (tag.kind === 'vapid_key') {
      object(tag, ['kind', 'protocol', 'room', 'sig', 'public_key']);
      const v = tag as unknown as VapidKey;
      bounded(v.public_key, 'VAPID key', 256, true);
      if (
        v.protocol !== PROTOCOL ||
        v.room !== this.state.roomID ||
        !(await verify(this.agentPublic, vapidSigningMessage(v), v.sig)) ||
        this.closed
      )
        return;
      this.vapidKey = v.public_key;
      this.onVapidKey?.(v.public_key);
      return;
    }
    const req = decodeRequest(plain);
    if (
      req.room !== this.state.roomID ||
      !(await verify(this.agentPublic, requestSigningMessage(req), req.sig)) ||
      this.closed
    )
      return;
    const d = this.sentDecisions.get(req.id);
    if (d) {
      if (
        d.request_hash === requestHash(req) &&
        this.receipts.get(req.id)?.status !== 'accepted'
      ) {
        this.relay.sendBox(boxSeal(this.sessionKey, encodeDecision(d)));
      }
      return;
    }
    try {
      if (
        !this.ledger ||
        !(await this.ledger.observeRequest(req.request_seq!, requestHash(req)))
      )
        return;
    } catch {
      this.ledgerFailed();
      return;
    }
    if (this.closed) return;
    if (this.state.request?.id === req.id) {
      // A re-announcement cannot change the question or reset its deadline.
      if (requestHash(this.state.request) !== requestHash(req)) return;
      if (this.expired(this.state.request)) {
        this.expire(req.id);
        return;
      }
      if (this.state.screen === 'offline')
        this.set({ screen: cardScreen(this.state.request), peerPresent: true });
      return;
    }
    if (this.seenIDs.has(req.id) || this.expired(req)) {
      this.seenIDs.add(req.id);
      return;
    }
    // Only completed/expired IDs belong in the closed-request set. Merely
    // seeing a card must not suppress an authenticated re-announcement after
    // a stale roster snapshot was rejected by the sequence ledger.
    this.set({
      request: req,
      screen: cardScreen(req),
      agent: req.agent || this.state.agent,
      result: null,
      delivery: null,
      answerError: null,
      peerPresent: true,
    });
  }
  private matchesAck(a: Ack, d: Decision): boolean {
    return (
      a.room === this.state.roomID &&
      a.id === d.id &&
      a.request_hash === d.request_hash &&
      a.decision_hash === decisionHash(d)
    );
  }
  private async onAck(a: Ack): Promise<void> {
    const d = this.sentDecisions.get(a.id);
    if (
      !d ||
      !this.agentPublic ||
      !this.matchesAck(a, d) ||
      !(await verify(this.agentPublic, ackSigningMessage(a), a.sig)) ||
      this.closed
    )
      return;
    // An uncertain replay cannot overwrite a verified terminal receipt.
    const old = this.receipts.get(a.id);
    if (old?.status === 'accepted' || old?.status === 'expired') return;
    this.receipts.set(a.id, a);
    if (this.state.request?.id !== a.id) {
      this.set({});
      return;
    }
    if (a.status === 'accepted') {
      const approved = d.result.approved !== false;
      const detail =
        d.response_kind === 'yesno'
          ? approved
            ? 'Approved'
            : 'Declined'
          : d.response_kind === 'choice'
            ? `Choice: ${d.result.choice}`
            : `Reply: ${d.result.text ?? ''}`;
      this.set({
        screen: 'confirmed',
        request: null,
        delivery: null,
        result: {
          icon: approved ? '✓' : '✗',
          label: 'Answer received by agent',
          approved,
          detail,
        },
      });
      if (this.confirmedTimer) clearTimeout(this.confirmedTimer);
      this.confirmedTimer = setTimeout(() => {
        if (!this.closed && this.state.screen === 'confirmed')
          this.set({ screen: 'listening', result: null });
      }, 2600);
    } else
      this.set({
        screen: 'pending',
        delivery: a.status === 'expired' ? 'expired' : 'uncertain',
      });
  }
  private onPaired(
    key: Uint8Array,
    agentSigner: string,
    publicKey: CryptoKey,
  ): void {
    if (this.closed) return;
    this.agentPublic = publicKey;
    this.agentSigner = agentSigner;
    this.protocol = PROTOCOL;
    this.sessionKey = key;
    this.protocolReady = this.ledgerLoader(
      protocolScope(this.state.roomID, agentSigner, this.pinnedDeviceSigner!),
      false,
    )
      .then((ledger) => {
        this.ledger = ledger;
        if (this.closed) {
          void ledger.forget().catch(() => {});
          return;
        }
        this.canPersist = true;
        this.set({ paired: true, screen: 'listening', pairError: null });
      })
      .catch(() => {
        if (!this.closed) this.ledgerFailed();
      });
  }
  private onPairError(err: Error): void {
    if (this.closed) return;
    this.relay.close();
    this.set({
      screen: 'pair',
      pairError: err.message,
      peerPresent: false,
      paired: false,
    });
  }
  private set(patch: Partial<SessionState>): void {
    if (this.closed) return;
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }
}
function cardScreen(req: Request): Screen {
  return req.response.kind === 'choice'
    ? 'choice'
    : req.response.kind === 'text'
      ? 'text'
      : 'yesno';
}
