// SPAKE2-over-ristretto255 pairing + secretbox app traffic for the PWA.
//
// This is the JS half of the cross-language crypto contract. It must produce
// byte-identical M, N, w, T, S, K, sessionKey and confirmation MACs to the Go
// backend (backend/pkg/spake2 + backend/pkg/sealedbox), and its secretbox must
// round-trip with Go's golang.org/x/crypto/nacl/secretbox. The contract is
// frozen by backend/cmd/spake2vectors and asserted by
// frontend/test/spake2-interop.mjs.
//
// Construction (see docs/decisions/architecture/0002):
//   M = map(SHA-512("ask-a-human:spake2:M")); N = map(":N")
//   w = reduce_mod_l(SHA-512(code_utf8))                          (64 LE bytes)
//   A (agent, uses M): T = x*G + w*M ; B (phone, uses N): S = y*G + w*N
//   K_A = x*(S - w*N) ; K_B = y*(T - w*M)
//   TT = len-prefixed(idA, idB, S, T, K, w) with 8-byte big-endian lengths
//   sessionKey = HKDF-SHA256(ikm=SHA256(TT), salt="", info="...:session-key")
//   confirmA = HMAC-SHA256(HKDF(..,"...:kc:A"), TT); confirmB likewise with kc:B
//   app traffic = base64(nonce(24) || secretbox(plaintext)) keyed by sessionKey

import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import nacl from 'tweetnacl';

type RPoint = InstanceType<typeof ristretto255.Point>;

const Point = ristretto255.Point;
// l = order of the ristretto255 scalar field (== ed25519 group order).
const L: bigint = Point.Fn.ORDER;

// Domain-separation labels. Part of the wire contract; must match Go byte-for-byte.
const SEED_M = 'ask-a-human:spake2:M';
const SEED_N = 'ask-a-human:spake2:N';
const ID_A = 'ask-a-human:agent';
const ID_B = 'ask-a-human:phone';
const INFO_SESSION = 'ask-a-human:session-key';
const INFO_KC_A = 'ask-a-human:kc:A';
const INFO_KC_B = 'ask-a-human:kc:B';

/** KEY_SIZE is the derived session key length in bytes. */
export const KEY_SIZE = 32;
/** NONCE_SIZE is the secretbox nonce length in bytes. */
export const NONCE_SIZE = 24;
/** MSG_SIZE is the wire length of a SPAKE2 message. */
export const MSG_SIZE = 32;

/** Role selects the blinding point and confirmation key for a peer. */
export type Role = 'A' | 'B';

const te = new TextEncoder();
const utf8 = (s: string): Uint8Array => te.encode(s);

// deriveToCurve is typed optional on H2CHasherBase but is always present for
// ristretto255 (RFC 9496 element derivation). Bind it once with a guard.
if (!ristretto255_hasher.deriveToCurve) {
  throw new Error('crypto: ristretto255 deriveToCurve unavailable');
}
const deriveToCurve: NonNullable<typeof ristretto255_hasher.deriveToCurve> =
  ristretto255_hasher.deriveToCurve;

function mapPoint(seed: string): RPoint {
  // SHA-512 -> 64 uniform bytes -> RFC 9496 element derivation (== Go
  // ristretto255.Element.FromUniformBytes).
  return deriveToCurve(sha512(utf8(seed)));
}

/** scalarFromUniform reduces 64 little-endian bytes mod l (== Go Scalar.SetUniformBytes). */
function scalarFromUniform(bytes64: Uint8Array): bigint {
  if (bytes64.length !== 64) throw new Error('crypto: uniform seed must be 64 bytes');
  let n = 0n;
  for (let i = bytes64.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes64[i]!);
  return n % L;
}

/** scalarToBytes encodes a scalar to 32 little-endian bytes (== ristretto255 Scalar.Bytes). */
function scalarToBytes(s: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let n = ((s % L) + L) % L;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** passwordScalar derives w = reduce(SHA-512(code_utf8)) mod l. */
export function passwordScalar(code: string): bigint {
  return scalarFromUniform(sha512(utf8(code)));
}

/** mPoint / nPoint expose the fixed points (32-byte encodings) for vector checks. */
export function mPoint(): Uint8Array {
  return mapPoint(SEED_M).toBytes();
}
export function nPoint(): Uint8Array {
  return mapPoint(SEED_N).toBytes();
}

function lenPrefixed(fields: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const f of fields) total += 8 + f.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let off = 0;
  for (const f of fields) {
    view.setBigUint64(off, BigInt(f.length), false); // big-endian
    off += 8;
    out.set(f, off);
    off += f.length;
  }
  return out;
}

/** Handshake runs one side of SPAKE2. Use newA (agent) or newB (phone). */
export class Handshake {
  readonly role: Role;
  private readonly w: bigint;
  private readonly mine: RPoint; // M for A, N for B
  private readonly peer: RPoint; // N for A, M for B

  private x?: bigint; // own ephemeral secret
  private msg?: RPoint; // own outgoing element (T for A, S for B)
  private sharedKBytes?: Uint8Array;
  private transcript?: Uint8Array;
  private confirmKeySelf?: Uint8Array;
  private confirmKeyPeer?: Uint8Array;
  private session?: Uint8Array;

  private constructor(role: Role, code: string) {
    this.role = role;
    this.w = passwordScalar(code);
    const M = mapPoint(SEED_M);
    const N = mapPoint(SEED_N);
    if (role === 'A') {
      this.mine = M;
      this.peer = N;
    } else {
      this.mine = N;
      this.peer = M;
    }
  }

