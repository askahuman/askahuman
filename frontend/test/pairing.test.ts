import { describe, expect, it } from 'vitest';
import { Handshake } from '../src/lib/crypto.ts';
import { Pairing } from '../src/lib/pairing.ts';
import { b64Encode, b64Decode } from '../src/lib/b64.ts';
import { pairBinding, strictJSON, PROTOCOL } from '../src/lib/protocol.ts';
import { makeSigner } from './protocol-fixture.ts';
const room = '0123456789abcdef';
async function setup(phoneCode = 'CODE', agentCode = phoneCode) {
  const phone = await makeSigner(),
    agent = await makeSigner(),
    hs = Handshake.newA(agentCode),
    point = hs.start();
  const sent: { pake: string[]; confirm: string[] } = { pake: [], confirm: [] };
  let error: Error | undefined,
    key: Uint8Array | undefined,
    pinned: string | undefined;
  const pairing = new Pairing(
    phoneCode,
    {
      sendPake: (p) => {
        sent.pake.push(p);
        return true;
      },
      sendConfirm: (c) => {
        sent.confirm.push(c);
        return true;
      },
    },
    {
      onError: (e) => {
        error = e;
      },
      onPaired: (k, s) => {
        key = k;
        pinned = s;
      },
    },
    { room, signer: phone.spkiB64 },
  );
  const hello = (
    signer = agent.spkiB64,
    pake = b64Encode(point),
    protocol = PROTOCOL,
  ) =>
    b64Encode(
      new TextEncoder().encode(JSON.stringify({ protocol, pake, signer })),
    );
  const finish = () => {
    const h = strictJSON(b64Decode(sent.pake[0]!)) as {
      pake: string;
      signer: string;
    };
    return hs.finish(
      b64Decode(h.pake),
      pairBinding(room, agent.spkiB64, h.signer),
    );
  };
  return {
    phone,
    agent,
    hs,
    pairing,
    sent,
    hello,
    finish,
    error: () => error,
    key: () => key,
    pinned: () => pinned,
  };
}
describe('v2 password-authenticated signing identities', () => {
  it('pairs only after mutual confirmation and pins the authenticated signer', async () => {
    const p = await setup();
    p.pairing.start();
    const a = p.finish();
    await p.pairing.onPeerPake(p.hello());
    expect(p.key()).toBeUndefined();
    expect(p.hs.confirmPeer(b64Decode(p.sent.confirm[0]!))).toBe(true);
    p.pairing.onPeerConfirm(b64Encode(a.confirm));
    expect(p.key()).toEqual(a.sessionKey);
    expect(p.pinned()).toBe(p.agent.spkiB64);
    expect(p.pairing.currentPhase()).toBe('paired');
  });
  it('buffers a peer confirm that races ahead of asynchronous public-key import', async () => {
    const p = await setup();
    p.pairing.start();
    const a = p.finish();
    const pending = p.pairing.onPeerPake(p.hello());
    p.pairing.onPeerConfirm(b64Encode(a.confirm));
    await pending;
    expect(p.pairing.currentPhase()).toBe('paired');
  });
  it('resends the same hello and ignores duplicates without re-randomizing', async () => {
    const p = await setup();
    p.pairing.start();
    p.pairing.start();
    expect(p.sent.pake[0]).toBe(p.sent.pake[1]);
    const a = p.finish();
    await Promise.all([
      p.pairing.onPeerPake(p.hello()),
      p.pairing.onPeerPake(p.hello()),
    ]);
    expect(p.sent.confirm).toHaveLength(1);
    p.pairing.onPeerConfirm(b64Encode(a.confirm));
    expect(p.pairing.currentPhase()).toBe('paired');
  });
  it('rejects the wrong code', async () => {
    const p = await setup('WRONG', 'RIGHT');
    p.pairing.start();
    const a = p.finish();
    await p.pairing.onPeerPake(p.hello());
    p.pairing.onPeerConfirm(b64Encode(a.confirm));
    expect(p.pairing.currentPhase()).toBe('failed');
    expect(p.key()).toBeUndefined();
  });
  it('rejects agent-identity substitution even though both messages contain valid P-256 keys', async () => {
    const p = await setup(),
      thief = await makeSigner();
    p.pairing.start();
    const a = p.finish();
    await p.pairing.onPeerPake(p.hello(thief.spkiB64));
    p.pairing.onPeerConfirm(b64Encode(a.confirm));
    expect(p.pairing.currentPhase()).toBe('failed');
    expect(p.key()).toBeUndefined();
  });
  it('rejects phone-identity substitution through the transcript confirmation', async () => {
    const p = await setup(),
      thief = await makeSigner();
    p.pairing.start();
    const h = strictJSON(b64Decode(p.sent.pake[0]!)) as { pake: string };
    const a = p.hs.finish(
      b64Decode(h.pake),
      pairBinding(room, p.agent.spkiB64, thief.spkiB64),
    );
    await p.pairing.onPeerPake(p.hello());
    p.pairing.onPeerConfirm(b64Encode(a.confirm));
    expect(p.pairing.currentPhase()).toBe('failed');
  });
  it('rejects legacy, downgraded and malformed hellos with repair instructions', async () => {
    for (const kind of [
      'legacy',
      'v1',
      'invalid point',
      'invalid signer',
      'duplicate protocol',
    ]) {
      const p = await setup();
      p.pairing.start();
      let hello = p.hello();
      if (kind === 'legacy') hello = b64Encode(new Uint8Array(32));
      if (kind === 'v1') hello = p.hello(p.agent.spkiB64, undefined, 1);
      if (kind === 'invalid point')
        hello = p.hello(
          p.agent.spkiB64,
          b64Encode(new Uint8Array(32).fill(255)),
        );
      if (kind === 'invalid signer') hello = p.hello('AAAA');
      if (kind === 'duplicate protocol')
        hello = b64Encode(
          new TextEncoder().encode(
            new TextDecoder()
              .decode(b64Decode(hello))
              .replace('"protocol":2', '"protocol":1,"protocol":2'),
          ),
        );
      await p.pairing.onPeerPake(hello);
      expect(p.pairing.currentPhase()).toBe('failed');
      expect(p.error()?.message).toContain('start_pairing with reset:true');
      expect(p.key()).toBeUndefined();
    }
  });
  it('cannot start without an established device signing identity', () => {
    let writes = 0;
    const p = new Pairing('CODE', {
      sendPake: () => {
        writes++;
        return true;
      },
      sendConfirm: () => true,
    });
    p.start();
    expect(writes).toBe(0);
    expect(p.currentPhase()).toBe('failed');
  });
});
