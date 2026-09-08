import type { ProtocolLedgerLoader } from '../src/lib/protocol-state.ts';
// Scripted v2 peer for tests. Uses real P-256/WebCrypto, PAKE, and secretbox;
// nothing repairs malformed frames or bypasses production signature checks.
import { expect } from 'vitest';
import { Handshake, seal, open } from '../src/lib/crypto.ts';
import { b64Decode, b64Encode } from '../src/lib/b64.ts';
import { signMessage, type DeviceKey } from '../src/lib/devicekey.ts';
import { type Request, type Decision, encodeRequest } from '../src/lib/wire.ts';
import {
  PROTOCOL,
  pairBinding,
  strictJSON,
  requestSigningMessage,
  boundDecisionSigningMessage,
  decisionHash,
  ackSigningMessage,
  vapidSigningMessage,
  importSigner,
  verify,
  type Ack,
} from '../src/lib/protocol.ts';

// In-memory fixture for isolated Session tests. Real atomic IndexedDB behavior
// is exercised separately in the actual multi-page browser protocol harness.
const ledgerStates = new Map<
  string,
  { request: number; digest: string; push: number }
>();
export const protocolLedgerLoader: ProtocolLedgerLoader = async (
  scope,
  restored,
) => {
  if (!ledgerStates.has(scope)) {
    if (restored) throw new Error('missing ledger');
    ledgerStates.set(scope, { request: 0, digest: '', push: 0 });
  }
  const read = () => {
    const s = ledgerStates.get(scope);
    if (!s) throw new Error('forgotten');
    return s;
  };
  return {
    observeRequest: async (seq, digest) => {
      const s = read();
      if (seq < s.request || (seq === s.request && digest !== s.digest))
        return false;
      s.request = seq;
      s.digest = digest;
      return true;
    },
    currentRequest: async (seq, digest) => {
      const s = read();
      return s.request === seq && s.digest === digest;
    },
    nextPush: async () => {
      const s = read();
      if (s.push >= Number.MAX_SAFE_INTEGER) throw new Error('exhausted');
      return ++s.push;
    },
    currentPush: async (seq) => read().push === seq,
    forget: async () => {
      ledgerStates.delete(scope);
    },
  };
};
export interface TestSigner extends DeviceKey {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}
export async function makeSigner(): Promise<TestSigner> {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  );
  const spkiB64 = b64Encode(
    new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey)),
  );
  return {
    spkiB64,
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    sign: (msg) => signMessage(kp.privateKey, msg),
  };
}
let device: Promise<TestSigner> | undefined;
export const deviceKeyLoader = (): Promise<TestSigner> =>
  (device ??= makeSigner());
