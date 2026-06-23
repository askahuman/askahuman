// codegen turns the typed pairing code into the values the phone needs: the
// canonical SPAKE2 password and the rendezvous room id. The agent mints + prints
// the code; the phone only ever receives a typed string and derives from it.
// Crockford-ish base32 (no easily confused 0/O/1/I/L) keeps the code legible.

import { argon2id } from '@noble/hashes/argon2.js';

/** CODE_ALPHABET is the 31-symbol set shared byte-for-byte with the Go agent
 *  (paircode.Alphabet): Crockford-ish, no 0/O/1/I/L. The code IS the SPAKE2
 *  password, so every symbol must carry real entropy. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
/** CODE_LEN is the number of code symbols (paircode.Len). 10 × log2(31) ≈ 49.5
 *  bits — the precompute table that the memory-hard room KDF defends against
 *  becomes ~6.5 PB / infeasible at this length (ADR 0018). */
export const CODE_LEN = 10;
/** CODE_GROUP is the display grouping: the hyphen sits between two groups of
 *  this many symbols (CODE_GROUP must divide CODE_LEN). 5 divides 10 -> one
 *  midpoint hyphen "XXXXX-XXXXX". Display-only — the hyphen carries no entropy
 *  and canonicalizeCode strips it back out. */
export const CODE_GROUP = 5;
/** ROOM_INFO domain-separates the room KDF; it is also the Argon2id salt (a
 *  public, intentionally non-secret domain separator). Must match Go
 *  paircode.roomInfo. */
const ROOM_INFO = 'ask-a-human:pair-room:v1';
/** ROOM_KDF_* are the Argon2id room-derivation parameters; they MUST match Go
 *  paircode.roomKDF* byte-for-byte (m in KiB, t passes, p lanes) or Go and the
 *  phone derive different rooms (silent no-pair). ref. ADR 0018.
 *  ponytail: m=19 MiB is the OWASP-interactive floor picked to fit the pair-time
 *  mobile budget (~0.8-1.6s one-time); upgrade path for more margin is m=32 MiB
 *  (a 1-line change here AND in Go). p MUST stay 1 and m a multiple of 4 — the
 *  only regime where Go's and @noble's memory rounding agree. */
const ROOM_KDF_MEM_KIB = 19 * 1024; // 19 MiB
const ROOM_KDF_TIME = 2;
const ROOM_KDF_P = 1;
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
    throw new Error('codegen: code must be 10 symbols from the pairing alphabet');
  }
  return canon;
}

/**
 * formatCodeInput renders a partially- or fully-typed code for the input field:
 * ASCII-uppercase, keep only in-alphabet symbols (drops separators AND the
 * deliberately-excluded look-alikes 0/O/1/I/L), cap at CODE_LEN, then regroup as
 * XXXXX-XXXXX. This is what makes the separating hyphen appear on its own as the
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
 *   roomID = hex( Argon2id(ikm=canon, salt=ROOM_INFO, m=19MiB, t=2, p=1)[:8] )
 * canon must already be canonicalizeCode'd. The memory-hard KDF (replacing the
 * old HKDF-SHA256) makes a room→code precompute table infeasible (ADR 0018).
 * Byte-identical to Go paircode.RoomFromCode; pinned by
 * frontend/test/spake2-interop.mjs.
 *
 * ponytail: argon2id is a SYNC ~0.4s (node) / ~1s (mobile JS) call run ONCE at
 * pair time — acceptable for a one-shot action; callers (App.tsx) invoke it
 * synchronously at submit. If a low-end phone janks the submit, the upgrade path
 * is the async variant `argon2idAsync` kicked off at field-blur to overlap the
 * relay dial.
 */
export function roomFromCode(canon: string): string {
  const okm = argon2id(TE.encode(canon), TE.encode(ROOM_INFO), {
    t: ROOM_KDF_TIME,
    m: ROOM_KDF_MEM_KIB,
    p: ROOM_KDF_P,
    dkLen: 8,
  });
  let out = '';
  for (const b of okm) out += b.toString(16).padStart(2, '0');
  return out;
}
