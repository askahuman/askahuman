import { afterEach, describe, expect, it } from 'vitest';
import { Session, type SessionOptions } from '../src/lib/session.ts';
import type { WSLike } from '../src/lib/relay.ts';
import { seal, open } from '../src/lib/crypto.ts';
import {
  type Request,
  type Decision,
  type PushSubscription,
} from '../src/lib/wire.ts';
import {
  PROTOCOL,
  requestHash,
  decisionHash,
  ackSigningMessage,
  pushSigningMessage,
  verify,
  type Ack,
} from '../src/lib/protocol.ts';
import {
  deviceKeyLoader,
  protocolLedgerLoader,
  makeSigner,
  pairAgent,
  signRequest,
  sendReq,
  sealReq,
  acknowledge,
  decisions,
  sendVapid,
  until,
  settle,
  type TestPeer,
} from './protocol-fixture.ts';

class FakeWS implements WSLike {
  static last: FakeWS | null = null;
  sent: Record<string, unknown>[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(public url: string) {
    FakeWS.last = this;
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.onclose?.({});
  }
  open(): void {
    this.onopen?.(undefined);
  }
  recv(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}
const payload = {
  r: 'wss://relay.example/ws',
  room: 'deadbeefdeadbeef',
  code: 'PAIR-1',
};
const live: Session[] = [];
afterEach(() => {
  for (const s of live.splice(0)) s.close();
});
function newSession(
  extra: SessionOptions = {},
  restored?: ConstructorParameters<typeof Session>[2],
) {
  FakeWS.last = null;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const session = new Session(
    payload,
    {
      deviceKeyLoader,
      protocolLedgerLoader,
      relayOptions: {
        wsFactory: (u) => new FakeWS(u),
        setTimer: (fn, ms) => {
          timers.push({ fn, ms });
          return timers.length - 1;
        },
        clearTimer: () => {},
        heartbeatMs: 0,
      },
      ...extra,
    },
    restored,
  );
  live.push(session);
  session.start();
  return { session, timers };
}
async function paired(extra: SessionOptions = {}) {
  const { session, timers } = newSession(extra);
  const peer = await pairAgent(() => FakeWS.last, payload.code, payload.room);
  await until(() => session.getState().paired);
  return { session, timers, ...peer };
}
const req = (
  id = 'r1',
  response: Request['response'] = { kind: 'yesno' },
): Request => ({
  kind: 'request',
  id,
  title: 'Deploy?',
  summary: 'Deploy the reviewed build to production.',
  agent: 'my agent',
  response,
});
async function rawAck(
  ws: FakeWS,
  peer: TestPeer,
  d: Decision,
  status: Ack['status'] = 'accepted',
  signer = peer.signer,
  patch: Partial<Ack> = {},
) {
  const a: Ack = {
    kind: 'ack',
    protocol: PROTOCOL,
    room: peer.room,
    id: d.id,
    request_hash: d.request_hash!,
    decision_hash: decisionHash(d),
    status,
    sig: '',
    ...patch,
  };
  a.sig = await signer.sign(ackSigningMessage(a));
  ws.recv({ box: seal(peer.key, new TextEncoder().encode(JSON.stringify(a))) });
  await settle();
  return a;
}

describe('authenticated Session protocol', () => {
  it('waits for a verified matching receipt before reporting acceptance', async () => {
    const { session, ws, agentKey } = await paired();
    const r = req();
    await sendReq(ws, agentKey, r);
    expect(session.getState().screen).toBe('yesno');
    session.approve();
    await until(() => decisions(ws, agentKey).length);
    expect(session.getState().screen).toBe('pending');
    expect(session.getState().result).toBeNull();
    const d = await acknowledge(ws, agentKey);
    expect(d.result).toEqual({ approved: true });
    expect(d.request_hash).toBe(requestHash(r));
    expect(session.getState().screen).toBe('confirmed');
    expect(session.getState().result?.label).toBe('Answer received by agent');
    expect(session.getState().request).toBeNull();
  });
  it('preserves signed false, empty text, Unicode, and whitespace exactly', async () => {
    for (const [response, answer, result] of [
      [{ kind: 'yesno' }, (s: Session) => s.decline(), { approved: false }],
      [
        { kind: 'choice', options: ['Stop', 'Go 🧭'] },
        (s: Session) => s.choose('Go 🧭'),
        { choice: 'Go 🧭' },
      ],
      [
        { kind: 'text', max_len: 3 },
        (s: Session) => s.reply('😀😀😀'),
        { text: '😀😀😀' },
      ],
      [{ kind: 'text' }, (s: Session) => s.reply(''), {}],
      [
        { kind: 'text' },
        (s: Session) => s.reply('  yes\n '),
        { text: '  yes\n ' },
      ],
    ] as const) {
      const { session, ws, agentKey } = await paired();
      await sendReq(ws, agentKey, req('r1', response as Request['response']));
      answer(session);
      const d = await acknowledge(ws, agentKey);
      if ('text' in result) expect(d.result.text).toBe(result.text);
      else if (Object.keys(result).length === 0)
        expect(d.result.text ?? '').toBe('');
      else expect(d.result).toEqual(result);
      expect(session.getState().screen).toBe('confirmed');
      session.close();
    }
  });
  it('rejects a copied-session-key attacker changing every displayed request field', async () => {
    const { session, ws, agentKey } = await paired();
    const original = await signRequest(agentKey, {
      ...req(),
      category: 'deploy',
      expires_in_s: 300,
    });
    const changes: Array<(r: Request) => void> = [
      (r) => {
        r.title += ' yes';
      },
      (r) => {
        r.summary = 'Transfer money';
      },
      (r) => {
        r.agent = 'trusted';
      },
      (r) => {
        r.category = 'cash';
      },
      (r) => {
        r.id = 'another';
      },
      (r) => {
        r.room = '0123456789abcdef';
      },
      (r) => {
        r.protocol = 1;
      },
      (r) => {
        r.request_seq! += 1;
      },
      (r) => {
        r.deadline_ms! += 1;
      },
      (r) => {
        r.expires_in_s = 86400;
      },
      (r) => {
        r.response = { kind: 'text', placeholder: 'type yes', max_len: 1 };
      },
    ];
    for (const change of changes) {
      const changed = structuredClone(original);
      change(changed);
      ws.recv({
        box: seal(agentKey, new TextEncoder().encode(JSON.stringify(changed))),
      });
      await settle();
      expect(session.getState().request).toBeNull();
    }
    ws.recv(await sealReq(agentKey, original));
    await until(() => session.getState().request);
    expect(session.getState().request?.summary).toBe(original.summary);
  });
  it('rejects unseen older and equal-conflicting signed requests, including a stale roster after reload', async () => {
    const first = await paired();
    const old = await signRequest(first.agentKey, {
      ...req('older'),
      request_seq: 1,
    });
    const current = await signRequest(first.agentKey, {
      ...req('current'),
      request_seq: 2,
      deadline_ms: Date.now() + 30000,
    });
    await sendReq(first.ws, first.agentKey, current);
    await sendReq(first.ws, first.agentKey, old);
    await sendReq(first.ws, first.agentKey, {
      ...req('equal-conflict'),
      request_seq: 2,
    });
    expect(first.session.getState().request?.id).toBe('current');
    await sendReq(first.ws, first.agentKey, current);
    expect(first.session.getState().request?.deadline_ms).toBe(
      current.deadline_ms,
    );
    const stale = {
      key: first.agentKey,
      ...first.session.persistState(),
      request: old,
    };
    first.session.close();
    const next = newSession({}, stale);
    await until(() => FakeWS.last);
    const ws = FakeWS.last!;
    ws.open();
    expect(next.session.getState().request).toBeNull();
    await sendReq(ws, first.agentKey, old);
    expect(next.session.getState().request).toBeNull();
    await sendReq(ws, first.agentKey, current);
    expect(next.session.getState().request?.id).toBe('current');
    expect(next.session.getState().request?.deadline_ms).toBe(
      current.deadline_ms,
    );
  });
  it('retains repair guidance and opens no socket when the persisted protocol ledger is missing', async () => {
    const first = await paired();
    const saved = { key: first.agentKey, ...first.session.persistState() };
    first.session.close();
    const { session } = newSession(
      {
        protocolLedgerLoader: async () => {
          throw new Error('missing');
        },
      },
      saved,
    );
    await until(() => session.getState().pairError);
    expect(session.getState().paired).toBe(false);
    expect(session.getState().pairError).toContain(
      'start_pairing with reset:true',
    );
    expect(session.getSessionKey()).toEqual(first.agentKey);
    expect(FakeWS.last).toBeNull();
  });
  it('validates durable push membership without allocating a sequence and rejects a forgotten live peer', async () => {
    const first = await paired();
    expect(await first.session.canReconcilePush()).toBe(true);
    expect(await first.session.canReconcilePush()).toBe(true);
    const saved = { key: first.agentKey, ...first.session.persistState() };
    const peer = newSession({}, saved);
    await until(() => peer.session.getState().paired);
    expect(await peer.session.canReconcilePush()).toBe(true);
    const sub = { endpoint: 'https://push.example/synthetic', keys: { p256dh: 'p', auth: 'a' } };
    expect(await first.session.sendPushSubscription(sub)).toBe(true);
    const signed = first.ws.sent.filter((f) => f.box).map((f) => JSON.parse(new TextDecoder().decode(open(first.agentKey, f.box as string))));
    expect(signed.find((m) => m.kind === 'push_sub').push_seq).toBe(1);
    await first.session.forget();
    expect(peer.session.getState().paired).toBe(true);
    expect(await peer.session.canReconcilePush()).toBe(false);
    expect(peer.session.getState().paired).toBe(false);
    expect(peer.session.getState().pairError).toContain('sequence storage');
  });

  it('rejects a closed session after its delayed durable validity read completes', async () => {
    let finish!: () => void;
    const { session } = await paired({ protocolLedgerLoader: async (scope, restored) => {
      if (restored) await new Promise<void>((resolve) => { finish = resolve; });
      return protocolLedgerLoader(scope, restored);
    } });
    const pending = session.canReconcilePush();
    await until(() => finish);
    session.close();
    finish();
    expect(await pending).toBe(false);
  });

  it('exposes delayed and failed durable deletion to native cleanup callers', async () => {
    let finish!: () => void;
    const { session } = await paired({ protocolLedgerLoader: async (scope, restored) => {
      const ledger = await protocolLedgerLoader(scope, restored);
      return { ...ledger, forget: () => new Promise<void>((resolve) => { finish = resolve; }) };
    } });
    let completed = false;
    const pending = session.forget().then(() => { completed = true; });
    await until(() => finish);
    expect(completed).toBe(false);
    expect(await session.canReconcilePush()).toBe(false);
    finish();
    await pending;
    expect(completed).toBe(true);
    const failed = await paired({ protocolLedgerLoader: async (scope, restored) => {
      const ledger = await protocolLedgerLoader(scope, restored);
      return { ...ledger, forget: async () => { throw new Error('storage failed'); } };
    } });
    await expect(failed.session.forget()).rejects.toThrow('storage failed');
  });

  it('reserves push sequences before signing and suppresses an older signing completion', async () => {
    const device = await deviceKeyLoader();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const started = new Promise<void>((r) => {
      entered = r;
    });
    let count = 0;
    const wrapped = {
      spkiB64: device.spkiB64,
      sign: async (msg: Uint8Array<ArrayBuffer>) => {
        if (
          new TextDecoder().decode(msg).includes('aah:push-sub:v2') &&
          ++count === 1
        ) {
          entered();
          await gate;
        }
        return device.sign(msg);
      },
    };
    const { session, ws, agentKey } = await paired({
      deviceKeyLoader: async () => wrapped,
    });
    const sub = (name: string) => ({
      endpoint: `https://web.push.apple.com/${name}`,
      keys: { p256dh: 'p', auth: 'a' },
    });
    const old = session.sendPushSubscription(sub('old'));
    await started;
    expect(await session.sendPushSubscription(sub('new'))).toBe(true);
    release();
    expect(await old).toBe(false);
    const pushes = ws.sent
      .filter((f) => f.box)
      .map((f) =>
        JSON.parse(new TextDecoder().decode(open(agentKey, f.box as string))),
      )
      .filter((m) => m.kind === 'push_sub');
    expect(pushes).toHaveLength(1);
    expect(pushes[0].subscription.endpoint.endsWith('/new')).toBe(true);
    expect(pushes[0].push_seq).toBe(2);
    const saved = { key: agentKey, ...session.persistState() };
    session.close();
    const next = newSession({}, saved);
    await until(() => FakeWS.last);
    FakeWS.last!.open();
    expect(await next.session.sendPushSubscription(sub('reload'))).toBe(true);
    const restoredPush = FakeWS.last!.sent.filter((f) => f.box)
      .map((f) =>
        JSON.parse(new TextDecoder().decode(open(agentKey, f.box as string))),
      )
      .find((m) => m.kind === 'push_sub');
    expect(restoredPush.push_seq).toBe(3);
  });
  it('binds all choice and text schema fields before showing them', async () => {
    for (const response of [
      { kind: 'choice', options: ['Stop', 'Go'] },
      { kind: 'text', placeholder: 'Reason', max_len: 10 },
    ] as Request['response'][]) {
      const { session, ws, agentKey } = await paired();
      const original = await signRequest(agentKey, req('schema', response));
      for (const altered of [
        { kind: 'yesno' },
        { kind: 'choice', options: ['Go', 'Stop'] },
        { kind: 'text', placeholder: 'Approve now', max_len: 4096 },
      ] as Request['response'][]) {
        ws.recv({
          box: seal(
            agentKey,
            new TextEncoder().encode(
              JSON.stringify({ ...original, response: altered }),
            ),
          ),
        });
        await settle();
        expect(session.getState().request).toBeNull();
      }
      session.close();
    }
  });
  it('rejects forged, cross-room, cross-result and cross-request acceptance receipts', async () => {
    const { session, ws, agentKey, peer } = await paired();
    await sendReq(ws, agentKey, req());
    session.approve();
    await until(() => decisions(ws, agentKey).length);
    const d = decisions(ws, agentKey)[0]!,
      attacker = await makeSigner();
    await rawAck(ws, peer, d, 'accepted', attacker);
    expect(session.getState().screen).toBe('pending');
    for (const patch of [
      { room: '0123456789abcdef' },
      { id: 'other' },
      { request_hash: decisionHash(d) },
      { decision_hash: d.request_hash! },
      { protocol: 1 },
    ]) {
      await rawAck(ws, peer, d, 'accepted', peer.signer, patch);
      expect(session.getState().screen).toBe('pending');
    }
    await acknowledge(ws, agentKey);
    expect(session.getState().screen).toBe('confirmed');
  });
  it('retries the exact pending signature without authorizing a second answer', async () => {
    const { session, ws, agentKey } = await paired();
    const r = req();
    await sendReq(ws, agentKey, r);
    session.approve();
    session.decline();
    await until(() => decisions(ws, agentKey).length);
    const first = decisions(ws, agentKey)[0]!;
    expect(decisions(ws, agentKey)).toHaveLength(1);
    await sendReq(ws, agentKey, r);
    await sendReq(ws, agentKey, r);
    await until(() => decisions(ws, agentKey).length >= 3);
    expect(
      decisions(ws, agentKey).every(
        (d) => JSON.stringify(d) === JSON.stringify(first),
      ),
    ).toBe(true);
    expect(session.getState().screen).toBe('pending');
    await acknowledge(ws, agentKey);
    expect(session.getState().screen).toBe('confirmed');
  });
  it('keeps expired or unacknowledged answers distinct from success', async () => {
    for (const status of ['expired', 'unknown'] as const) {
      const { session, ws, agentKey } = await paired();
      await sendReq(ws, agentKey, req());
      session.approve();
      await acknowledge(ws, agentKey, status);
      expect(session.getState().screen).toBe('pending');
      expect(session.getState().result).toBeNull();
      expect(session.getState().delivery).toBe(
        status === 'expired' ? 'expired' : 'uncertain',
      );
      // The UI's absolute-deadline ticker and later re-announcements cannot
      // erase an authenticated terminal receipt.
      session.expire('r1');
      expect(session.getState().delivery).toBe(
        status === 'expired' ? 'expired' : 'uncertain',
      );
      session.close();
    }
  });
  it('preserves pending answer and fixed deadline across page reload', async () => {
    const first = await paired();
    const r = { ...req(), deadline_ms: Date.now() + 30000 };
    await sendReq(first.ws, first.agentKey, r);
    first.session.decline();
    await until(() => decisions(first.ws, first.agentKey).length);
    const saved = { key: first.agentKey, ...first.session.persistState() };
    const pending = decisions(first.ws, first.agentKey)[0]!;
    first.session.close();
    const { session } = newSession({}, saved);
    await until(() => FakeWS.last);
    const ws = FakeWS.last!;
    ws.open();
    await until(() => decisions(ws, first.agentKey).length);
    expect(session.getState().screen).toBe('pending');
    expect(session.getState().request?.deadline_ms).toBe(r.deadline_ms);
    expect(decisions(ws, first.agentKey)[0]).toEqual(pending);
    await acknowledge(ws, first.agentKey);
    expect(session.getState().result?.approved).toBe(false);
  });
  it('preserves an unanswered card across reconnect and reload without resetting its deadline', async () => {
    let now = Date.now();
    const first = await paired({ now: () => now });
    const r = { ...req(), deadline_ms: now + 2000 };
    await sendReq(first.ws, first.agentKey, r);
    first.ws.recv({ _relay: 'peer_left' });
    expect(first.session.getState().screen).toBe('offline');
    now += 1000;
    first.ws.recv({ _relay: 'peer_joined' });
    expect(first.session.getState().screen).toBe('offline');
    await sendReq(first.ws, first.agentKey, r);
    expect(first.session.getState().screen).toBe('yesno');
    expect(first.session.getState().request?.deadline_ms).toBe(r.deadline_ms);
    const saved = { key: first.agentKey, ...first.session.persistState() };
    first.session.close();
    const { session } = newSession({ now: () => now }, saved);
    await until(() => FakeWS.last);
    FakeWS.last!.open();
    expect(session.getState().request?.deadline_ms).toBe(r.deadline_ms);
    now += 2000;
    session.approve();
    expect(session.getState().request).toBeNull();
    expect(decisions(FakeWS.last!, first.agentKey)).toHaveLength(0);
    now -= 60000;
    await sendReq(FakeWS.last!, first.agentKey, r);
    expect(session.getState().request).toBeNull();
  });
  it('does not reopen a locally expired request when the clock moves backward, including after reload', async () => {
    let now = Date.now();
    const first = await paired({ now: () => now });
    const r = { ...req(), deadline_ms: now + 1000 };
    await sendReq(first.ws, first.agentKey, r);
    now += 2000;
    first.session.approve();
    expect(first.session.getState().request).toBeNull();
    expect(decisions(first.ws, first.agentKey)).toHaveLength(0);
    now -= 60000;
    await sendReq(first.ws, first.agentKey, r);
    expect(first.session.getState().request).toBeNull();
    const saved = { key: first.agentKey, ...first.session.persistState() };
    first.session.close();
    const { session } = newSession({ now: () => now }, saved);
    await until(() => FakeWS.last);
    const ws = FakeWS.last!;
    ws.open();
    await sendReq(ws, first.agentKey, r);
    expect(session.getState().request).toBeNull();
    expect(decisions(ws, first.agentKey)).toHaveLength(0);
  });
  it('keeps a too-large encoded Unicode answer editable and unsent', async () => {
    const { session, ws, agentKey } = await paired();
    await sendReq(ws, agentKey, req('huge', { kind: 'text', max_len: 4096 }));
    session.reply('😀'.repeat(4096));
    await settle();
    expect(session.getState().screen).toBe('text');
    expect(session.getState().answerError).toContain('too large');
    expect(decisions(ws, agentKey)).toHaveLength(0);
    expect(Object.keys(session.persistState().decisions ?? {})).toHaveLength(0);
    session.reply('\u0001'.repeat(4096));
    await settle();
    expect(session.getState().screen).toBe('text');
    expect(session.getState().answerError).toContain('too large');
    expect(Object.keys(session.persistState().decisions ?? {})).toHaveLength(0);
  });
  it('checks expiry again after asynchronous device signing', async () => {
    let now = Date.now(),
      release: () => void = () => {};
    const device = await deviceKeyLoader();
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const wrapped = {
      ...device,
      sign: async (msg: Uint8Array<ArrayBuffer>) => {
        if (new TextDecoder().decode(msg).includes('aah:decision:v2'))
          await gate;
        return device.sign(msg);
      },
    };
    const { session, ws, agentKey } = await paired({
      now: () => now,
      deviceKeyLoader: async () => wrapped,
    });
    await sendReq(ws, agentKey, { ...req(), deadline_ms: now + 10 });
    session.approve();
    expect(session.getState().delivery).toBe('signing');
    now += 20;
    release();
    await settle();
    expect(decisions(ws, agentKey)).toHaveLength(0);
    expect(session.getState().request).toBeNull();
  });
  it('does not retain or send a decision after closing during the final ledger read', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const started = new Promise<void>((r) => {
      entered = r;
    });
    let reads = 0;
    const { session, ws, agentKey } = await paired({
      protocolLedgerLoader: async (scope, restored) => {
        const ledger = await protocolLedgerLoader(scope, restored);
        return {
          ...ledger,
          currentRequest: async (seq, digest) => {
            const valid = await ledger.currentRequest(seq, digest);
            if (++reads === 2) {
              entered();
              await gate;
            }
            return valid;
          },
        };
      },
    });
    await sendReq(ws, agentKey, req());
    session.approve();
    await started;
    session.close();
    release();
    await settle();
    expect(decisions(ws, agentKey)).toHaveLength(0);
    expect(session.persistState().decisions).toEqual({});
  });
  it('never submits a deferred answer after the request cleared or session closed', async () => {
    const { session, ws, agentKey } = await paired();
    await sendReq(ws, agentKey, req());
    session.expire('r1');
    session.approve();
    session.decline();
    session.choose('x');
    session.reply('y');
    await settle();
    expect(decisions(ws, agentKey)).toHaveLength(0);
    session.close();
    await settle();
    expect(decisions(ws, agentKey)).toHaveLength(0);
  });
  it('does not let an expired re-announcement reopen a card', async () => {
    const { session, ws, agentKey } = await paired();
    const r = req();
    await sendReq(ws, agentKey, r);
    session.expire(r.id);
    ws.recv({ _relay: 'peer_left' });
    ws.recv({ _relay: 'peer_joined' });
    await sendReq(ws, agentKey, r);
    expect(session.getState().request).toBeNull();
  });
  it('keeps a dropped decision write uncertain and retries the same answer on reconnect', async () => {
    const { session, ws, agentKey, timers } = await paired();
    await sendReq(ws, agentKey, req());
    ws.close();
    session.approve();
    await settle();
    expect(session.getState().screen).toBe('pending');
    expect(session.getState().delivery).toBe('uncertain');
    expect(session.getState().result).toBeNull();
    timers[0]!.fn();
    const fresh = FakeWS.last!;
    fresh.open();
    await until(() => decisions(fresh, agentKey).length);
    await acknowledge(fresh, agentKey);
    expect(session.getState().screen).toBe('confirmed');
  });
  it('drops unauthenticated, duplicate-key and malformed Unicode requests', async () => {
    const { session, ws, agentKey } = await paired();
    const r = await signRequest(agentKey, req());
    const raw = JSON.stringify(r);
    for (const text of [
      raw.replace('"title":', '"title":"different","title":'),
      raw.replace('"title":"Deploy?"', '"title":"\\ud800"'),
      raw.replace('"protocol":2', '"protocol":2e0'),
    ]) {
      ws.recv({ box: seal(agentKey, new TextEncoder().encode(text)) });
      await settle();
      expect(session.getState().request).toBeNull();
    }
    ws.recv({ box: seal(new Uint8Array(32), new TextEncoder().encode(raw)) });
    await settle();
    expect(session.getState().request).toBeNull();
  });
  it('requires the paired agent identity for VAPID updates', async () => {
    const keys: string[] = [];
    const { session, ws, agentKey } = await paired({
      onVapidKey: (v) => keys.push(v),
    });
    ws.recv({
      box: seal(
        agentKey,
        new TextEncoder().encode(
          JSON.stringify({
            kind: 'vapid_key',
            protocol: 2,
            room: payload.room,
            public_key: 'attacker',
            sig: '',
          }),
        ),
      ),
    });
    await settle();
    expect(keys).toEqual([]);
    await sendVapid(ws, agentKey, 'real-public-key');
    expect(keys).toEqual(['real-public-key']);
    expect(session.getVapidKey()).toBe('real-public-key');
  });
  it('device-signs subscriptions and reports asynchronous delivery failure', async () => {
    const { session, ws, agentKey, peer } = await paired();
    const sub: PushSubscription = {
      endpoint: 'https://web.push.apple.com/sub',
      keys: { p256dh: 'a', auth: 'b' },
    };
    expect(await session.sendPushSubscription(sub)).toBe(true);
    const ps = JSON.parse(
      new TextDecoder().decode(
        open(
          agentKey,
          ws.sent.find((f) => typeof f.box === 'string')!.box as string,
        ),
      ),
    );
    expect(await verify(peer.phone, pushSigningMessage(ps), ps.sig)).toBe(true);
    expect(ps.subscription).toEqual(sub);
    session.close();
    expect(await session.sendPushSubscription(sub)).toBe(false);
  });
  it('fails closed when secure signing is unavailable', async () => {
    const { session } = newSession({ deviceKeyLoader: async () => null });
    await until(() => session.getState().pairError);
    expect(FakeWS.last).toBeNull();
    expect(session.getState().paired).toBe(false);
    expect(session.getState().pairError).toContain(
      'start_pairing with reset:true',
    );
  });
  it('preserves legacy saved entries with actionable upgrade guidance', async () => {
    const key = new Uint8Array(32);
    const { session } = newSession({}, { key, agent: 'old agent' });
    await until(() => session.getState().pairError);
    expect(FakeWS.last).toBeNull();
    expect(session.getSessionKey()).toEqual(key);
    expect(session.getState().agent).toBe('old agent');
    expect(session.getState().pairError).toContain('upgrade');
  });
  it('requires repair if a restored pairing lost its pinned device signer', async () => {
    const p = await paired();
    const saved = { key: p.agentKey, ...p.session.persistState() };
    p.session.close();
    const other = await makeSigner();
    const { session } = newSession(
      { deviceKeyLoader: async () => other },
      saved,
    );
    await until(() => session.getState().pairError);
    expect(FakeWS.last).toBeNull();
    expect(session.getState().pairError).toContain('signing key');
  });
  it('stops transport retries after a legacy or malformed pairing hello', async () => {
    const { session } = newSession();
    await until(() => FakeWS.last);
    FakeWS.last!.open();
    FakeWS.last!.recv({ _relay: 'peer_joined' });
    FakeWS.last!.recv({ pake: 'invalid-pake' });
    await until(() => session.getState().pairError);
    expect(session.getState().paired).toBe(false);
    expect(session.getState().pairError).toContain('Update the agent');
  });
});
