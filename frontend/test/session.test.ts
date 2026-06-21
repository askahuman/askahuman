// Integration test for the Session orchestrator: a scripted role-A agent on the
// other end of a fake relay pairs with the phone, then sends a sealed
// wire.Request; the Session opens it, renders the right screen, and on a
// decision seals a wire.Decision the agent can open. Exercises the full
// contract (relay frames + SPAKE2 + secretbox + wire) with the real crypto.

import { describe, expect, it } from 'vitest';

import { Handshake, open as boxOpen, seal as boxSeal } from '../src/lib/crypto.ts';
import { Session, type SessionState } from '../src/lib/session.ts';
import { type WSLike } from '../src/lib/relay.ts';
import { type PairPayload } from '../src/lib/payload.ts';
import {
  type Decision,
  type Request,
  KindRequest,
} from '../src/lib/wire.ts';

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

/** FakeWS captures sent frames and lets the test play the agent + relay. */
class FakeWS implements WSLike {
  static last: FakeWS | null = null;
  sent: Array<Record<string, unknown>> = [];
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
  lastSent(): Record<string, unknown> {
    return this.sent[this.sent.length - 1]!;
  }
}

const PAYLOAD: PairPayload = { r: 'wss://relay.example/ws', room: 'deadbeefdeadbeef', code: 'PAIR-1' };

/** pairSession runs the full handshake; returns the agent's session key + ws. */
function pairSession(session: Session): { ws: FakeWS; agentKey: Uint8Array } {
  const ws = FakeWS.last!;
  ws.open();
  // Relay tells the phone its peer (agent) is present -> phone sends pake.
  ws.recv({ _relay: 'peer_joined' });
  const phonePake = ws.lastSent().pake as string;
  expect(phonePake).toBeTypeOf('string');

  // Scripted agent (role A) finishes against the phone pake.
  const agent = Handshake.newA(PAYLOAD.code);
  const agentPake = agent.start();
  const agentRes = agent.finish(b64.decode(phonePake));

  // Deliver agent pake -> phone finishes + sends its confirm.
  ws.recv({ pake: b64.encode(agentPake) });
  const phoneConfirm = ws.sent.find((f) => typeof f.confirm === 'string')!.confirm as string;
  expect(agent.confirmPeer(b64.decode(phoneConfirm))).toBe(true);

  // Deliver agent confirm -> phone pairs.
  ws.recv({ confirm: b64.encode(agentRes.confirm) });
  return { ws, agentKey: agentRes.sessionKey };
}

function newSession(): { session: Session; states: SessionState[] } {
  FakeWS.last = null;
  const states: SessionState[] = [];
  const session = new Session(PAYLOAD, {
    relayOptions: { wsFactory: (url) => new FakeWS(url), setTimer: () => 0, clearTimer: () => {} },
  });
  session.onChange((s) => states.push(s));
  session.start();
  return { session, states };
}

