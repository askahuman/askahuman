// Unit tests for pairing-payload encode/decode and deep-link / scan parsing.

import { describe, expect, it } from 'vitest';

import {
  buildDeepLink,
  decodePayload,
  encodePayload,
  parseHash,
  parseQuery,
  parseScanned,
  scrubbedURL,
  type PairPayload,
} from '../src/lib/payload.ts';

const p: PairPayload = { r: 'wss://relay.example/ws', room: '0123456789abcdef', code: '4F2-9KQ' };

describe('payload round trip', () => {
  it('encode -> decode is identity', () => {
    expect(decodePayload(encodePayload(p))).toEqual(p);
  });

  it('buildDeepLink produces a /app#p=<blob> link parseable by parseHash', () => {
    const link = buildDeepLink('https://app.example', p);
    expect(link).toMatch(/^https:\/\/app\.example\/app#p=/);
    const hash = link.slice(link.indexOf('#'));
    expect(parseHash(hash)).toEqual(p);
  });

  it('strips a trailing slash from webOrigin', () => {
    expect(buildDeepLink('https://app.example/', p)).toMatch(/^https:\/\/app\.example\/app#p=/);
  });
});

describe('parseHash', () => {
  it('parses with or without leading #', () => {
    const blob = encodePayload(p);
    expect(parseHash('#p=' + blob)).toEqual(p);
    expect(parseHash('p=' + blob)).toEqual(p);
  });
  it('returns null for absent / wrong prefix / garbage', () => {
    expect(parseHash('')).toBeNull();
    expect(parseHash('#foo=bar')).toBeNull();
    expect(parseHash('#p=')).toBeNull();
    expect(parseHash('#p=!!!not-base64!!!')).toBeNull();
  });
  it('returns null when a field is missing', () => {
    const blob = encodePayload({ ...p, code: '' } as PairPayload);
    expect(parseHash('#p=' + blob)).toBeNull();
  });
});

describe('parseQuery', () => {
  it('parses a "?p=<blob>" query (scan-safe; survives where #p= is dropped)', () => {
    const blob = encodePayload(p);
    expect(parseQuery('?p=' + blob)).toEqual(p);
    expect(parseQuery('p=' + blob)).toEqual(p);
  });
  it('parses ?p= alongside other query params', () => {
    const blob = encodePayload(p);
    expect(parseQuery('?foo=1&p=' + blob + '&bar=2')).toEqual(p);
  });
  it('returns null for absent/malformed query', () => {
    expect(parseQuery('')).toBeNull();
    expect(parseQuery('?foo=bar')).toBeNull();
    expect(parseQuery('?p=')).toBeNull();
    expect(parseQuery('?p=!!!not-base64!!!')).toBeNull();
  });
});

describe('parseScanned', () => {
  it('parses a scanned "?p=" deep link (the QR form)', () => {
    const blob = encodePayload(p);
    expect(parseScanned('https://app.example/?p=' + blob)).toEqual(p);
  });
  it('extracts payload from a full deep link', () => {
    expect(parseScanned(buildDeepLink('https://app.example', p))).toEqual(p);
  });
  it('accepts a bare base64url blob', () => {
    expect(parseScanned(encodePayload(p))).toEqual(p);
  });
  it('rejects unrelated text', () => {
    expect(parseScanned('https://example.com/some/page')).toBeNull();
    expect(parseScanned('  ')).toBeNull();
  });
});

describe('validPayload hardening (untrusted deep link)', () => {
  const enc = (o: Record<string, unknown>) =>
    encodePayload(o as unknown as PairPayload);

  it('rejects http(s) and javascript relay schemes', () => {
    for (const r of ['http://relay.example/ws', 'https://relay.example/ws', 'javascript:alert(1)', 'file:///etc/passwd']) {
      expect(parseHash('#p=' + enc({ ...p, r }))).toBeNull();
    }
  });

  it('rejects a non-URL relay value', () => {
    expect(parseHash('#p=' + enc({ ...p, r: 'not a url' }))).toBeNull();
  });

  it('accepts wss:// and ws://localhost only', () => {
    expect(parseHash('#p=' + enc({ ...p, r: 'wss://relay.example/ws' }))).toEqual({ ...p, r: 'wss://relay.example/ws' });
    expect(parseHash('#p=' + enc({ ...p, r: 'ws://localhost:8080/ws' }))).toEqual({ ...p, r: 'ws://localhost:8080/ws' });
    expect(parseHash('#p=' + enc({ ...p, r: 'ws://127.0.0.1:8080/ws' }))).toEqual({ ...p, r: 'ws://127.0.0.1:8080/ws' });
    // ws:// to a non-loopback host is rejected (would be cleartext).
    expect(parseHash('#p=' + enc({ ...p, r: 'ws://relay.example/ws' }))).toBeNull();
  });

  it('rejects a room id that is not 16 lowercase hex chars', () => {
    for (const room of ['', 'short', '0123456789ABCDEF', '0123456789abcde', '0123456789abcdefg', '../../etc']) {
      expect(parseHash('#p=' + enc({ ...p, room }))).toBeNull();
    }
  });

  it('rejects an empty code', () => {
    expect(parseHash('#p=' + enc({ ...p, code: '' }))).toBeNull();
  });
});

describe('scrubbedURL (erase the pairing code from the URL)', () => {
  it('strips both ?p= and #p=', () => {
    const blob = encodePayload(p);
    const scrubbed = scrubbedURL(`https://app.example/path?p=${blob}#p=${blob}`);
    expect(scrubbed).toBe('/path');
    // A URL built from the scrubbed result has no search and no hash.
    const u = new URL(scrubbed, 'https://app.example');
    expect(u.search).toBe('');
    expect(u.hash).toBe('');
  });

  it('returns root path for a bare origin', () => {
    expect(scrubbedURL('https://app.example/')).toBe('/');
  });
});
