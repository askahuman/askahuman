// Unit tests for the SessionManager: composes N single-room Sessions over
// independent FakeWS sockets (one per room), mirroring session.test.ts. Drives
// the real handshake + secretbox so list()/status/unread/auto-foreground and the
// active-session passthrough are exercised end-to-end without a DOM.

import { describe, expect, it } from 'vitest';

import { Handshake, open as boxOpen, seal as boxSeal } from '../src/lib/crypto.ts';
import { SessionManager } from '../src/lib/manager.ts';
import { type WSLike } from '../src/lib/relay.ts';
import { type PairPayload } from '../src/lib/payload.ts';
import { type Decision, type Request, KindRequest, encodeVapidKey } from '../src/lib/wire.ts';

const b64 = {
  encode(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  },
  decode(s: string): Uint8Array {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

/** FakeWS captures sent frames per-room; the test plays the agent + relay. */
class FakeWS implements WSLike {
  static byRoom = new Map<string, FakeWS>();
  sent: Array<Record<string, unknown>> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(public url: string) {
    const room = new URL(url).searchParams.get('room') ?? url;
    FakeWS.byRoom.set(room, this);
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
  lastSent(): Record<string, unknown> {
    return this.sent[this.sent.length - 1]!;
  }
}

function payload(room: string, code = 'PAIR-1'): PairPayload {
  return { r: `wss://relay.example/ws?room=${room}`, room, code };
}

function newManager(): SessionManager {
  FakeWS.byRoom.clear();
  return new SessionManager({
    relayOptions: { wsFactory: (url) => new FakeWS(url), setTimer: () => 0, clearTimer: () => {} },
  });
}

/** pair drives the full SPAKE2 handshake for one room; returns the agent key. */
function pair(room: string, code = 'PAIR-1'): { ws: FakeWS; agentKey: Uint8Array } {
  const ws = FakeWS.byRoom.get(room)!;
  ws.open();
  ws.recv({ _relay: 'peer_joined' });
  const phonePake = ws.lastSent().pake as string;

  const agent = Handshake.newA(code);
  const agentPake = agent.start();
  const agentRes = agent.finish(b64.decode(phonePake));

  ws.recv({ pake: b64.encode(agentPake) });
  const phoneConfirm = ws.sent.find((f) => typeof f.confirm === 'string')!.confirm as string;
  expect(agent.confirmPeer(b64.decode(phoneConfirm))).toBe(true);

  ws.recv({ confirm: b64.encode(agentRes.confirm) });
  return { ws, agentKey: agentRes.sessionKey };
}

function sealReq(agentKey: Uint8Array, req: Request): Record<string, unknown> {
  return { box: boxSeal(agentKey, new TextEncoder().encode(JSON.stringify(req))) };
}

const yesno = (id: string, agent?: string): Request => ({
  kind: KindRequest,
  id,
  title: 'T',
  summary: 'S',
  ...(agent ? { agent } : {}),
  response: { kind: 'yesno' },
});

describe('SessionManager', () => {
  it('add creates a live session that pairs; list reports status + label', () => {
    const m = newManager();
    const room = 'aaaa000000000000';
    expect(m.add(payload(room))).toBe(room);
    expect(m.getActive()).toBe(room); // first add becomes active

    // pre-pair: label falls back to short room id.
    expect(m.list()[0]!.label).toBe('aaaa');

    const { ws, agentKey } = pair(room);
    expect(m.list()[0]!.status).toBe('paired');
    expect(m.activeState().paired).toBe(true);

    // a Request supplies the --name label.
    ws.recv(sealReq(agentKey, yesno('r1', 'cursor @ box')));
    expect(m.list()[0]!.label).toBe('cursor @ box');
  });

  it('holds two agents simultaneously over independent sockets', () => {
    const m = newManager();
    const a = 'aaaa111111111111';
    const b = 'bbbb222222222222';
    m.add(payload(a));
    m.add(payload(b));
    pair(a);
    pair(b);

    const list = m.list();
    expect(list).toHaveLength(2);
    expect(list.every((x) => x.status === 'paired')).toBe(true);

    // A box on agent B does NOT touch agent A's state.
    const aState = m.activeState(); // active is still a (first added)
    expect(m.getActive()).toBe(a);
    expect(aState.request).toBeNull();
  });

  it('auto-foregrounds a request on the non-active agent (no card open)', () => {
    const m = newManager();
    const a = 'aaaa333333333333';
    const b = 'bbbb444444444444';
    m.add(payload(a));
    m.add(payload(b));
    pair(a);
    const { ws: wsB, agentKey: keyB } = pair(b);
    expect(m.getActive()).toBe(a);

    wsB.recv(sealReq(keyB, yesno('rb')));
    // No card was open on a -> manager foregrounds b and clears its unread.
    expect(m.getActive()).toBe(b);
    expect(m.activeState().screen).toBe('yesno');
    expect(m.list().find((x) => x.id === b)!.unread).toBe(0);
  });

  it('only bumps unread when a card is already open on the active agent', () => {
    const m = newManager();
    const a = 'aaaa555555555555';
    const b = 'bbbb666666666666';
    m.add(payload(a));
    m.add(payload(b));
    const { ws: wsA, agentKey: keyA } = pair(a);
    const { ws: wsB, agentKey: keyB } = pair(b);

    // Open a card on the active agent a.
    wsA.recv(sealReq(keyA, yesno('ra')));
    expect(m.getActive()).toBe(a);
    expect(m.activeState().screen).toBe('yesno');

    // Request on b must NOT steal the open card; only bump b's badge.
    wsB.recv(sealReq(keyB, yesno('rb')));
    expect(m.getActive()).toBe(a);
    expect(m.list().find((x) => x.id === b)!.unread).toBe(1);
  });

  it('setActive switches + clears unread; decisions route to the active session', () => {
    const m = newManager();
    const a = 'aaaa777777777777';
    const b = 'bbbb888888888888';
    m.add(payload(a));
    m.add(payload(b));
    const { ws: wsA, agentKey: keyA } = pair(a);
    const { ws: wsB, agentKey: keyB } = pair(b);

    // Open card on a, then a queued request on b (a has a card open -> badge only).
    wsA.recv(sealReq(keyA, yesno('ra')));
    wsB.recv(sealReq(keyB, yesno('rb')));
    expect(m.list().find((x) => x.id === b)!.unread).toBe(1);

    m.setActive(b);
    expect(m.getActive()).toBe(b);
    expect(m.list().find((x) => x.id === b)!.unread).toBe(0);

    // approve() routes to b -> only b's key opens the sealed decision.
    m.approve();
    const boxOut = wsB.sent.find((f) => typeof f.box === 'string')!.box as string;
    const d = JSON.parse(new TextDecoder().decode(boxOpen(keyB, boxOut))) as Decision;
    expect(d).toEqual({ kind: 'decision', id: 'rb', result: { approved: true } });
  });

  it('remove closes the active session and re-picks active', () => {
    const m = newManager();
    const a = 'aaaa999999999999';
    const b = 'bbbbaaaaaaaaaaaa';
    m.add(payload(a));
    m.add(payload(b));
    expect(m.getActive()).toBe(a);
    m.remove(a);
    expect(m.getActive()).toBe(b);
    expect(m.list()).toHaveLength(1);
  });

  it('add is idempotent on a duplicate room (no second socket)', () => {
    const m = newManager();
    const a = 'cccc000000000000';
    m.add(payload(a));
    const first = FakeWS.byRoom.get(a);
    expect(m.add(payload(a))).toBe(a); // same id back
    expect(FakeWS.byRoom.get(a)).toBe(first); // same socket, not replaced
    expect(m.list()).toHaveLength(1);
  });

  it('retryAll forces a reconnect of every session (iOS resume recovery)', () => {
    const m = newManager();
    const a = 'ffff000000000000';
    const b = 'ffff111111111111';
    m.add(payload(a));
    m.add(payload(b));
    pair(a);
    pair(b);
    const beforeA = FakeWS.byRoom.get(a);
    const beforeB = FakeWS.byRoom.get(b);

    // retryNow closes the stale socket + reconnects: a fresh FakeWS replaces each.
    m.retryAll();
    expect(FakeWS.byRoom.get(a)).not.toBe(beforeA);
    expect(FakeWS.byRoom.get(b)).not.toBe(beforeB);
  });

  it('sendPushSubscription fans out to every paired session', () => {
    const m = newManager();
    const a = 'dddd000000000000';
    const b = 'eeee000000000000';
    m.add(payload(a));
    m.add(payload(b));
    const { ws: wsA } = pair(a);
    const { ws: wsB } = pair(b);

    const sub = { endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'au' } };
    expect(m.sendPushSubscription(sub)).toBe(true);
    expect(wsA.sent.some((f) => typeof f.box === 'string')).toBe(true);
    expect(wsB.sent.some((f) => typeof f.box === 'string')).toBe(true);
  });

  it('routes an agent vapid_key to onVapidKey tagged with its room', () => {
    const m = newManager();
    const a = 'a1a1a1a1a1a1a1a1';
    const b = 'b2b2b2b2b2b2b2b2';
    m.add(payload(a));
    m.add(payload(b));
    const { ws: wsA, agentKey: keyA } = pair(a);
    const { agentKey: keyB } = pair(b);

    const got: Array<{ pub: string; room: string }> = [];
    m.onVapidKey((pub, room) => got.push({ pub, room }));

    // Only agent A delivers a key -> the handler fires with A's room id, and
    // firstVapidKey reflects A's key (used by the App's first-paired fallback).
    wsA.recv({ box: boxSeal(keyA, encodeVapidKey('Akey')) });
    expect(got).toEqual([{ pub: 'Akey', room: a }]);
    expect(m.firstVapidKey()).toBe('Akey');
    void keyB; // B intentionally sends no key in this case
  });

  it('sendPushSubscriptionTo delivers the agent-keyed sub back to ONLY that room', () => {
    const m = newManager();
    const a = 'c3c3c3c3c3c3c3c3';
    const b = 'd4d4d4d4d4d4d4d4';
    m.add(payload(a));
    m.add(payload(b));
    const { ws: wsA, agentKey: keyA } = pair(a);
    const { ws: wsB } = pair(b);

    // Drive the real App wiring: a vapid_key on A produces a subscription that is
    // routed back to A (room A's key must yield room A's subscription, never B's).
    m.onVapidKey((_pub, room) => {
      m.sendPushSubscriptionTo(room, { endpoint: 'https://push/a', keys: { p256dh: 'p', auth: 'au' } });
    });
    wsA.recv({ box: boxSeal(keyA, encodeVapidKey('Akey')) });

    expect(wsA.sent.some((f) => typeof f.box === 'string')).toBe(true);
    expect(wsB.sent.some((f) => typeof f.box === 'string')).toBe(false); // B untouched
  });

  it('list() sorts an agent with a pending request to the leftmost slot', () => {
    const m = newManager();
    const a = 'aaaa0000aaaa0000';
    const b = 'bbbb0000bbbb0000';
    const c = 'cccc0000cccc0000';
    m.add(payload(a));
    m.add(payload(b));
    m.add(payload(c));
    pair(a);
    const { ws: wsB, agentKey: keyB } = pair(b);
    pair(c);

    // No request yet -> pure insertion order.
    expect(m.list().map((x) => x.id)).toEqual([a, b, c]);

    // A request on the MIDDLE agent b moves it to the front (leftmost); the rest
    // keep their relative insertion order behind it (stable sort).
    wsB.recv(sealReq(keyB, yesno('rb')));
    const list = m.list();
    expect(list[0]!.id).toBe(b);
    expect(list[0]!.hasRequest).toBe(true);
    expect(list.map((x) => x.id)).toEqual([b, a, c]);
    // Only b carries a request -> only b's chip shows the red request dot.
    expect(list.filter((x) => x.hasRequest).map((x) => x.id)).toEqual([b]);
  });
});