  static newA(code: string): Handshake {
    return new Handshake('A', code);
  }
  static newB(code: string): Handshake {
    return new Handshake('B', code);
  }

  /** start samples a fresh ephemeral secret and returns this side's 32-byte message. */
  start(): Uint8Array {
    const seed = new Uint8Array(64);
    crypto.getRandomValues(seed);
    return this.startWith(scalarFromUniform(seed));
  }

  /**
   * startDeterministic derives the ephemeral scalar from a 64-byte uniform seed,
   * for known-answer vectors and tests only. Production code must use start().
   */
  startDeterministic(seed64: Uint8Array): Uint8Array {
    return this.startWith(scalarFromUniform(seed64));
  }

  private startWith(x: bigint): Uint8Array {
    this.x = x;
    // msg = x*G + w*mine. multiplyUnsafe accepts a (possibly 0) public scalar.
    const xG = Point.BASE.multiplyUnsafe(x);
    const wMine = this.mine.multiplyUnsafe(this.w);
    this.msg = xG.add(wMine);
    return this.msg.toBytes();
  }

  /**
   * finish consumes the peer's 32-byte message and returns
   * { sessionKey, confirm }. Send confirm to the peer; verify theirs with
   * confirmPeer before trusting the key.
   */
  finish(peerMsg: Uint8Array): { sessionKey: Uint8Array; confirm: Uint8Array } {
    if (!this.msg || this.x === undefined) throw new Error('spake2: start not called');
    const peerEl = Point.fromBytes(peerMsg); // canonical decode; throws if invalid

    // K = x*(peerMsg - w*peer).
    const wPeer = this.peer.multiplyUnsafe(this.w);
    const unblinded = peerEl.subtract(wPeer);
    const k = unblinded.multiplyUnsafe(this.x);
    this.sharedKBytes = k.toBytes();

    // Canonical transcript order: A's S then T, regardless of role.
    const myBytes = this.msg.toBytes();
    const peerBytes = peerEl.toBytes();
    const sBytes = this.role === 'A' ? peerBytes : myBytes;
    const tBytes = this.role === 'A' ? myBytes : peerBytes;

    this.transcript = lenPrefixed([
      utf8(ID_A),
      utf8(ID_B),
      sBytes,
      tBytes,
      this.sharedKBytes,
      scalarToBytes(this.w),
    ]);
    const ttHash = sha256(this.transcript);

    this.session = hkdf(sha256, ttHash, undefined, utf8(INFO_SESSION), KEY_SIZE);
    const kcA = hkdf(sha256, ttHash, undefined, utf8(INFO_KC_A), KEY_SIZE);
    const kcB = hkdf(sha256, ttHash, undefined, utf8(INFO_KC_B), KEY_SIZE);

    if (this.role === 'A') {
      this.confirmKeySelf = kcA;
      this.confirmKeyPeer = kcB;
    } else {
      this.confirmKeySelf = kcB;
      this.confirmKeyPeer = kcA;
    }

    const confirm = hmac(sha256, this.confirmKeySelf, this.transcript);
    return { sessionKey: this.session, confirm };
  }

  /** confirmPeer verifies the peer's confirmation MAC over the transcript. */
  confirmPeer(peerConfirm: Uint8Array): boolean {
    if (!this.transcript || !this.confirmKeyPeer) throw new Error('spake2: finish not called');
    const want = hmac(sha256, this.confirmKeyPeer, this.transcript);
    return constantTimeEqual(want, peerConfirm);
  }

  /** sessionKey returns the derived 32-byte key, or undefined before finish. */
  sessionKey(): Uint8Array | undefined {
    return this.session;
  }
  /** sharedK returns the 32-byte K encoding, for vector dumps. */
  sharedK(): Uint8Array | undefined {
    return this.sharedKBytes;
  }
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// --- secretbox app traffic (TweetNaCl XSalsa20-Poly1305) ------------------

const b64 = {
  encode(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  },
  decode(s: string): Uint8Array {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

/** seal returns base64(nonce(24) || secretbox(plaintext)) under key. */
export function seal(key: Uint8Array, plaintext: Uint8Array): string {
  if (key.length !== KEY_SIZE) throw new Error('sealedbox: key must be 32 bytes');
  const nonce = new Uint8Array(NONCE_SIZE);
  crypto.getRandomValues(nonce);
  return sealWithNonce(key, nonce, plaintext);
}

/** sealWithNonce is seal with a caller-supplied nonce, for deterministic vectors. */
export function sealWithNonce(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): string {
  if (key.length !== KEY_SIZE) throw new Error('sealedbox: key must be 32 bytes');
  if (nonce.length !== NONCE_SIZE) throw new Error('sealedbox: nonce must be 24 bytes');
  const box = nacl.secretbox(plaintext, nonce, key);
  const out = new Uint8Array(NONCE_SIZE + box.length);
  out.set(nonce, 0);
  out.set(box, NONCE_SIZE);
  return b64.encode(out);
}

/** open decodes base64(nonce||ciphertext) and authenticates+decrypts under key. */
export function open(key: Uint8Array, payload: string): Uint8Array {
  if (key.length !== KEY_SIZE) throw new Error('sealedbox: key must be 32 bytes');
  const raw = b64.decode(payload);
  if (raw.length < NONCE_SIZE) throw new Error('sealedbox: payload shorter than nonce');
  const nonce = raw.subarray(0, NONCE_SIZE);
  const box = raw.subarray(NONCE_SIZE);
  const pt = nacl.secretbox.open(box, nonce, key);
  if (!pt) throw new Error('sealedbox: open: authentication failed');
  return pt;
}
