import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateAudit } from './audit-dependencies.mjs';

const id = 'GHSA-2pvr-wf23-7pc7';
const high = { title: 'Test advisory', severity: 'high', url: 'https://github.com/advisories/' + id };
const exception = { id, reason: 'Only static output is served.', expires: '2026-12-01' };
const now = new Date('2026-09-07T00:00:00Z');
const evaluate = (data, status = 1, exceptions = []) => evaluateAudit(JSON.stringify(data), status, exceptions, now);

test('a completed empty audit is clean', () => {
  assert.deepEqual(evaluate({}, 0), { findings: [], blocked: [], suppressed: [] });
});
test('empty, truncated, and unexpected reports fail closed', () => {
  for (const output of ['', '{', 'null', '[]', '"network error"', '{"error":"registry unavailable"}']) {
    assert.throws(() => evaluateAudit(output, 1));
  }
});
test('abnormal exit and inconsistent status/report fail closed', () => {
  for (const status of [null, 2, 127, undefined]) assert.throws(() => evaluate({}, status));
  assert.throws(() => evaluate({}, 1));
  assert.throws(() => evaluate({ pkg: [high] }, 0));
});
test('malformed entries and unknown severities cannot disappear from policy', () => {
  for (const item of [null, {}, { ...high, severity: 'unknown' }, { ...high, title: '' }, { ...high, url: 'not a URL' }]) {
    assert.throws(() => evaluate({ pkg: [item] }));
  }
});
test('unexcepted high and critical findings block; moderate remains visible', () => {
  const result = evaluate({ pkg: [high, { ...high, severity: 'critical' }, { ...high, severity: 'moderate' }] });
  assert.equal(result.findings.length, 3);
  assert.equal(result.blocked.length, 2);
});
test('a documented unexpired exact advisory can be excepted', () => {
  const result = evaluate({ pkg: [high] }, 1, [exception]);
  assert.equal(result.suppressed.length, 1);
  assert.equal(result.blocked.length, 0);
});
test('an advisory ID embedded in another URL does not match', () => {
  for (const url of [
    'https://example.invalid/advisories/' + id,
    high.url + '?other=1', high.url + '#fragment',
    'https://user@github.com/advisories/' + id,
    'https://github.com/other/' + id,
  ]) assert.equal(evaluate({ pkg: [{ ...high, url }] }, 1, [exception]).blocked.length, 1);
});
test('expired, malformed, duplicate, and unexplained exceptions fail closed', () => {
  for (const entries of [
    [{ ...exception, expires: '2026-09-06' }],
    [{ ...exception, expires: '2026-02-31' }],
    [{ ...exception, reason: '' }],
    [{ ...exception, id: '*' }], [exception, exception], {},
  ]) assert.throws(() => evaluate({ pkg: [high] }, 1, entries));
});
