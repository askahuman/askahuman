// codegen turns the typed pairing code into the values the phone needs: the
// canonical SPAKE2 password and the rendezvous room id. The agent mints + prints
// the code; the phone only ever receives a typed string and derives from it.
// Crockford-ish base32 (no easily confused 0/O/1/I/L) keeps the code legible.

import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';

/** CODE_ALPHABET is the 31-symbol set shared byte-for-byte with the Go agent
 *  (paircode.Alphabet): Crockford-ish, no 0/O/1/I/L. The code IS the SPAKE2
 *  password, so every symbol must carry real entropy. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
/** CODE_LEN is the number of code symbols (paircode.Len). */
export const CODE_LEN = 8;
/** CODE_GROUP is the display grouping: the hyphen sits between two groups of
 *  this many symbols (CODE_GROUP must divide CODE_LEN). Display-only — the
 *  hyphen carries no entropy and canonicalizeCode strips it back out. */
export const CODE_GROUP = 4;
/** ROOM_INFO domain-separates the room KDF; must match Go paircode.roomInfo. */
const ROOM_INFO = 'ask-a-human:pair-room:v1';
const TE = new TextEncoder();

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
 * formatCodeInput renders a partially- or fully-typed code for the input field:
 * ASCII-uppercase, keep only in-alphabet symbols (drops separators AND the
 * deliberately-excluded look-alikes 0/O/1/I/L), cap at CODE_LEN, then regroup as
 * XXXX-XXXX. This is what makes the separating hyphen appear on its own as the
 * user types — they never type a dash or space. Purely cosmetic: canonicalizeCode
 * strips the hyphen again, so the SPAKE2 password is byte-identical with or
 * without it. Use codeSymbolsBefore to keep the caret in place across regrouping.
 */
export function formatCodeInput(raw: string): string {
  const canon = codeSymbolsBefore(raw, raw.length);
  if (canon.length <= CODE_GROUP) return canon;
  return canon.slice(0, CODE_GROUP) + '-' + canon.slice(CODE_GROUP);
}

/**
 * codeSymbolsBefore returns the in-alphabet, uppercased symbols found in the
 * first `cut` UTF-16 units of `raw`, capped at CODE_LEN. Its length is the count
 * of real code symbols before a caret at `cut` — formatCodeInput uses it for the
 * whole string; PairScreen uses the count to restore the caret after regrouping.
 */
export function codeSymbolsBefore(raw: string, cut: number): string {
  let out = '';
  for (const ch of raw.slice(0, cut).toUpperCase()) {
    if (CODE_ALPHABET.includes(ch)) out += ch;
    if (out.length === CODE_LEN) break;
  }
  return out;
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
