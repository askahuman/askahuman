// b64 is the one shared base64 codec for the PWA. Two flavors:
//   - standard base64 (SPAKE2 raw-byte messages on the wire): b64Encode/b64Decode.
//   - base64url, unpadded (the deep-link payload blob): b64urlEncode/b64urlDecode.
// One copy so payload.ts and pairing.ts never drift. (push.ts dedupe is separate.)

/** b64Encode encodes bytes as standard (padded) base64. */
export function b64Encode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** b64Decode decodes a standard base64 string to bytes (throws on garbage). */
export function b64Decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** b64urlEncode encodes bytes as URL-safe base64 without padding. */
export function b64urlEncode(bytes: Uint8Array): string {
  return b64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** b64urlDecode decodes a (possibly unpadded) base64url string to bytes. */
export function b64urlDecode(s: string): Uint8Array {
  let t = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = t.length % 4;
  if (pad === 2) t += '==';
  else if (pad === 3) t += '=';
  else if (pad === 1) throw new Error('b64: malformed base64url');
  return b64Decode(t);
}
