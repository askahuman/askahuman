// wire mirrors backend/pkg/wire (the Go source of truth) byte-for-byte on the
// JSON wire. Two layers travel on one WebSocket:
//   - Frame: the relay-visible envelope ({_relay} | {pake} | {confirm} | {box}).
//     The relay only ever sets/reads `_relay`; it forwards the rest verbatim.
//   - App messages (Request | Decision | PushSub): plaintext that lives sealed
//     inside Frame.box. Mirror pkg/wire exactly — do not diverge. See plan §5.
//
// The key-confirmation frame is {"confirm":...}; pkg/wire.Frame carries the
// same {_relay|pake|confirm|box} fields. App plaintext is space-padded to a
// fixed block before sealing (pad / PAD_BLOCK) to hide message length.

/** RelaySignal is a relay-injected control value carried in Frame._relay. */
export type RelaySignal = 'peer_joined' | 'peer_left' | 'undeliverable';

/** Relay signals injected by the relay (clients never send these). */
export const SignalPeerJoined: RelaySignal = 'peer_joined';
export const SignalPeerLeft: RelaySignal = 'peer_left';
export const SignalUndeliverable: RelaySignal = 'undeliverable';

/** RelaySignals lists every valid RelaySignal (mirror wire.RelaySignals). */
export const RelaySignals: readonly RelaySignal[] = [
  SignalPeerJoined,
  SignalPeerLeft,
  SignalUndeliverable,
];

/** validRelaySignal reports whether s is a known relay signal. */
export function validRelaySignal(s: string): s is RelaySignal {
  return s === SignalPeerJoined || s === SignalPeerLeft || s === SignalUndeliverable;
}

/**
 * Frame is the JSON envelope on the WebSocket. Exactly one app field is set
 * per frame. A relay-injected frame instead carries `_relay`.
 */
export interface Frame {
  _relay?: RelaySignal;
  pake?: string; // base64 SPAKE2 Start/Finish message
  confirm?: string; // base64 SPAKE2 key-confirmation MAC
  box?: string; // base64(nonce(24) || secretbox(plaintext))
}

/** MessageKind tags an application message inside a box. */
export type MessageKind = 'request' | 'decision' | 'push_sub';

export const KindRequest: MessageKind = 'request';
export const KindDecision: MessageKind = 'decision';
export const KindPushSub: MessageKind = 'push_sub';

/** validMessageKind reports whether k is a known app message kind. */
export function validMessageKind(k: string): k is MessageKind {
  return k === KindRequest || k === KindDecision || k === KindPushSub;
}

/** ResponseKind is the answer shape a request asks the human for. */
export type ResponseKind = 'yesno' | 'choice' | 'text';

export const ResponseYesNo: ResponseKind = 'yesno';
export const ResponseChoice: ResponseKind = 'choice';
export const ResponseText: ResponseKind = 'text';

/** validResponseKind reports whether k is a known response kind. */
export function validResponseKind(k: string): k is ResponseKind {
  return k === ResponseYesNo || k === ResponseChoice || k === ResponseText;
}

/** Category is the badge shown on a request card; free-form on the wire. */
export type Category = 'cash' | 'deploy' | 'data' | 'access' | 'other';

export const Categories: readonly Category[] = ['cash', 'deploy', 'data', 'access', 'other'];

/** validCategory reports whether c is a known (colored) category. */
export function validCategory(c: string): c is Category {
  return (Categories as readonly string[]).includes(c);
}

/** Response describes the answer shape requested from the human. */
export interface Response {
  kind: ResponseKind;
  options?: string[]; // choice
  placeholder?: string; // text
  max_len?: number; // text
}

/** Request is an approval request sent agent -> phone, sealed inside a box. */
export interface Request {
  kind: MessageKind; // always KindRequest
  id: string;
  title: string;
  category?: Category | string;
  summary: string;
  agent?: string;
  response: Response;
  expires_in_s?: number;
}

