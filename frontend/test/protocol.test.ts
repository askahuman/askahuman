import { describe, expect, it } from 'vitest';
import {
  scalarLength,
  clampScalars,
  strictJSON,
  validateRequest,
  validateDecision,
  requestHash,
  requestSigningMessage,
  MAX_PLAINTEXT,
} from '../src/lib/protocol.ts';
import { encodeRequest, type Request, type Decision } from '../src/lib/wire.ts';
const utf8 = (s: string) => new TextEncoder().encode(s);
const request = (): Request => ({
  kind: 'request',
  protocol: 2,
  room: '0123456789abcdef',
  id: 'r1',
  title: 'T',
  summary: 'S',
  response: { kind: 'text', max_len: 4096 },
  deadline_ms: 0,
});
describe('shared Unicode and encoded transport bounds', () => {
  it('counts Unicode scalars without splitting surrogate pairs or normalizing text', () => {
    expect(scalarLength('😀e\u0301🧭')).toBe(4);
    expect(clampScalars('😀e\u0301🧭', 3)).toBe('😀e\u0301');
    expect(() => scalarLength('\ud800')).toThrow();
    expect(() => scalarLength('\udfff')).toThrow();
    const r = request();
    r.id = '😀'.repeat(256);
    r.title = '😀'.repeat(512);
    r.agent = '😀'.repeat(256);
    r.summary = 'a'.repeat(4096);
    expect(() => validateRequest(r)).not.toThrow();
    r.summary = '😀'.repeat(4096);
    expect(() => validateRequest(r)).toThrow(/size/);
    r.summary = '\x01'.repeat(3000);
    expect(() => validateRequest(r)).toThrow(/size/);
  });
  it.each(['id', 'title', 'summary', 'agent'] as const)(
    'rejects an extra scalar beyond the %s bound',
    (field) => {
      const bounds = { id: 256, title: 512, summary: 4096, agent: 256 };
      const r = request();
      r[field] = 'a'.repeat(bounds[field] + 1);
      expect(() => validateRequest(r)).toThrow();
    },
  );
  it('rejects irrelevant response fields, duplicate or empty choices and invalid limits', () => {
    for (const response of [
      { kind: 'yesno', max_len: 0 },
      { kind: 'text', options: [] },
      { kind: 'choice', options: [] },
      { kind: 'choice', options: ['x', 'x'] },
      { kind: 'choice', options: [''] },
      { kind: 'text', max_len: 4097 },
      { kind: 'text', max_len: -1 },
    ] as Request['response'][]) {
      expect(() => validateRequest({ ...request(), response })).toThrow();
    }
    expect(() =>
      validateRequest({ ...request(), expires_in_s: 86401 }),
    ).toThrow();
  });
  it('pads UTF-8 bytes rather than UTF-16 units and never exceeds the frame budget', () => {
    const r = request();
    r.summary = '😀'.repeat(100);
    const encoded = encodeRequest(r);
    expect(encoded.length % 256).toBe(0);
    expect(encoded.length).toBeLessThanOrEqual(MAX_PLAINTEXT);
    expect(strictJSON(encoded)).toEqual(r);
    r.summary = '😀'.repeat(4096);
    expect(() => encodeRequest(r)).toThrow();
  });
  it('binds distinct Unicode representations and delimiter placements distinctly', () => {
    const r = request();
    r.title = 'é';
    const d = requestHash(r);
    r.title = 'e\u0301';
    expect(requestHash(r)).not.toBe(d);
    const a = request();
    a.id = 'x\0y';
    a.title = 'z';
    const b = request();
    b.id = 'x';
    b.title = 'y\0z';
    expect(requestSigningMessage(a)).not.toEqual(requestSigningMessage(b));
  });
  it('retains empty text and false while rejecting every unrelated result field', () => {
    const base: Decision = {
      kind: 'decision',
      protocol: 2,
      room: '0123456789abcdef',
      id: 'id',
      request_hash: 'A'.repeat(43) + '=',
      response_kind: 'yesno',
      result: { approved: false },
    };
    expect(() => validateDecision(base)).not.toThrow();
    expect(() =>
      validateDecision({ ...base, response_kind: 'text', result: {} }),
    ).not.toThrow();
    for (const result of [
      { approved: false, text: '' },
      { approved: false, choice: 'x' },
      { text: 'x', approved: false },
      { Approved: false },
      { approved: null },
    ]) {
      expect(() =>
        validateDecision({ ...base, result: result as Decision['result'] }),
      ).toThrow();
    }
  });
});
describe('strict encrypted JSON admission', () => {
  it.each([
    '{"a":1,"a":2}',
    '{"id":"a","i\\u0064":"b"}',
    '{"x":null}',
    '{"x":"\\ud800"}',
    '{"x":"\\udfff"}',
    '{"x":"\\ud800x"}',
    '{"x":2e0}',
    '{"x":2.0}',
    '{"x":-0}',
    '{"x":9007199254740992}',
    '{} {}',
    '\ufeff{}',
    '{"x":' + '['.repeat(20) + '0' + ']'.repeat(20) + '}',
  ])('rejects parser ambiguity %s', (raw) =>
    expect(() => strictJSON(utf8(raw))).toThrow(),
  );
  it('rejects invalid UTF-8 and accepts paired surrogate escapes and literal escape text', () => {
    expect(() => strictJSON(new Uint8Array([0x22, 0xff, 0x22]))).toThrow();
    expect(
      strictJSON(utf8('{"x":"\\ud83d\\ude00","literal":"\\\\ud800"}')),
    ).toEqual({ x: '😀', literal: '\\ud800' });
    expect(() => strictJSON(utf8(' '.repeat(MAX_PLAINTEXT + 1)))).toThrow();
  });
});