describe('Session full round trip', () => {
  it('pairs, opens a sealed yesno request, then seals a decision the agent opens', () => {
    const { session } = newSession();
    const { ws, agentKey } = pairSession(session);

    expect(session.getState().paired).toBe(true);
    expect(session.getState().screen).toBe('listening');

    // Agent seals a wire.Request and sends it as a box.
    const req: Request = {
      kind: KindRequest,
      id: 'req_8f3a',
      title: 'Production deploy',
      category: 'deploy',
      summary: 'Deploy v2.3.1 to prod?',
      agent: 'cursor @ workstation',
      response: { kind: 'yesno' },
      expires_in_s: 300,
    };
    ws.recv({ box: boxSeal(agentKey, new TextEncoder().encode(JSON.stringify(req))) });

    expect(session.getState().screen).toBe('yesno');
    expect(session.getState().request?.id).toBe('req_8f3a');
    expect(session.getState().agent).toBe('cursor @ workstation');

    // Phone approves -> Session seals a wire.Decision the agent can open.
    session.approve();
    const boxOut = ws.sent.find((f) => typeof f.box === 'string')!.box as string;
    const decision = JSON.parse(new TextDecoder().decode(boxOpen(agentKey, boxOut))) as Decision;
    expect(decision).toEqual({ kind: 'decision', id: 'req_8f3a', result: { approved: true } });
    expect(session.getState().screen).toBe('confirmed');
    expect(session.getState().result?.label).toBe('Approved');
  });

  it('routes choice + text requests and seals matching decisions', () => {
    // choice
    {
      const { session } = newSession();
      const { ws, agentKey } = pairSession(session);
      const req: Request = {
        kind: KindRequest,
        id: 'req_c',
        title: 'Schema drift',
        summary: 'How to resolve?',
        response: { kind: 'choice', options: ['Roll back', 'Merge & retry'] },
      };
      ws.recv({ box: boxSeal(agentKey, new TextEncoder().encode(JSON.stringify(req))) });
      expect(session.getState().screen).toBe('choice');
      session.choose('Merge & retry');
      const boxOut = ws.sent.find((f) => typeof f.box === 'string')!.box as string;
      const d = JSON.parse(new TextDecoder().decode(boxOpen(agentKey, boxOut))) as Decision;
      expect(d.result).toEqual({ choice: 'Merge & retry' });
    }
    // text
    {
      const { session } = newSession();
      const { ws, agentKey } = pairSession(session);
      const req: Request = {
        kind: KindRequest,
        id: 'req_t',
        title: 'Spend approval',
        summary: 'How much?',
        response: { kind: 'text', placeholder: 'amount', max_len: 120 },
      };
      ws.recv({ box: boxSeal(agentKey, new TextEncoder().encode(JSON.stringify(req))) });
      expect(session.getState().screen).toBe('text');
      session.reply('  up to $500  ');
      const boxOut = ws.sent.find((f) => typeof f.box === 'string')!.box as string;
      const d = JSON.parse(new TextDecoder().decode(boxOpen(agentKey, boxOut))) as Decision;
      expect(d.result).toEqual({ text: 'up to $500' }); // trimmed
    }
  });

  it('de-dupes a re-announced request by id', () => {
    const { session } = newSession();
    const { ws, agentKey } = pairSession(session);
    const req: Request = {
      kind: KindRequest,
      id: 'req_dup',
      title: 'T',
      summary: 'S',
      response: { kind: 'yesno' },
    };
    const sealed = boxSeal(agentKey, new TextEncoder().encode(JSON.stringify(req)));
    ws.recv({ box: sealed });
    session.approve(); // answered -> confirmed, id remembered
    expect(session.getState().screen).toBe('confirmed');

    // Agent re-announces the SAME id (resilience §8). It must NOT reopen.
    const reSealed = boxSeal(agentKey, new TextEncoder().encode(JSON.stringify(req)));
    ws.recv({ box: reSealed });
    expect(session.getState().screen).toBe('confirmed');
    expect(session.getState().request).toBeNull();
  });

  it('drops a box that fails authentication', () => {
    const { session } = newSession();
    const { ws } = pairSession(session);
    const wrongKey = new Uint8Array(32).fill(7);
    const req: Request = { kind: KindRequest, id: 'x', title: 'T', summary: 'S', response: { kind: 'yesno' } };
    ws.recv({ box: boxSeal(wrongKey, new TextEncoder().encode(JSON.stringify(req))) });
    expect(session.getState().screen).toBe('listening'); // never trusted
  });

  it('surfaces offline on an unexpected drop after pairing, then recovers', () => {
    const { session } = newSession();
    const { ws } = pairSession(session);
    expect(session.getState().screen).toBe('listening');
    // Unexpected transport drop.
    ws.close();
    expect(session.getState().screen).toBe('offline');
    // A fresh socket opens (reconnect); on open we return to listening.
    FakeWS.last!.open();
    expect(session.getState().screen).toBe('listening');
  });

  it('restores the open card after a transient reconnect (not listening)', () => {
    const { session } = newSession();
    const { ws, agentKey } = pairSession(session);
    const req: Request = {
      kind: KindRequest,
      id: 'req_open',
      title: 'Production deploy',
      summary: 'Deploy v2.3.1 to prod?',
      response: { kind: 'yesno' },
    };
    ws.recv({ box: boxSeal(agentKey, new TextEncoder().encode(JSON.stringify(req))) });
    expect(session.getState().screen).toBe('yesno');

    // Transient drop while the card is open -> offline (key kept in RAM).
    ws.close();
    expect(session.getState().screen).toBe('offline');
    expect(session.getState().request?.id).toBe('req_open');

    // Reconnect: the pending card is restored, still answerable (not 'listening').
    FakeWS.last!.open();
    expect(session.getState().screen).toBe('yesno');
    expect(session.getState().request?.id).toBe('req_open');
  });

  it('expire(id) drives an open card out of the actionable state', () => {
    const { session } = newSession();
    const { ws, agentKey } = pairSession(session);
    const req: Request = {
      kind: KindRequest,
      id: 'req_exp',
      title: 'T',
      summary: 'S',
      response: { kind: 'yesno' },
    };
    const sealed = boxSeal(agentKey, new TextEncoder().encode(JSON.stringify(req)));
    ws.recv({ box: sealed });
    expect(session.getState().screen).toBe('yesno');

    session.expire('req_exp');
    expect(session.getState().screen).toBe('listening');
    expect(session.getState().request).toBeNull();

    // A stale tick for the wrong id is a no-op.
    session.expire('nope');
    expect(session.getState().screen).toBe('listening');

    // Re-announce of an expired id must NOT reopen the card (deduped).
    ws.recv({ box: boxSeal(agentKey, new TextEncoder().encode(JSON.stringify(req))) });
    expect(session.getState().screen).toBe('listening');
    expect(session.getState().request).toBeNull();
  });

  it('goes offline when the agent leaves while a card is open', () => {
    const { session } = newSession();
    const { ws, agentKey } = pairSession(session);
    const req: Request = {
      kind: KindRequest,
      id: 'req_left',
      title: 'T',
      summary: 'S',
      response: { kind: 'yesno' },
    };
    ws.recv({ box: boxSeal(agentKey, new TextEncoder().encode(JSON.stringify(req))) });
    expect(session.getState().screen).toBe('yesno');

    ws.recv({ _relay: 'peer_left' });
    expect(session.getState().peerPresent).toBe(false);
    expect(session.getState().screen).toBe('offline'); // card no longer actionable
  });
});
