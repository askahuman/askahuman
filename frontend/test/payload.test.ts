// Unit tests for the surviving payload helpers (code-only pairing): the relay
// URL guard and the room-id contract regex. The deep-link encode/decode and
// hash/query parsers were removed with the old (URL-carried) pairing flow.

import { describe, expect, it } from 'vitest';

import { ROOM_RE, validRelayURL } from '../src/lib/payload.ts';

describe('validRelayURL (guards the WS scheme before opening a socket)', () => {
  it('accepts wss:// and ws://localhost only', () => {
    expect(validRelayURL('wss://relay.example/ws')).toBe(true);
    expect(validRelayURL('ws://localhost:8080/ws')).toBe(true);
    expect(validRelayURL('ws://127.0.0.1:8080/ws')).toBe(true);
  });

  it('rejects ws:// to a non-loopback host (would be cleartext)', () => {
    expect(validRelayURL('ws://relay.example/ws')).toBe(false);
  });

  it('rejects http(s)/javascript/file and non-URL values', () => {
    for (const r of [
      'http://relay.example/ws',
      'https://relay.example/ws',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'not a url',
      '',
    ]) {
      expect(validRelayURL(r)).toBe(false);
    }
  });
});

describe('ROOM_RE (the 16-lowercase-hex room-id contract)', () => {
  it('matches 16 lowercase hex chars', () => {
    expect(ROOM_RE.test('0123456789abcdef')).toBe(true);
  });
  it('rejects wrong length / case / non-hex', () => {
    for (const room of ['', 'short', '0123456789ABCDEF', '0123456789abcde', '0123456789abcdefg', '../../etc']) {
      expect(ROOM_RE.test(room)).toBe(false);
    }
  });
});
