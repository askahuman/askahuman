// Approval protocol v2. Mirrors backend/pkg/wire/protocol.go; signing bytes are
// length-prefixed UTF-8 fields, independent of JSON serialization or escaping.
import { sha256 } from '@noble/hashes/sha2.js';
import { b64Decode, b64Encode } from './b64.ts';
import type { Request, Decision, PushSub, VapidKey } from './wire.ts';

export const PROTOCOL = 2;
export const MAX_PLAINTEXT = 16 * 1024;
export const MAX_TEXT = 4096;
export const UPGRADE_MESSAGE =
  'Update the agent and refresh this app, then call start_pairing with reset:true and enter the new code.';

export interface PairHello {
  protocol: number;
  pake: string;
  signer: string;
}
export interface Ack {
  kind: 'ack';
  protocol: number;
  room: string;
  id: string;
  request_hash: string;
  decision_hash: string;
  status: 'accepted' | 'expired' | 'unknown';
  sig: string;
}

export function fields(...parts: string[]): Uint8Array<ArrayBuffer> {
  const chunks = parts.map((p) => new TextEncoder().encode(p));
  const out = new Uint8Array(chunks.reduce((n, c) => n + 8 + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    new DataView(out.buffer).setUint32(at + 4, c.length, false);
    out.set(c, at + 8);
    at += c.length + 8;
  }
  return out;
}
export const pairBinding = (
  room: string,
  agent: string,
  phone: string,
): Uint8Array<ArrayBuffer> => fields('aah:pair:v2', room, agent, phone);
export function requestSigningMessage(r: Request): Uint8Array<ArrayBuffer> {
  return fields(
    'aah:request:v2',
    String(r.protocol ?? 0),
    r.room ?? '',
    String(r.request_seq ?? 0),
    r.id,
    r.title,
    r.category ?? '',
    r.summary,
    r.agent ?? '',
    r.response.kind,
    String(r.response.options?.length ?? 0),
    ...(r.response.options ?? []),
    r.response.placeholder ?? '',
    String(r.response.max_len ?? 0),
    String(r.expires_in_s ?? 0),
    String(r.deadline_ms ?? 0),
  );
}
export const hash = (b: Uint8Array): string => b64Encode(sha256(b));
export const requestHash = (r: Request): string =>
  hash(requestSigningMessage(r));
export function boundDecisionSigningMessage(
  d: Decision,
): Uint8Array<ArrayBuffer> {
  const value =
    d.response_kind === 'yesno'
      ? d.result.approved
        ? '1'
        : '0'
      : d.response_kind === 'choice'
        ? (d.result.choice ?? '')
        : (d.result.text ?? '');
  return fields(
    'aah:decision:v2',
    String(d.protocol ?? 0),
    d.room ?? '',
    d.id,
    d.request_hash ?? '',
    d.response_kind ?? '',
    value,
  );
}
export const decisionHash = (d: Decision): string =>
  hash(boundDecisionSigningMessage(d));
export const ackSigningMessage = (a: Ack): Uint8Array<ArrayBuffer> =>
  fields(
    'aah:ack:v2',
    String(a.protocol),
    a.room,
    a.id,
    a.request_hash,
    a.decision_hash,
    a.status,
  );
export const pushSigningMessage = (p: PushSub): Uint8Array<ArrayBuffer> =>
  fields(
    'aah:push-sub:v2',
    String(p.protocol ?? 0),
    p.room ?? '',
    String(p.push_seq ?? 0),
    p.subscription.endpoint,
    p.subscription.keys.p256dh,
    p.subscription.keys.auth,
  );
export const vapidSigningMessage = (v: VapidKey): Uint8Array<ArrayBuffer> =>
  fields('aah:vapid:v2', String(v.protocol ?? 0), v.room ?? '', v.public_key);

export function canonicalBase64(s: unknown, length: number): s is string {
  if (typeof s !== 'string') return false;
  try {
    const b = b64Decode(s);
    return b.length === length && b64Encode(b) === s;
  } catch {
    return false;
  }
}
export async function importSigner(spki: string): Promise<CryptoKey> {
  const bytes = new Uint8Array(b64Decode(spki));
  if (bytes.length > 256 || b64Encode(bytes) !== spki)
    throw new Error('Invalid signing identity');
  const key = await crypto.subtle.importKey(
    'spki',
    bytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
  if (
    b64Encode(new Uint8Array(await crypto.subtle.exportKey('spki', key))) !==
    spki
  )
    throw new Error('Noncanonical signing identity');
  return key;
}
export async function verify(
  key: CryptoKey,
  message: Uint8Array<ArrayBuffer>,
  sig: unknown,
): Promise<boolean> {
  if (!canonicalBase64(sig, 64)) return false;
  try {
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new Uint8Array(b64Decode(sig)),
      message,
    );
  } catch {
    return false;
  }
}

// Code points, not UTF-16 code units or UTF-8 bytes. No normalization or trimming
// changes the text a human sees/signs. Reject unpaired surrogates explicitly.
export function scalarLength(s: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++, count++) {
    const c = s.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) throw new Error('wire: unpaired surrogate');
    if (c >= 0xd800 && c <= 0xdbff) {
      const lo = s.charCodeAt(++i);
      if (!(lo >= 0xdc00 && lo <= 0xdfff))
        throw new Error('wire: unpaired surrogate');
    }
  }
  return count;
}
export function clampScalars(s: string, max: number): string {
  scalarLength(s);
  return Array.from(s).slice(0, max).join('');
}
export function bounded(
  v: unknown,
  name: string,
  max: number,
  required = false,
): string {
  if (v === undefined && !required) return '';
  if (typeof v !== 'string' || scalarLength(v) > max || (required && !v))
    throw new Error(`wire: invalid ${name}`);
  return v;
}
export function object(
  v: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error('wire: expected object');
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => !keys.includes(k)))
    throw new Error('wire: unknown field');
  return o;
}
export function integer(n: unknown, max: number, optional = false): void {
  if (optional && n === undefined) return;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > max)
    throw new Error('wire: invalid integer');
}
export function validateRequest(r: Request): void {
  object(r, [
    'kind',
    'protocol',
    'room',
    'deadline_ms',
    'request_seq',
    'sig',
    'id',
    'title',
    'category',
    'summary',
    'agent',
    'response',
    'expires_in_s',
  ]);
  if (
    r.kind !== 'request' ||
    r.protocol !== PROTOCOL ||
    !/^[a-f0-9]{16}$/.test(r.room ?? '')
  )
    throw new Error('wire: invalid request metadata');
  integer(r.deadline_ms, Number.MAX_SAFE_INTEGER);
  integer(r.request_seq, Number.MAX_SAFE_INTEGER);
  if (!r.request_seq) throw new Error('wire: invalid request sequence');
  bounded(r.sig, 'signature', 88);
  bounded(r.id, 'id', 256, true);
  bounded(r.title, 'title', 512);
  bounded(r.summary, 'summary', 4096);
  bounded(r.agent, 'agent', 256);
  bounded(r.category, 'category', 256);
  const resp = r.response;
  object(resp, ['kind', 'options', 'placeholder', 'max_len']);
  bounded(resp.placeholder, 'placeholder', 256);
  integer(resp.max_len, MAX_TEXT, true);
  if (resp.kind === 'yesno') {
    if (
      resp.options !== undefined ||
      resp.placeholder !== undefined ||
      resp.max_len !== undefined
    )
      throw new Error('wire: irrelevant response fields');
  } else if (resp.kind === 'choice') {
    if (
      !Array.isArray(resp.options) ||
      resp.options.length < 1 ||
      resp.options.length > 32 ||
      resp.placeholder !== undefined ||
      resp.max_len !== undefined
    )
      throw new Error('wire: invalid choice response');
    for (const o of resp.options) bounded(o, 'option', 256, true);
    if (new Set(resp.options).size !== resp.options.length)
      throw new Error('wire: duplicate options');
  } else if (resp.kind === 'text') {
    if (resp.options !== undefined) throw new Error('wire: irrelevant options');
  } else throw new Error('wire: invalid response kind');
  integer(r.expires_in_s, 86400, true);
  // Reserve the same largest metadata and Go JSON escaping budget as the agent.
  const transport = {
    protocol: PROTOCOL,
    room: 'f'.repeat(16),
    deadline_ms: Number.MAX_SAFE_INTEGER,
    request_seq: Number.MAX_SAFE_INTEGER,
    sig: 'A'.repeat(88),
    kind: 'request',
    id: r.id,
    title: r.title ?? '',
    ...(r.category ? { category: r.category } : {}),
    summary: r.summary ?? '',
    ...(r.agent ? { agent: r.agent } : {}),
    response: {
      kind: resp.kind,
      ...(resp.options?.length ? { options: resp.options } : {}),
      ...(resp.placeholder ? { placeholder: resp.placeholder } : {}),
      ...(resp.max_len ? { max_len: resp.max_len } : {}),
    },
    ...(r.expires_in_s ? { expires_in_s: r.expires_in_s } : {}),
  };
  const serialized = JSON.stringify(transport).replace(
    /[<>&\u2028\u2029]/g,
    (s) => `\\u${s.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  if (new TextEncoder().encode(serialized).length >= MAX_PLAINTEXT)
    throw new Error('wire: request exceeds encoded size limit');
}
export function validateDecision(d: Decision): void {
  object(d, [
    'kind',
    'protocol',
    'room',
    'id',
    'request_hash',
    'response_kind',
    'result',
    'sig',
  ]);
  if (
    d.kind !== 'decision' ||
    d.protocol !== PROTOCOL ||
    !/^[a-f0-9]{16}$/.test(d.room ?? '') ||
    !canonicalBase64(d.request_hash, 32)
  )
    throw new Error('wire: invalid decision metadata');
  bounded(d.sig, 'signature', 88);
  bounded(d.id, 'id', 256, true);
  const r = object(
    d.result,
    d.response_kind === 'yesno'
      ? ['approved']
      : d.response_kind === 'choice'
        ? ['choice']
        : ['text'],
  );
  if (d.response_kind === 'yesno') {
    if (typeof r.approved !== 'boolean')
      throw new Error('wire: missing boolean');
  } else if (d.response_kind === 'choice')
    bounded(r.choice, 'choice', 256, true);
  else if (d.response_kind === 'text') bounded(r.text, 'text', MAX_TEXT);
  else throw new Error('wire: invalid result kind');
}
export function decodeAck(bytes: Uint8Array): Ack {
  const a = object(strictJSON(bytes), [
    'kind',
    'protocol',
    'room',
    'id',
    'request_hash',
    'decision_hash',
    'status',
    'sig',
  ]);
  if (
    a.kind !== 'ack' ||
    a.protocol !== PROTOCOL ||
    typeof a.room !== 'string' ||
    !/^[a-f0-9]{16}$/.test(a.room) ||
    !canonicalBase64(a.request_hash, 32) ||
    !canonicalBase64(a.decision_hash, 32) ||
    !['accepted', 'expired', 'unknown'].includes(String(a.status)) ||
    !canonicalBase64(a.sig, 64)
  )
    throw new Error('wire: invalid acknowledgement');
  bounded(a.id, 'id', 256, true);
  return a as unknown as Ack;
}

// JSON.parse loses duplicate keys and repairs no scalar errors. Scan first with
// bounded recursion, reject nulls and noncanonical integers, then parse once.
export function strictJSON(bytes: Uint8Array): unknown {
  if (bytes.length > MAX_PLAINTEXT)
    throw new Error('wire: plaintext too large');
  const s = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    bytes,
  );
  let i = 0;
  const ws = () => {
    while (i < s.length && /[\x20\t\r\n]/.test(s[i]!)) i++;
  };
  const str = (): string => {
    const start = i++;
    while (i < s.length) {
      if (s[i] === '\\') {
        i += 2;
        continue;
      }
      if (s[i++] === '"') {
        const value: unknown = JSON.parse(s.slice(start, i));
        if (typeof value !== 'string') throw new Error('wire: expected string');
        scalarLength(value);
        return value;
      }
    }
    throw new Error('wire: unterminated string');
  };
  const value = (depth: number): void => {
    if (depth > 16) throw new Error('wire: JSON nesting too deep');
    ws();
    if (s[i] === '"') {
      str();
      return;
    }
    if (s[i] === '{' || s[i] === '[') {
      const isObject = s[i++] === '{',
        end = isObject ? '}' : ']';
      const seen = new Set<string>();
      ws();
      if (s[i] === end) {
        i++;
        return;
      }
      while (i < s.length) {
        if (isObject) {
          if (s[i] !== '"') throw new Error('wire: expected key');
          const k = str();
          if (seen.has(k)) throw new Error('wire: duplicate key');
          seen.add(k);
          ws();
          if (s[i++] !== ':') throw new Error('wire: missing colon');
        }
        value(depth + 1);
        ws();
        if (s[i] === end) {
          i++;
          return;
        }
        if (s[i++] !== ',') throw new Error('wire: expected comma');
        ws();
      }
      throw new Error('wire: missing delimiter');
    }
    for (const token of ['true', 'false']) {
      if (s.startsWith(token, i)) {
        i += token.length;
        return;
      }
    }
    const m = /^-?(0|[1-9][0-9]*)/.exec(s.slice(i));
    if (
      !m ||
      !Number.isSafeInteger(Number(m[0])) ||
      String(Number(m[0])) !== m[0]
    )
      throw new Error('wire: invalid value');
    i += m[0].length;
  };
  value(0);
  ws();
  if (i !== s.length) throw new Error('wire: trailing JSON');
  return JSON.parse(s) as unknown;
}
