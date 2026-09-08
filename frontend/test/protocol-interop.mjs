// Full v2 wire and identity-bound PAKE interoperability, including signatures
// in both directions. The digest pins make accidental joint contract changes
// visible; changing them requires a protocol decision, not a test refresh.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Handshake } from '../src/lib/crypto.ts';
import { b64Encode } from '../src/lib/b64.ts';
import { signMessage } from '../src/lib/devicekey.ts';
import {
  pairBinding,
  requestSigningMessage,
  boundDecisionSigningMessage,
  ackSigningMessage,
  pushSigningMessage,
  vapidSigningMessage,
  importSigner,
  verify,
} from '../src/lib/protocol.ts';
const cwd = fileURLToPath(new URL('../../backend/', import.meta.url));
const vector = JSON.parse(
  execFileSync('go', ['run', './cmd/protocolvectors'], {
    cwd,
    encoding: 'utf8',
  }),
);
const messages = {
  request: requestSigningMessage(vector.request),
  decision: boundDecisionSigningMessage(vector.decision),
  ack: ackSigningMessage(vector.ack),
  push: pushSigningMessage(vector.push),
  vapid: vapidSigningMessage(vector.vapid),
  pair: pairBinding(
    vector.request.room,
    vector.agent_signer,
    vector.phone_signer,
  ),
};
const pins = {
  ack: '45a3182d80de566e724f12376a4d6b57fde67383b27e81f0efc6528ccb3139f4',
  decision: '5ceb7c0ba988574dc661d180c84be7ebbe0409d55dd63ced604fff29a55f9e8c',
  pair: '65deb4c9388c3a8a786c9ba2655a4c6133fa5abe37acd355e944d2bb5abf3295',
  push: 'dbed1491e38c50be6cf6bae18b867b1c69aa9c54ef50897ebbc07ccb6f600336',
  request: 'a6e8779a967c6b02a9e64b8ef6a2ac1f4ae4c902ee2c34177de5907dc74bf951',
  vapid: '273633315ef5b4cd4d163fae9584e530b4efd704439f06033232ad2d0541700c', // gitleaks:allow public SHA-256 transcript digest
};
for (const [name, bytes] of Object.entries(messages)) {
  assert.equal(
    Buffer.from(bytes).toString('hex'),
    vector.messages[name],
    `${name}: Go/TS bytes`,
  );
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    pins[name],
    `${name}: pinned digest`,
  );
}
const agent = await importSigner(vector.agent_signer),
  phone = await importSigner(vector.phone_signer);
for (const name of ['request', 'decision', 'ack', 'push', 'vapid'])
  assert.equal(
    await verify(
      ['decision', 'push'].includes(name) ? phone : agent,
      messages[name],
      vector[name].sig,
    ),
    true,
    `${name}: JS verifies Go`,
  );
const kp = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  false,
  ['sign', 'verify'],
);
const signatures = {};
for (const [name, msg] of Object.entries(messages))
  signatures[name] = await signMessage(kp.privateKey, msg);
const signer = b64Encode(
  new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey)),
);
assert.match(
  execFileSync('go', ['run', './cmd/protocolvectors', '--verify'], {
    cwd,
    encoding: 'utf8',
    input: JSON.stringify({ signer, signatures }),
  }),
  /Go verified/,
);
const a = Handshake.newA('0123456789'),
  b = Handshake.newB('0123456789');
const ap = a.startDeterministic(new Uint8Array(64).fill(17)),
  bp = b.startDeterministic(new Uint8Array(64).fill(34));
const ar = a.finish(bp, messages.pair),
  br = b.finish(ap, messages.pair);
assert.equal(Buffer.from(ar.sessionKey).toString('hex'), vector.session_key);
assert.equal(Buffer.from(br.sessionKey).toString('hex'), vector.session_key);
assert.equal(Buffer.from(ar.confirm).toString('hex'), vector.confirm_a);
assert.equal(Buffer.from(br.confirm).toString('hex'), vector.confirm_b);
assert.ok(a.confirmPeer(br.confirm));
assert.ok(b.confirmPeer(ar.confirm));
console.log(
  'v2 Go ↔ TypeScript: six canonical transcripts, pinned digests, both signature directions and identity-bound PAKE passed',
);