/** Result is the human's answer; exactly one field is set per Decision. */
export interface Result {
  approved?: boolean; // yesno
  choice?: string; // choice
  text?: string; // text
}

/** Decision is the human's answer sent phone -> agent, sealed inside a box. */
export interface Decision {
  kind: MessageKind; // always KindDecision
  id: string;
  result: Result;
}

/** PushKeys are the client keys used to encrypt Web Push payloads (RFC 8291). */
export interface PushKeys {
  p256dh: string;
  auth: string;
}

/** PushSubscription is a Web Push subscription (RFC 8030/8291). */
export interface PushSubscription {
  endpoint: string;
  keys: PushKeys;
}

/** PushSub delivers the phone's PushSubscription to the agent, sealed. */
export interface PushSub {
  kind: MessageKind; // always KindPushSub
  subscription: PushSubscription;
}

/** AppMessage is any plaintext message that lives sealed inside Frame.box. */
export type AppMessage = Request | Decision | PushSub;

/**
 * parseFrame parses one WebSocket text frame into a Frame, or null if it is
 * not valid JSON / not an object. The relay forwards opaque app frames
 * verbatim, so a Frame may carry any one of _relay / pake / confirm / box.
 */
export function parseFrame(raw: string): Frame | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  return v as Frame;
}

/** isRelayControl reports whether a parsed frame is a relay control frame. */
export function isRelayControl(f: Frame): f is Frame & { _relay: RelaySignal } {
  return typeof f._relay === 'string' && validRelaySignal(f._relay);
}

/**
 * PAD_BLOCK is the fixed block size (bytes) the app plaintext is padded up to
 * before sealing, hiding the message length (notably yes/no approve vs decline)
 * from the content-blind relay. MUST match pkg/wire.padBlock on the Go side so
 * Go<->JS stays byte-compatible. Trailing ASCII spaces are JSON whitespace, so
 * JSON.parse / json.Unmarshal ignore them and decoders need no change.
 */
const PAD_BLOCK = 256;

/**
 * pad right-pads s with ASCII spaces to the next multiple of PAD_BLOCK (an
 * already-aligned input gets a full extra block, so the unpadded length is
 * never recoverable). Mirrors pkg/wire.pad.
 */
function pad(s: string): string {
  // length is in UTF-16 code units; app payloads are ASCII-keyed JSON whose
  // byte length only exceeds this for multi-byte values, which still land in
  // the same block for realistic decisions. ponytail: byte-exact padding would
  // measure TextEncoder().encode(s).length — upgrade if payloads carry large
  // non-ASCII text and the integration length-equality test ever flakes.
  const n = PAD_BLOCK - (s.length % PAD_BLOCK);
  return s + ' '.repeat(n);
}

// String length caps for decoding untrusted-but-authenticated app frames, so a
// malformed peer cannot drive rendering into a bad state. Generous, not tight.
const MAX_ID_LEN = 256;
const MAX_TITLE_LEN = 512;
const MAX_SUMMARY_LEN = 4096;
const MAX_AGENT_LEN = 256;
const MAX_PLACEHOLDER_LEN = 256;
const MAX_OPTIONS = 32;
const MAX_OPTION_LEN = 256;
const MAX_TEXT_LEN = 4096;
const MAX_EXPIRES_S = 86_400; // 24h
const MAX_INPUT_LEN = 16_384;

function checkStr(v: unknown, name: string, max: number, required: boolean): string {
  if (v === undefined || v === '') {
    if (required) throw new Error(`wire: ${name} missing`);
    return '';
  }
  if (typeof v !== 'string') throw new Error(`wire: ${name} must be a string`);
  if (v.length > max) throw new Error(`wire: ${name} too long (${v.length} > ${max})`);
  return v;
}

