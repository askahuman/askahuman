// Unit tests for the wire mirror: frame parse/classify + app message decode.

import { describe, expect, it } from 'vitest';

import {
  decisionSigningMessage,
  decodeDecision,
  decodeDeviceKey,
  decodeRequest,
  encodeDecision,
  encodeDeviceKey,
  isRelayControl,
  newChoiceDecision,
  newTextDecision,
  newYesNoDecision,
  parseFrame,
  validCategory,
  validMessageKind,
  validResponseKind,
} from '../src/lib/wire.ts';

/** hex renders bytes as lowercase hex so a pinned message can be compared to
 *  the Go twin (backend/pkg/wire/wire_test.go) byte-for-byte. */
function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('parseFrame', () => {
  it('parses a relay control frame', () => {
    const f = parseFrame('{"_relay":"peer_joined"}');
    expect(f).not.toBeNull();
    expect(isRelayControl(f!)).toBe(true);
    expect(f!._relay).toBe('peer_joined');
  });

  it.each([
    ['{"pake":"AAA="}', 'pake'],
    ['{"confirm":"BBB="}', 'confirm'],
    ['{"box":"CCC="}', 'box'],
  ])('classifies app frame %s as not-control', (raw, key) => {
    const f = parseFrame(raw);
    expect(f).not.toBeNull();
    expect(isRelayControl(f!)).toBe(false);
    expect((f as Record<string, unknown>)![key]).toBeTypeOf('string');
  });

  it('rejects an unknown _relay value as non-control', () => {
    const f = parseFrame('{"_relay":"bogus"}');
    expect(isRelayControl(f!)).toBe(false);
  });

  it('returns null on malformed JSON or non-object', () => {
    expect(parseFrame('not json')).toBeNull();
    expect(parseFrame('42')).toBeNull();
    expect(parseFrame('null')).toBeNull();
  });
});

describe('enum validators (mirror pkg/wire)', () => {
  it('validates message/response kinds', () => {
    expect(validMessageKind('request')).toBe(true);
    expect(validMessageKind('nope')).toBe(false);
    expect(validResponseKind('yesno')).toBe(true);
    expect(validResponseKind('choice')).toBe(true);
    expect(validResponseKind('text')).toBe(true);
    expect(validResponseKind('swipe')).toBe(false);
  });
  it('validates known categories', () => {
    for (const cat of ['cash', 'deploy', 'data', 'access', 'other']) {
      expect(validCategory(cat)).toBe(true);
    }
    expect(validCategory('whatever')).toBe(false);
  });
});

describe('decodeRequest', () => {
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

  it('decodes a valid yesno request', () => {
    const req = decodeRequest(
      enc({ kind: 'request', id: 'req_1', title: 'T', summary: 'S', response: { kind: 'yesno' } }),
    );
    expect(req.id).toBe('req_1');
    expect(req.response.kind).toBe('yesno');
  });

  it('rejects a decision masquerading as a request', () => {
    expect(() => decodeRequest(enc({ kind: 'decision', id: 'x' }))).toThrow(/not a request/);
  });
  it('rejects a request missing id', () => {
    expect(() => decodeRequest(enc({ kind: 'request', title: 'T', response: { kind: 'yesno' } }))).toThrow(
      /request id missing/,
    );
  });
  it('rejects an invalid response kind', () => {
    expect(() =>
      decodeRequest(enc({ kind: 'request', id: 'a', title: 'T', summary: 'S', response: { kind: 'nope' } })),
    ).toThrow(/response kind/);
  });
});

describe('decision builders', () => {
  it('builds yesno/choice/text decisions matching pkg/wire shape', () => {
    expect(JSON.parse(new TextDecoder().decode(encodeDecision(newYesNoDecision('id1', true))))).toEqual({
      kind: 'decision',
      id: 'id1',
      result: { approved: true },
    });
    expect(newChoiceDecision('id2', 'Proceed').result).toEqual({ choice: 'Proceed' });
    expect(newTextDecision('id3', 'hi').result).toEqual({ text: 'hi' });
  });
});

describe('encodeDecision padding (privacy: no length leak)', () => {
  it('seals approve and decline of the same id to identical length', () => {
    const approve = encodeDecision(newYesNoDecision('req_8f3a', true));
    const decline = encodeDecision(newYesNoDecision('req_8f3a', false));
    expect(approve.length).toBe(decline.length);
    expect(approve.length % 256).toBe(0);
  });
  it('padded plaintext still decodes (trailing whitespace ignored)', () => {
    const d = decodeDecision(encodeDecision(newYesNoDecision('req_8f3a', true)));
    expect(d.result.approved).toBe(true);
    expect(d.id).toBe('req_8f3a');
  });
});

