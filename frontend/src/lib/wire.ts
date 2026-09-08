import {
  strictJSON,
  validateRequest,
  validateDecision,
  MAX_PLAINTEXT,
} from "./protocol.ts";
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
export type RelaySignal = "peer_joined" | "peer_left" | "undeliverable";

/** Relay signals injected by the relay (clients never send these). */
export const SignalPeerJoined: RelaySignal = "peer_joined";
export const SignalPeerLeft: RelaySignal = "peer_left";
export const SignalUndeliverable: RelaySignal = "undeliverable";

/** RelaySignals lists every valid RelaySignal (mirror wire.RelaySignals). */
export const RelaySignals: readonly RelaySignal[] = [
  SignalPeerJoined,
  SignalPeerLeft,
  SignalUndeliverable,
];

/** validRelaySignal reports whether s is a known relay signal. */
export function validRelaySignal(s: string): s is RelaySignal {
  return (
    s === SignalPeerJoined || s === SignalPeerLeft || s === SignalUndeliverable
  );
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
export type MessageKind =
  "request" | "decision" | "push_sub" | "vapid_key" | "device_key" | "ack";

export const KindRequest: MessageKind = "request";
export const KindDecision: MessageKind = "decision";
export const KindPushSub: MessageKind = "push_sub";
export const KindVAPIDKey: MessageKind = "vapid_key";
export const KindDeviceKey: MessageKind = "device_key";

/** validMessageKind reports whether k is a known app message kind. */
export function validMessageKind(k: string): k is MessageKind {
  return (
    k === KindRequest ||
    k === KindDecision ||
    k === KindPushSub ||
    k === KindVAPIDKey ||
    k === KindDeviceKey ||
    k === "ack"
  );
}

/** ResponseKind is the answer shape a request asks the human for. */
export type ResponseKind = "yesno" | "choice" | "text";

export const ResponseYesNo: ResponseKind = "yesno";
export const ResponseChoice: ResponseKind = "choice";
export const ResponseText: ResponseKind = "text";

/** validResponseKind reports whether k is a known response kind. */
export function validResponseKind(k: string): k is ResponseKind {
  return k === ResponseYesNo || k === ResponseChoice || k === ResponseText;
}

/** Category is the badge shown on a request card; free-form on the wire. */
export type Category = "cash" | "deploy" | "data" | "access" | "other";

export const Categories: readonly Category[] = [
  "cash",
  "deploy",
  "data",
  "access",
  "other",
];

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
  protocol?: number;
  room?: string;
  deadline_ms?: number;
  sig?: string;
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
  protocol?: number;
  room?: string;
  request_hash?: string;
  response_kind?: ResponseKind;
  kind: MessageKind; // always KindDecision
  id: string;
  result: Result;
  // Mandatory at the agent acceptance boundary. The codec can also represent
  // unsigned legacy/negative fixtures, which never establish authorization.
  sig?: string;
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
  protocol?: number;
  room?: string;
  sig?: string;
  kind: MessageKind; // always KindPushSub
  subscription: PushSubscription;
}

/**
 * VapidKey delivers the agent's VAPID public key to the phone, sealed, so the
 * phone subscribes for Web Push with exactly the key the agent signs wake-up
 * pushes with (signer == subscribe-key). Only the PUBLIC key crosses the wire.
 */
export interface VapidKey {
  protocol?: number;
  room?: string;
  sig?: string;
  kind: MessageKind; // always KindVAPIDKey
  public_key: string;
}

/**
 * DeviceKey delivers the phone's per-device ECDSA P-256 PUBLIC key to the agent,
 * sealed. The phone signs every Decision with the matching non-extractable
 * private key (WebCrypto, IndexedDB) so a stolen session key cannot forge an
 * approval. Only the PUBLIC key (SPKI, base64) crosses the wire. Mirrors
 * wire.DeviceKey.
 */
export interface DeviceKey {
  kind: MessageKind; // always KindDeviceKey
  public_key: string;
}

/** AppMessage is any plaintext message that lives sealed inside Frame.box. */
export type AppMessage = Request | Decision | PushSub | VapidKey | DeviceKey;

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
  if (typeof v !== "object" || v === null) return null;
  return v as Frame;
}

/** isRelayControl reports whether a parsed frame is a relay control frame. */
export function isRelayControl(f: Frame): f is Frame & { _relay: RelaySignal } {
  return typeof f._relay === "string" && validRelaySignal(f._relay);
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
  const length = new TextEncoder().encode(s).length;
  const n = PAD_BLOCK - (length % PAD_BLOCK);
  if (length + n > MAX_PLAINTEXT)
    throw new Error("wire: encoded message exceeds 16 KiB");
  return s + " ".repeat(n);
}

