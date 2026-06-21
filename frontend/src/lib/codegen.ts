// codegen mints a roomID + short pairing code for the phone-initiated "Show my
// code" path. The agent normally mints these; when the phone shows a code, it
// owns the values and the agent scans them. Crockford-ish base32 (no easily
// confused chars) keeps the short code legible, grouped XXX-XXX like "4F2-9KQ".

const ROOM_HEX = '0123456789abcdef';
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no I, L, O

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
