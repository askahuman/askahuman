// payload encodes/decodes the pairing deep link the agent shows as a QR.
//
// Deep link: <webOrigin>/app#p=<base64url(JSON{"r":...,"room":...,"code":...})>
//   r    = relay WebSocket URL (e.g. wss://relay.example/ws  or  ws://localhost:8080/ws)
//   room = room id (16 hex chars)
//   code = short SPAKE2 password (e.g. "4F2-9KQ")
// The PWA reads location.hash on load; "#p=" auto-starts pairing as phone (B).

import { b64urlDecode, b64urlEncode } from './b64.ts';

/** PairPayload is the JSON carried in the deep link / QR. */
export interface PairPayload {
  /** r is the relay WebSocket URL. */
  r: string;
  /** room is the 16-hex room id both peers join. */
  room: string;
  /** code is the short SPAKE2 password shown for manual entry. */
  code: string;
}

const HASH_PREFIX = 'p=';

/** ROOM_RE mirrors codegen.newRoomID (16 lowercase-hex chars) — the room-id contract. */
const ROOM_RE = /^[0-9a-f]{16}$/;

/**
 * validRelayURL guards the deep-link relay URL before it is ever used to open a
 * WebSocket: it must be a parseable URL whose scheme is "wss:" (TLS), or "ws:"
 * only when the host is localhost/127.0.0.1 (dev). This rejects http(s)/javascript
 * and any non-WS scheme an attacker could plant in a scanned/clicked link.
 */
function validRelayURL(r: string): boolean {
  let u: URL;
  try {
    u = new URL(r);
  } catch {
    return false;
  }
  if (u.protocol === 'wss:') return true;
  if (u.protocol === 'ws:') return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  return false;
}

/**
 * validPayload guards a decoded object as a complete PairPayload AND validates
 * every field against its contract: r is a safe WS URL, room matches the 16-hex
 * room-id contract, code is non-empty. A deep link is untrusted input.
 */
function validPayload(v: unknown): v is PairPayload {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  if (typeof p.r !== 'string' || !validRelayURL(p.r)) return false;
  if (typeof p.room !== 'string' || !ROOM_RE.test(p.room)) return false;
  if (typeof p.code !== 'string' || p.code === '') return false;
  return true;
}

/** encodePayload builds the base64url JSON blob (the part after "#p="). */
export function encodePayload(p: PairPayload): string {
  const json = JSON.stringify({ r: p.r, room: p.room, code: p.code });
  return b64urlEncode(new TextEncoder().encode(json));
}

/** buildDeepLink returns the full deep link for a payload at webOrigin. The PWA
 * lives at /app (the marketing landing is at /), so the link targets /app. */
export function buildDeepLink(webOrigin: string, p: PairPayload): string {
  const origin = webOrigin.replace(/\/+$/, '');
  return `${origin}/app#${HASH_PREFIX}${encodePayload(p)}`;
}

/** decodePayload parses a base64url JSON blob into a PairPayload, or throws. */
export function decodePayload(blob: string): PairPayload {
  const v: unknown = JSON.parse(new TextDecoder().decode(b64urlDecode(blob)));
  if (!validPayload(v)) throw new Error('payload: missing r/room/code');
  return { r: v.r, room: v.room, code: v.code };
}

/**
 * parseHash extracts a PairPayload from a location.hash string ("#p=<blob>"),
 * or null when absent / malformed. Accepts an optional leading "#". A scanned
 * URL is also accepted: pass its hash fragment.
 */
export function parseHash(hash: string): PairPayload | null {
  if (!hash) return null;
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!h.startsWith(HASH_PREFIX)) return null;
  const blob = h.slice(HASH_PREFIX.length);
  if (!blob) return null;
  try {
    return decodePayload(blob);
  } catch {
    return null;
  }
}

/**
 * parseQuery extracts a PairPayload from a location.search string ("?p=<blob>"),
 * or null when absent / malformed. Query strings survive QR scanning where the
 * URL fragment ("#p=") is dropped by iOS Camera, so the QR encodes "?p=".
 */
export function parseQuery(search: string): PairPayload | null {
  if (!search) return null;
  const q = search.startsWith('?') ? search : '?' + search;
  const blob = new URLSearchParams(q).get('p');
  if (!blob) return null;
  try {
    return decodePayload(blob);
  } catch {
    return null;
  }
}

/**
 * parseScanned extracts a PairPayload from a scanned QR string. The QR encodes
 * the full deep link, so pull out the "?p=" query or "#p=" fragment; also
 * tolerate a bare base64url blob or a bare "p=<blob>".
 */
export function parseScanned(text: string): PairPayload | null {
  const t = text.trim();
  if (!t) return null;
  const hashAt = t.indexOf('#');
  if (hashAt >= 0) {
    const fromHash = parseHash(t.slice(hashAt));
    if (fromHash) return fromHash;
  }
  const qAt = t.indexOf('?');
  if (qAt >= 0) {
    const fromQuery = parseQuery(t.slice(qAt));
    if (fromQuery) return fromQuery;
  }
  if (t.startsWith(HASH_PREFIX)) return parseHash('#' + t);
  // Bare blob fallback.
  try {
    return decodePayload(t);
  } catch {
    return null;
  }
}

/**
 * scrubbedURL returns the path-only form of a URL with the query and fragment
 * stripped — used to erase the pairing code (?p= / #p=) from the address bar and
 * history after it has been parsed, so it cannot leak via screenshots, history,
 * referrers, or shared links. Returns just the pathname.
 */
export function scrubbedURL(href: string): string {
  try {
    return new URL(href).pathname;
  } catch {
    return '/';
  }
}