const MAX_VAPID_KEY_LEN = 256; // base64url uncompressed P-256 is ~88 chars
const MAX_DEVICE_KEY_LEN = 512; // base64 SPKI DER for P-256 is ~120 chars

function checkStr(
  v: unknown,
  name: string,
  max: number,
  required: boolean,
): string {
  if (v === undefined || v === "") {
    if (required) throw new Error(`wire: ${name} missing`);
    return "";
  }
  if (typeof v !== "string") throw new Error(`wire: ${name} must be a string`);
  if (v.length > max)
    throw new Error(`wire: ${name} too long (${v.length} > ${max})`);
  return v;
}

/** decodeRequest validates a sealed-box plaintext as a wire.Request. */
export function decodeRequest(plaintext: Uint8Array): Request {
  const msg = strictJSON(plaintext) as Request;
  validateRequest(msg);
  return msg;
}

/** decodeDecision validates a sealed-box plaintext as a wire.Decision. */
export function decodeDecision(plaintext: Uint8Array): Decision {
  const msg = strictJSON(plaintext) as Decision;
  validateDecision(msg);
  return msg;
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

/** decodeVapidKey validates a sealed-box plaintext as a wire.VapidKey. */
export function decodeVapidKey(plaintext: Uint8Array): VapidKey {
  const msg = JSON.parse(
    new TextDecoder().decode(plaintext),
  ) as Partial<VapidKey>;
  if (!validMessageKind(msg.kind ?? "") || msg.kind !== KindVAPIDKey) {
    throw new Error(`wire: not a vapid_key (kind=${String(msg.kind)})`);
  }
  checkStr(msg.public_key, "vapid_key public_key", MAX_VAPID_KEY_LEN, true);
  return msg as VapidKey;
}

/** encodeVapidKey serializes a VapidKey to UTF-8 bytes for sealing, padded. */
export function encodeVapidKey(publicKey: string): Uint8Array {
  const v: VapidKey = { kind: KindVAPIDKey, public_key: publicKey };
  return new TextEncoder().encode(pad(JSON.stringify(v)));
}

/** decodeDeviceKey validates a sealed-box plaintext as a wire.DeviceKey. */
export function decodeDeviceKey(plaintext: Uint8Array): DeviceKey {
  const msg = JSON.parse(
    new TextDecoder().decode(plaintext),
  ) as Partial<DeviceKey>;
  if (!validMessageKind(msg.kind ?? "") || msg.kind !== KindDeviceKey) {
    throw new Error(`wire: not a device_key (kind=${String(msg.kind)})`);
  }
  checkStr(msg.public_key, "device_key public_key", MAX_DEVICE_KEY_LEN, true);
  return msg as DeviceKey;
}

/** encodeDeviceKey serializes a DeviceKey to UTF-8 bytes for sealing, padded to
 *  a fixed block so its length does not leak. Mirrors encodeVapidKey. */
export function encodeDeviceKey(spkiB64: string): Uint8Array {
  const v: DeviceKey = { kind: KindDeviceKey, public_key: spkiB64 };
  return new TextEncoder().encode(pad(JSON.stringify(v)));
}

/**
 * decisionSigningMessage builds the canonical byte string the phone signs and
 * the agent verifies for one decision. It is a cross-language contract: the Go
 * twin wire.DecisionSigningMessage MUST produce byte-identical output (both are
 * pinned to the same hex in their wire tests). The message binds the room, the
 * request id, and the exact result so a signature cannot be replayed across
 * rooms, requests, or answers. Layout (no trailing separator):
 *
 *   UTF8("aah:decision:v1" 0x00 roomID 0x00 id 0x00 resultTag(result))
 *
 * resultTag picks the branch by which Result field is set, in the fixed priority
 * order approved (yesno) -> choice -> text. See ADR 0021.
 */
export function decisionSigningMessage(
  roomID: string,
  id: string,
  result: Result,
): Uint8Array<ArrayBuffer> {
  const msg = `aah:decision:v1\x00${roomID}\x00${id}\x00${resultTag(result)}`;
  return new TextEncoder().encode(msg);
}

/** resultTag renders a Result as the canonical tag used by
 *  decisionSigningMessage, matching the Go twin exactly. */
function resultTag(result: Result): string {
  if (result.approved !== undefined)
    return `yesno:${result.approved ? "1" : "0"}`;
  if (result.choice) return `choice:${result.choice}`;
  return `text:${result.text ?? ""}`;
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