describe('decodeDecision validation', () => {
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
  it('rejects a request masquerading as a decision', () => {
    expect(() => decodeDecision(enc({ kind: 'request', id: 'x' }))).toThrow(/not a decision/);
  });
  it('rejects a missing id and an over-long id', () => {
    expect(() => decodeDecision(enc({ kind: 'decision', result: {} }))).toThrow(/decision id missing/);
    expect(() => decodeDecision(enc({ kind: 'decision', id: 'a'.repeat(300), result: {} }))).toThrow(/id too long/);
  });
  it('rejects a non-boolean approved', () => {
    expect(() => decodeDecision(enc({ kind: 'decision', id: 'a', result: { approved: 'yes' } }))).toThrow(
      /approved must be boolean/,
    );
  });
});

describe('decodeRequest bounded validation', () => {
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
  const base = { kind: 'request', id: 'a', title: 'T', summary: 'S' };
  it('rejects too many options', () => {
    expect(() =>
      decodeRequest(enc({ ...base, response: { kind: 'choice', options: Array(40).fill('x') } })),
    ).toThrow(/options/);
  });
  it('rejects out-of-bounds expires_in_s', () => {
    expect(() => decodeRequest(enc({ ...base, response: { kind: 'yesno' }, expires_in_s: 999999 }))).toThrow(
      /expires_in_s/,
    );
  });
});

describe('decisionSigningMessage (cross-language byte contract)', () => {
  // These hex strings are pinned IDENTICALLY in backend/pkg/wire/wire_test.go
  // (TestDecisionSigningMessagePinsHex) so the Go and TS signers can never
  // drift. Any change here MUST change there too. See ADR 0021.
  const room = '0123456789abcdef';
  const id = 'req_1';
  it.each([
    ['yesno true', { approved: true }, '6161683a6465636973696f6e3a76310030313233343536373839616263646566007265715f31007965736e6f3a31'],
    ['yesno false', { approved: false }, '6161683a6465636973696f6e3a76310030313233343536373839616263646566007265715f31007965736e6f3a30'],
    ['choice', { choice: 'Merge & retry' }, '6161683a6465636973696f6e3a76310030313233343536373839616263646566007265715f310063686f6963653a4d657267652026207265747279'],
    ['text', { text: 'up to $500' }, '6161683a6465636973696f6e3a76310030313233343536373839616263646566007265715f3100746578743a757020746f2024353030'],
  ] as const)('pins the canonical message bytes for %s', (_name, result, wantHex) => {
    expect(hex(decisionSigningMessage(room, id, result))).toBe(wantHex);
  });
});

describe('device_key wire message', () => {
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
  it('round-trips encodeDeviceKey/decodeDeviceKey padded', () => {
    const spki = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-example-spki';
    const raw = encodeDeviceKey(spki);
    expect(raw.length % 256).toBe(0); // padded like every sealed encoder
    const dk = decodeDeviceKey(raw);
    expect(dk.kind).toBe('device_key');
    expect(dk.public_key).toBe(spki);
  });
  it('rejects a non-device_key kind and a missing public_key', () => {
    expect(() => decodeDeviceKey(enc({ kind: 'vapid_key', public_key: 'x' }))).toThrow(/not a device_key/);
    expect(() => decodeDeviceKey(enc({ kind: 'device_key' }))).toThrow(/public_key missing/);
  });
});

describe('decodeDecision sig tolerance + cap', () => {
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
  it('accepts a decision with a sig and without one', () => {
    const withSig = decodeDecision(enc({ kind: 'decision', id: 'a', result: { approved: true }, sig: 'AAAA' }));
    expect(withSig.sig).toBe('AAAA');
    const without = decodeDecision(enc({ kind: 'decision', id: 'a', result: { approved: true } }));
    expect(without.sig).toBeUndefined();
  });
  it('rejects an over-long sig', () => {
    expect(() =>
      decodeDecision(enc({ kind: 'decision', id: 'a', result: { approved: true }, sig: 'a'.repeat(300) })),
    ).toThrow(/sig too long/);
  });
});
