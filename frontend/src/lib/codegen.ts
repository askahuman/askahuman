// codegen mints a roomID + short pairing code for the phone-initiated "Show my
// code" path. The agent normally mints these; when the phone shows a code, it
// owns the values and the agent scans them. Crockford-ish base32 (no easily
// confused chars) keeps the short code legible, grouped XXX-XXX like "4F2-9KQ".

import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';

const ROOM_HEX = '0123456789abcdef';

/** CODE_ALPHABET is the 31-symbol set shared byte-for-byte with the Go agent
 *  (paircode.Alphabet): Crockford-ish, no 0/O/1/I/L. The code IS the SPAKE2
 *  password, so every symbol must carry real entropy. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
/** CODE_LEN is the number of code symbols (paircode.Len). */
export const CODE_LEN = 8;
/** ROOM_INFO domain-separates the room KDF; must match Go paircode.roomInfo. */
const ROOM_INFO = 'ask-a-human:pair-room:v1';
const TE = new TextEncoder();

function pick(alphabet: string, n: number): string {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[buf[i]! % alphabet.length];
  return out;
}

/** newRoomID returns a 16-hex-char room id. */
export function newRoomID(): string {
  return pick(ROOM_HEX, 16);
}

/** newCode returns a grouped short code, e.g. "4F2-9KQ". */
export function newCode(): string {
  return `${pick(CODE_ALPHABET, 3)}-${pick(CODE_ALPHABET, 3)}`;
}

/** defaultRelayURL derives the relay ws url for the phone-shown path.
 *  Prefers PUBLIC_RELAY_URL (build env); falls back to same-origin /ws. */
export function defaultRelayURL(origin: string): string {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env?.PUBLIC_RELAY_URL;
  if (env) return env;
  try {
    const u = new URL(origin);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ws';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return 'ws://localhost:8080/ws';
  }
}

/**
 * canonicalizeCode folds a typed or displayed code to its canonical form:
 * ASCII-uppercase, then drop every character not in CODE_ALPHABET (hyphen,
 * spaces). The result must be exactly CODE_LEN in-alphabet symbols, else it
 * throws. This SAME canonical string feeds BOTH roomFromCode and the SPAKE2
 * password — hyphen/case are display only. Must match Go paircode.Canonicalize.
 */
export function canonicalizeCode(code: string): string {
  let canon = '';
  for (const ch of code.toUpperCase()) {
    if (CODE_ALPHABET.includes(ch)) canon += ch;
  }
  if (canon.length !== CODE_LEN) {
    throw new Error('codegen: code must be 8 symbols from the pairing alphabet');
  }
  return canon;
}

/**
 * roomFromCode derives the 16-hex rendezvous room id from a canonical code:
 *   roomID = hex( HKDF-SHA256(ikm=canon, salt=∅, info=ROOM_INFO)[:8] )
 * canon must already be canonicalizeCode'd. Byte-identical to Go
 * paircode.RoomFromCode; pinned by frontend/test/spake2-interop.mjs.
 */
export function roomFromCode(canon: string): string {
  const okm = hkdf(sha256, TE.encode(canon), undefined, TE.encode(ROOM_INFO), 8);
  let out = '';
  for (const b of okm) out += b.toString(16).padStart(2, '0');
  return out;
}
