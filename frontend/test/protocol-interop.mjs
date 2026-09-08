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
  ack: '14b8621fd371e6acb5130c8aad7b109a2bd87032c7a718d1e134e8b4dca1d9a5',
  decision: '3fe791ce167517dd9e6826040758df157cdd49e7428f47a0e5c3cd0bc25516f7',
  pair: '65deb4c9388c3a8a786c9ba2655a4c6133fa5abe37acd355e944d2bb5abf3295',
  push: '7392ef9d0eab375a3c0a01b9bb337dd1045b04725b2819844fb866657231ed34',
  request: 'b6a91c4aec200f3f5024398344bdd6ff801a18d29d0005f4b1c109b7cbf99df1',
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