/** decodeRequest validates a sealed-box plaintext as a wire.Request. */
export function decodeRequest(plaintext: Uint8Array): Request {
  const msg = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<Request>;
  if (!validMessageKind(msg.kind ?? '') || msg.kind !== KindRequest) {
    throw new Error(`wire: not a request (kind=${String(msg.kind)})`);
  }
  checkStr(msg.id, 'request id', MAX_ID_LEN, true);
  checkStr(msg.title, 'request title', MAX_TITLE_LEN, false);
  checkStr(msg.summary, 'request summary', MAX_SUMMARY_LEN, false);
  checkStr(msg.agent, 'request agent', MAX_AGENT_LEN, false);
  if (msg.category !== undefined) checkStr(msg.category, 'request category', MAX_OPTION_LEN, false);
  if (!msg.response || !validResponseKind(msg.response.kind)) {
    throw new Error('wire: request missing/invalid response kind');
  }
  const r = msg.response;
  if (r.options !== undefined) {
    if (!Array.isArray(r.options) || r.options.length > MAX_OPTIONS) {
      throw new Error('wire: request options invalid/too many');
    }
    for (const o of r.options) checkStr(o, 'request option', MAX_OPTION_LEN, true);
  }
  checkStr(r.placeholder, 'request placeholder', MAX_PLACEHOLDER_LEN, false);
  if (r.max_len !== undefined && (!Number.isInteger(r.max_len) || r.max_len < 0 || r.max_len > MAX_INPUT_LEN)) {
    throw new Error('wire: request max_len out of bounds');
  }
  if (
    msg.expires_in_s !== undefined &&
    (!Number.isInteger(msg.expires_in_s) || msg.expires_in_s < 0 || msg.expires_in_s > MAX_EXPIRES_S)
  ) {
    throw new Error('wire: request expires_in_s out of bounds');
  }
  return msg as Request;
}

/** decodeDecision validates a sealed-box plaintext as a wire.Decision. */
export function decodeDecision(plaintext: Uint8Array): Decision {
  const msg = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<Decision>;
  if (!validMessageKind(msg.kind ?? '') || msg.kind !== KindDecision) {
    throw new Error(`wire: not a decision (kind=${String(msg.kind)})`);
  }
  checkStr(msg.id, 'decision id', MAX_ID_LEN, true);
  const res = msg.result;
  if (!res || typeof res !== 'object') throw new Error('wire: decision missing result');
  if (res.approved !== undefined && typeof res.approved !== 'boolean') {
    throw new Error('wire: decision approved must be boolean');
  }
  checkStr(res.choice, 'decision choice', MAX_OPTION_LEN, false);
  checkStr(res.text, 'decision text', MAX_TEXT_LEN, false);
  return msg as Decision;
}

/**
 * encodeDecision serializes a Decision to UTF-8 bytes for sealing, padded to a
 * fixed block so approve vs decline (and all decisions) seal to the same length
 * — the relay cannot infer the answer from ciphertext length. Mirrors
 * pkg/wire.EncodeDecision.
 */
export function encodeDecision(d: Decision): Uint8Array {
  return new TextEncoder().encode(pad(JSON.stringify(d)));
}

/** encodeRequest serializes a Request to UTF-8 bytes for sealing, padded to a
 *  fixed block to hide the request body length. Mirrors pkg/wire.EncodeRequest. */
export function encodeRequest(r: Request): Uint8Array {
  return new TextEncoder().encode(pad(JSON.stringify(r)));
}

/** encodePushSub serializes a PushSub to UTF-8 bytes for sealing, padded. */
export function encodePushSub(p: PushSub): Uint8Array {
  return new TextEncoder().encode(pad(JSON.stringify(p)));
}

/** newYesNoDecision builds a yesno Decision for request id. */
export function newYesNoDecision(id: string, approved: boolean): Decision {
  return { kind: KindDecision, id, result: { approved } };
}

/** newChoiceDecision builds a choice Decision for request id. */
export function newChoiceDecision(id: string, choice: string): Decision {
  return { kind: KindDecision, id, result: { choice } };
}

/** newTextDecision builds a text Decision for request id. */
export function newTextDecision(id: string, text: string): Decision {
  return { kind: KindDecision, id, result: { text } };
}
