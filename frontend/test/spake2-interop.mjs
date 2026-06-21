// Cross-language interop check: the linchpin of the whole project.
//
// 1. Runs the Go vector generator (backend/cmd/spake2vectors) and parses its
//    deterministic SPAKE2 handshake + secretbox sample.
// 2. Reproduces the handshake in JS (frontend/src/lib/crypto.ts) from the same
//    fixed (code, x_seed, y_seed) and asserts byte-identical M, N, w, T, S, K,
//    sessionKey, confirm MACs.
// 3. JS opens Go's secretbox ciphertext (Go -> JS direction).
// 4. JS seals a message; Go opens it via `spake2vectors --open` (JS -> Go).
//
// Run: node test/spake2-interop.mjs   (exits 0 iff every assertion passes).
// No test framework on purpose: one runnable check, no fixtures.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  Handshake,
  mPoint,
  nPoint,
  passwordScalar,
  seal,
  sealWithNonce,
  open,
} from '../src/lib/crypto.ts';

const here = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(here, '../../backend');

const hex = (b) => Buffer.from(b).toString('hex');
const hexBytes = (s) => Uint8Array.from(Buffer.from(s, 'hex'));
const utf8 = (s) => new TextEncoder().encode(s);

function scalarToBytes(s) {
  const out = new Uint8Array(32);
  let n = s;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

let failures = 0;
function eq(label, got, want) {
  if (got === want) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures++;
  console.error(`  FAIL ${label}\n    got:  ${got}\n    want: ${want}`);
}
function ok(label, cond) {
  if (cond) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures++;
  console.error(`  FAIL ${label}`);
}

function goVectors() {
  const out = execFileSync('go', ['run', './cmd/spake2vectors'], {
    cwd: backendDir,
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

function goOpen(payload) {
  return execFileSync(
    'go',
    ['run', './cmd/spake2vectors', '--open', '--payload', payload],
    { cwd: backendDir, encoding: 'utf8' },
  );
}

console.log('SPAKE2 + secretbox Go<->JS interop');
const v = goVectors();

// --- fixed constants both languages must agree on --------------------------
console.log('fixed constants:');
eq('M', hex(mPoint()), v.M);
eq('N', hex(nPoint()), v.N);
eq('w', hex(scalarToBytes(passwordScalar(v.code))), v.w);

// --- reproduce the handshake in JS from the same fixed inputs --------------
const a = Handshake.newA(v.code);
const b = Handshake.newB(v.code);
const tMsg = a.startDeterministic(hexBytes(v.x_seed));
const sMsg = b.startDeterministic(hexBytes(v.y_seed));

console.log('handshake reproduction:');
eq('T (x*G + w*M)', hex(tMsg), v.T);
eq('S (y*G + w*N)', hex(sMsg), v.S);

const resA = a.finish(sMsg);
const resB = b.finish(tMsg);
eq('K (A side)', hex(a.sharedK()), v.K);
eq('K (B side)', hex(b.sharedK()), v.K);
eq('sessionKey (A)', hex(resA.sessionKey), v.session_key);
eq('sessionKey (B)', hex(resB.sessionKey), v.session_key);
eq('confirm A', hex(resA.confirm), v.confirm_a);
eq('confirm B', hex(resB.confirm), v.confirm_b);
ok('A verifies B confirm', a.confirmPeer(resB.confirm));
ok('B verifies A confirm', b.confirmPeer(resA.confirm));

// --- secretbox: Go -> JS ----------------------------------------------------
console.log('secretbox Go -> JS:');
const key = hexBytes(v.secretbox.key);
const opened = open(key, v.secretbox.ciphertext);
eq('JS opens Go ciphertext', Buffer.from(opened).toString('utf8'), v.secretbox.plaintext);

const reSealed = sealWithNonce(key, hexBytes(v.secretbox.nonce), utf8(v.secretbox.plaintext));
eq('JS reproduces Go ciphertext', reSealed, v.secretbox.ciphertext);

// --- secretbox: JS -> Go ----------------------------------------------------
console.log('secretbox JS -> Go:');
const jsPlain = '{"kind":"decision","id":"req_js","result":{"text":"ship it"}}';
const jsPayload = seal(key, utf8(jsPlain));
const goOpened = goOpen(jsPayload);
eq('Go opens JS ciphertext', goOpened, jsPlain);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nall interop assertions passed');
