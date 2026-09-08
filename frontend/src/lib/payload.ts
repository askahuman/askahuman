// payload defines the internal pairing parameters the phone hands a Session.
//
// Code-only pairing: the agent prints a 10-char code; the user types it into the
// app; the phone canonicalizes it (codegen.canonicalizeCode), derives the room
// (codegen.roomFromCode) and the relay URL (codegen.defaultRelayURL), and builds
// this PairPayload internally. NOTHING secret is ever placed in a URL/hash —
// there is no deep link, and the code is never written to location.

/** PairPayload is the internal pairing parameter set for one Session. */
export interface PairPayload {
  /** r is the relay WebSocket URL. */
  r: string;
  /** room is the 16-hex room id both peers join (derived from the code). */
  room: string;
  /**
   * code is the canonical SPAKE2 password (canonicalizeCode output). It is the
   * pairing SECRET — keep it in memory only. NEVER JSON.stringify this object
   * into a URL/hash/log/postMessage; there is intentionally no wire encoder for
   * PairPayload (the old deep-link codec was removed for exactly this reason).
   */
  code: string;
}

/** ROOM_RE mirrors codegen.roomFromCode (16 lowercase-hex chars) — the room-id contract. */
export const ROOM_RE = /^[0-9a-f]{16}$/;

/**
 * validRelayURL guards a relay URL before it is ever used to open a WebSocket:
 * it must be a parseable URL whose scheme is "wss:" (TLS), or "ws:" only when the
 * host is localhost/127.0.0.1 (dev). This rejects http(s)/javascript and any
 * non-WS scheme — used to vet the optional self-hoster "Advanced" relay field.
 */
export function validRelayURL(r: string): boolean {
  let u: URL;
  try {
    u = new URL(r);
  } catch {
    return false;
  }
  if (u.username || u.password || u.href.includes('#')) return false;
  if (u.protocol === 'wss:') return true;
  if (u.protocol === 'ws:') return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  return false;
}

/** Match the hosted app's deliberately restricted nginx connect-src policy.
 * Self-hosted installations control their own relay and CSP configuration. */
export function relayURLProblem(r: string, appOrigin: string): string | null {
  if (!validRelayURL(r)) return 'Relay must use wss:// (ws:// only for localhost), without credentials or a fragment.';
  if (appOrigin === 'https://ask-a-human.ai' && new URL(r).origin !== 'wss://ask-a-human.ai') {
    return 'This hosted app connects only to ask-a-human.ai. To use a custom relay, open its own app installation.';
  }
  return null;
}