export async function until(predicate: () => unknown): Promise<void> {
  await expect.poll(predicate, { timeout: 3000, interval: 2 }).toBeTruthy();
}
export async function settle(): Promise<void> {
  for (let n = 0; n < 8; n++) await new Promise((r) => setTimeout(r, 1));
}
export interface ScriptedSocket {
  sent: Record<string, unknown>[];
  open(): void;
  recv(frame: Record<string, unknown>): void;
}
export interface TestPeer {
  signer: TestSigner;
  phone: CryptoKey;
  room: string;
  key: Uint8Array;
  requestSeq: number;
  requestIDs: Map<string, number>;
}
const peers = new Map<string, TestPeer>();
export function peerFor(key: Uint8Array): TestPeer {
  const p = peers.get(b64Encode(key));
  if (!p) throw new Error('unknown test peer');
  return p;
}
export async function pairAgent<T extends ScriptedSocket>(
  getWS: () => T | undefined | null,
  code: string,
  room: string,
): Promise<{ ws: T; agentKey: Uint8Array; peer: TestPeer }> {
  const signer = await makeSigner();
  await until(() => getWS());
  const ws = getWS()!;
  ws.open();
  ws.recv({ _relay: 'peer_joined' });
  await until(() => ws.sent.some((f) => typeof f.pake === 'string'));
  const hello = strictJSON(
    b64Decode(ws.sent.find((f) => typeof f.pake === 'string')!.pake as string),
  ) as { protocol: number; pake: string; signer: string };
  expect(hello.protocol).toBe(PROTOCOL);
  const phone = await importSigner(hello.signer);
  const agent = Handshake.newA(code),
    point = agent.start();
  const result = agent.finish(
    b64Decode(hello.pake),
    pairBinding(room, signer.spkiB64, hello.signer),
  );
  ws.recv({
    pake: b64Encode(
      new TextEncoder().encode(
        JSON.stringify({
          protocol: PROTOCOL,
          pake: b64Encode(point),
          signer: signer.spkiB64,
        }),
      ),
    ),
  });
  await until(() => ws.sent.some((f) => typeof f.confirm === 'string'));
  expect(
    agent.confirmPeer(
      b64Decode(
        ws.sent.find((f) => typeof f.confirm === 'string')!.confirm as string,
      ),
    ),
  ).toBe(true);
  const peer = {
    signer,
    phone,
    room,
    key: result.sessionKey,
    requestSeq: 0,
    requestIDs: new Map<string, number>(),
  };
  peers.set(b64Encode(peer.key), peer);
  ws.recv({ confirm: b64Encode(result.confirm) });
  return { ws, agentKey: peer.key, peer };
}
export async function signRequest(
  key: Uint8Array,
  r: Request,
): Promise<Request> {
  const p = peerFor(key);
  if (r.request_seq === undefined) {
    r.request_seq = p.requestIDs.get(r.id) ?? ++p.requestSeq;
    p.requestIDs.set(r.id, r.request_seq);
  }
  Object.assign(r, {
    protocol: PROTOCOL,
    room: p.room,
    deadline_ms:
      r.deadline_ms ??
      (r.expires_in_s ? Date.now() + r.expires_in_s * 1000 : 0),
  });
  r.sig = await p.signer.sign(requestSigningMessage(r));
  return r;
}
export async function sealReq(
  key: Uint8Array,
  r: Request,
): Promise<Record<string, unknown>> {
  return { box: seal(key, encodeRequest(await signRequest(key, r))) };
}
export async function sendReq(
  ws: ScriptedSocket,
  key: Uint8Array,
  r: Request,
): Promise<void> {
  ws.recv(await sealReq(key, r));
  await settle();
}
export function decisions(ws: ScriptedSocket, key: Uint8Array): Decision[] {
  return ws.sent
    .filter((f) => typeof f.box === 'string')
    .flatMap((f) => {
      try {
        const d = strictJSON(open(key, f.box as string)) as Decision;
        return d.kind === 'decision' ? [d] : [];
      } catch {
        return [];
      }
    });
}
export async function acknowledge(
  ws: ScriptedSocket,
  key: Uint8Array,
  status: Ack['status'] = 'accepted',
  decision?: Decision,
): Promise<Decision> {
  await until(() => decisions(ws, key).length);
  const d = decision ?? decisions(ws, key).at(-1)!;
  const p = peerFor(key);
  expect(await verify(p.phone, boundDecisionSigningMessage(d), d.sig)).toBe(
    true,
  );
  const ack: Ack = {
    kind: 'ack',
    protocol: PROTOCOL,
    room: p.room,
    id: d.id,
    request_hash: d.request_hash!,
    decision_hash: decisionHash(d),
    status,
    sig: '',
  };
  ack.sig = await p.signer.sign(ackSigningMessage(ack));
  ws.recv({ box: seal(key, new TextEncoder().encode(JSON.stringify(ack))) });
  await settle();
  return d;
}
export async function sendVapid(
  ws: ScriptedSocket,
  key: Uint8Array,
  publicKey: string,
): Promise<void> {
  const p = peerFor(key),
    v = {
      kind: 'vapid_key' as const,
      protocol: PROTOCOL,
      room: p.room,
      public_key: publicKey,
      sig: '',
    };
  v.sig = await p.signer.sign(vapidSigningMessage(v));
  ws.recv({ box: seal(key, new TextEncoder().encode(JSON.stringify(v))) });
  await settle();
}
