// Unit tests for the RelayClient: frame parse/dispatch + reconnect backoff,
// driven by a hand-written FakeWS (no real WebSocket).

import { describe, expect, it } from 'vitest';

import { RelayClient, roomURL, type WSLike } from '../src/lib/relay.ts';

class FakeWS implements WSLike {
  static instances: FakeWS[] = [];
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closed = true;
    this.onclose?.({ code });
  }
  // test helpers
  open(): void {
    this.onopen?.(undefined);
  }
  message(raw: string): void {
    this.onmessage?.({ data: raw });
  }
  serverClose(code?: number): void {
    this.onclose?.({ code });
  }
}

function newClient(events = {}, opts = {}) {
  FakeWS.instances = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const client = new RelayClient('wss://relay.example/ws', 'room1', events, {
    wsFactory: (url) => new FakeWS(url),
    baseDelayMs: 100,
    maxDelayMs: 1000,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length - 1;
    },
    clearTimer: () => {},
    ...opts,
  });
  return { client, timers, ws: () => FakeWS.instances[FakeWS.instances.length - 1]! };
}

describe('roomURL', () => {
  it('appends ?room=', () => {
    expect(roomURL('wss://r.example/ws', 'abc')).toBe('wss://r.example/ws?room=abc');
  });
  it('allows ws:// only for localhost/127.0.0.1', () => {
    expect(roomURL('ws://localhost:8080/ws', 'abc')).toBe('ws://localhost:8080/ws?room=abc');
    expect(roomURL('ws://127.0.0.1:8080/ws', 'abc')).toBe('ws://127.0.0.1:8080/ws?room=abc');
  });
  it('refuses non-WebSocket and cleartext-remote schemes', () => {
    for (const u of ['http://r.example/ws', 'https://r.example/ws', 'javascript:alert(1)', 'ws://r.example/ws']) {
      expect(() => roomURL(u, 'abc')).toThrow(/non-WebSocket|scheme/i);
    }
  });
});

describe('RelayClient dispatch', () => {
  it('routes each frame type to its callback', () => {
    const got: string[] = [];
    const { client, ws } = newClient({
      onSignal: (s: string) => got.push('signal:' + s),
      onPake: (b: string) => got.push('pake:' + b),
      onConfirm: (b: string) => got.push('confirm:' + b),
      onBox: (b: string) => got.push('box:' + b),
      onState: (st: string) => got.push('state:' + st),
    });
    client.connect();
    ws().open();
    ws().message('{"_relay":"peer_joined"}');
    ws().message('{"pake":"UEFLRQ=="}');
    ws().message('{"confirm":"Q05G"}');
    ws().message('{"box":"Qk9Y"}');
    ws().message('garbage-not-json'); // ignored, no crash
    ws().message('{"_relay":"bogus"}'); // unknown control => ignored

    expect(got).toEqual([
      'state:connecting',
      'state:open',
      'signal:peer_joined',
      'pake:UEFLRQ==',
      'confirm:Q05G',
      'box:Qk9Y',
    ]);
  });

  it('ignores a spoofed _relay frame that also carries an app payload', () => {
    const got: string[] = [];
    const { client, ws } = newClient({
      onSignal: (s: string) => got.push('signal:' + s),
      onBox: (b: string) => got.push('box:' + b),
      onPake: (b: string) => got.push('pake:' + b),
    });
    client.connect();
    ws().open();
    // A peer smuggling a control signal alongside a box: the signal must NOT
    // fire, and the box must NOT be routed (it is treated as a control frame).
    ws().message('{"_relay":"peer_left","box":"Qk9Y"}');
    ws().message('{"_relay":"peer_joined","pake":"UEFLRQ=="}');
    // A clean control frame still works.
    ws().message('{"_relay":"peer_joined"}');
    expect(got).toEqual(['signal:peer_joined']);
  });

  it('send only transmits when open and serializes the frame', () => {
    const { client, ws } = newClient();
    client.connect();
    expect(client.sendPake('AAA')).toBe(false); // not open yet
    ws().open();
    expect(client.sendPake('AAA')).toBe(true);
    expect(client.sendBox('BBB')).toBe(true);
    expect(ws().sent).toEqual(['{"pake":"AAA"}', '{"box":"BBB"}']);
  });
});

describe('RelayClient reconnect', () => {
  it('schedules exponential backoff on unexpected close and reconnects', () => {
    const states: Array<[string, number]> = [];
    const { client, timers } = newClient({ onState: (s: string, a: number) => states.push([s, a]) });
    client.connect();
    FakeWS.instances[0]!.open();
    // unexpected drop
    FakeWS.instances[0]!.serverClose(1006);
    expect(client.currentAttempt()).toBe(1);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(100); // base * 2^0
    timers[0]!.fn(); // fire reconnect
    expect(FakeWS.instances).toHaveLength(2);
    FakeWS.instances[1]!.serverClose(1006);
    expect(timers[1]!.ms).toBe(200); // base * 2^1
  });

  it('does NOT reconnect on a 4001 room-full close', () => {
    const { client, timers } = newClient();
    client.connect();
    FakeWS.instances[0]!.open();
    FakeWS.instances[0]!.serverClose(4001);
    expect(timers).toHaveLength(0);
    expect(client.currentState()).toBe('closed');
  });

  it('close() stops reconnection', () => {
    const { client, timers } = newClient();
    client.connect();
    FakeWS.instances[0]!.open();
    client.close();
    FakeWS.instances[0]!.serverClose(1006);
    expect(timers).toHaveLength(0);
  });

  it('retryNow forces an immediate fresh socket', () => {
    const { client } = newClient();
    client.connect();
    FakeWS.instances[0]!.open();
    client.retryNow();
    expect(FakeWS.instances).toHaveLength(2);
  });
});
