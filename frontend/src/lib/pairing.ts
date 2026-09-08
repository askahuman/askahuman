// pairing drives one SPAKE2 handshake as the phone (role B) against a scripted
// peer (the agent, role A), over the relay's app frames.
//
// Flow (task brief HANDSHAKE):
//   1. both connect to /ws?room; phone sends {pake: Start()}.
//   2. on peer {pake} -> Finish(peerMsg) -> send {confirm: confirmMsg}.
//   3. on peer {confirm} -> confirmPeer() must verify -> paired; sessionKey set.
//   4. thereafter both exchange {box:...}.
//
// This module is transport-agnostic: it takes send callbacks and emits state
// changes, so it is unit-testable with a scripted peer and no real WebSocket.

import { b64Decode, b64Encode } from './b64.ts';
import { Handshake } from './crypto.ts';
import {
  PROTOCOL,
  UPGRADE_MESSAGE,
  pairBinding,
  strictJSON,
  object,
  importSigner,
  canonicalBase64,
  type PairHello,
} from './protocol.ts';

/** PairingPhase is the handshake's progress. */
export type PairingPhase =
  | 'idle' // constructed, start() not yet called
  | 'awaiting_peer_pake' // we sent our pake, waiting for the peer's
  | 'awaiting_peer_confirm' // we finished + sent confirm, waiting for theirs
  | 'paired' // both confirmed; sessionKey is set
  | 'failed'; // peer message invalid or confirmation mismatch

/** PairingSend are the outbound frame senders the pairing needs. */
export interface PairingSend {
  sendPake(b64: string): boolean;
  sendConfirm(b64: string): boolean;
}

/** PairingEvents surface handshake transitions to the session/UI. */
export interface PairingEvents {
  onPhase?: (phase: PairingPhase) => void;
  /** onPaired delivers the 32-byte session key once both sides confirm. */
  onPaired?: (
    sessionKey: Uint8Array,
    agentSigner: string,
    publicKey: CryptoKey,
  ) => void;
  onError?: (err: Error) => void;
}

/**
 * Pairing wraps a role-B Handshake and tracks phase across relay events. It is
 * single-shot: construct, start(), feed peer frames, end at paired/failed.
 */
export class Pairing {
  private readonly hs: Handshake;
  private readonly send: PairingSend;
  private readonly events: PairingEvents;
  private phase: PairingPhase = 'idle';
  private session?: Uint8Array;
  private started = false;
  private finishing = false;
  private agentSigner = '';
  private agentPublic?: CryptoKey;
  private readonly identity?: { room: string; signer: string };
  // A peer confirm can race ahead of our finish; buffer it.
  private pendingConfirm?: Uint8Array;

  constructor(
    code: string,
    send: PairingSend,
    events: PairingEvents = {},
    identity?: { room: string; signer: string },
  ) {
    this.identity = identity;
    this.hs = Handshake.newB(code); // phone is always role B
    this.send = send;
    this.events = events;
  }

  /** currentPhase exposes the handshake phase. */
  currentPhase(): PairingPhase {
    return this.phase;
  }
  /** sessionKey returns the derived key once paired, else undefined. */
  sessionKey(): Uint8Array | undefined {
    return this.session;
  }

  /**
   * start samples our ephemeral and sends {pake}. Safe to call again after a
   * reconnect: it re-sends the SAME pake (the relay lost our buffered frame).
   */
  start(): void {
    if (this.phase === 'paired' || this.phase === 'failed') return;
    if (!this.identity) {
      this.fail(new Error(UPGRADE_MESSAGE));
      return;
    }
    const msg = this.started ? this.startSameMsg() : this.hs.start();
    this.started = true;
    this.cachedPake = msg;
    if (this.phase === 'idle') this.setPhase('awaiting_peer_pake');
    this.send.sendPake(
      b64Encode(
        new TextEncoder().encode(
          JSON.stringify({
            protocol: PROTOCOL,
            pake: b64Encode(msg),
            signer: this.identity.signer,
          } satisfies PairHello),
        ),
      ),
    );
  }

  private cachedPake?: Uint8Array;
  private startSameMsg(): Uint8Array {
    // Re-send the identical pake after a reconnect; never re-randomize mid-flow.
    return this.cachedPake ?? this.hs.start();
  }

  /** onPeerPake handles a peer {pake}: finish + send our confirm. */
  async onPeerPake(peerB64: string): Promise<void> {
    if (
      this.phase === 'paired' ||
      this.phase === 'failed' ||
      this.finishing ||
      this.session
    )
      return;
    this.finishing = true;
    try {
      if (!this.identity) throw new Error(UPGRADE_MESSAGE);
      const hello = object(strictJSON(b64Decode(peerB64)), [
        'protocol',
        'pake',
        'signer',
      ]);
      if (
        hello.protocol !== PROTOCOL ||
        !canonicalBase64(hello.pake, 32) ||
        typeof hello.signer !== 'string'
      )
        throw new Error(UPGRADE_MESSAGE);
      this.agentPublic = await importSigner(hello.signer);
      if (this.currentPhase() === 'failed') return;
      // A peer can speak first. Starting here also caches the exact outgoing
      // point before finishing, so later relay events cannot re-randomize it.
      if (!this.started) this.start();
      const res = this.hs.finish(
        b64Decode(hello.pake),
        pairBinding(this.identity.room, hello.signer, this.identity.signer),
      );
      this.agentSigner = hello.signer;
      this.session = res.sessionKey;
      this.setPhase('awaiting_peer_confirm');
      this.send.sendConfirm(b64Encode(res.confirm));
      if (this.pendingConfirm) {
        const buffered = this.pendingConfirm;
        this.pendingConfirm = undefined;
        this.verifyConfirm(buffered);
      }
    } catch (e) {
      this.fail(
        new Error(
          `Pairing failed. ${UPGRADE_MESSAGE} (${(e as Error).message})`,
        ),
      );
    } finally {
      this.finishing = false;
    }
  }

  /** onPeerConfirm handles a peer {confirm}: verify -> paired. */
  onPeerConfirm(peerB64: string): void {
    if (this.phase === 'paired' || this.phase === 'failed') return;
    let confirm: Uint8Array;
    try {
      confirm = b64Decode(peerB64);
    } catch {
      this.fail(new Error('pairing: bad confirm base64'));
      return;
    }
    // finish() may not have run yet (peer confirm raced our pake handling).
    if (this.phase !== 'awaiting_peer_confirm' || !this.session) {
      this.pendingConfirm = confirm;
      return;
    }
    this.verifyConfirm(confirm);
  }

  private verifyConfirm(confirm: Uint8Array): void {
    let ok: boolean;
    try {
      ok = this.hs.confirmPeer(confirm); // constant-time HMAC compare
    } catch (e) {
      this.fail(new Error(`pairing: confirmPeer: ${(e as Error).message}`));
      return;
    }
    if (!ok) {
      this.fail(
        new Error('pairing: confirmation mismatch (wrong code or MITM)'),
      );
      return;
    }
    this.setPhase('paired');
    if (this.session && this.agentPublic)
      this.events.onPaired?.(this.session, this.agentSigner, this.agentPublic);
  }

  private fail(err: Error): void {
    this.setPhase('failed');
    this.events.onError?.(err);
  }

  private setPhase(p: PairingPhase): void {
    if (this.phase === p) return;
    this.phase = p;
    this.events.onPhase?.(p);
  }
}
