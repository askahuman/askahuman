// Unit tests for subscribeForPush's VAPID-key binding: it must resubscribe when
// a stored push subscription was created under a DIFFERENT key (re-paired agent,
// multiple agents, a regenerated agent key) — otherwise every push the current
// agent signs is rejected 403 forever — and reuse one bound to the same key.
// Runs headless: navigator/Notification/window/pushManager are stubbed (no DOM).

import { afterEach, describe, expect, it, vi } from 'vitest';

import { subscribeForPush, urlBase64ToUint8Array } from '../src/lib/push.ts';

const KEY_A = 'BValidKeyAAAAAA';
const KEY_B = 'BDifferentKeyBB';

/** keyBuffer is the ArrayBuffer a browser stores for a subscription's key. */
function keyBuffer(b64: string): ArrayBuffer {
  return urlBase64ToUint8Array(b64).slice().buffer;
}

class FakeSubscription {
  unsubscribed = false;
  constructor(readonly options: { applicationServerKey: ArrayBuffer | null }) {}
  toJSON() {
    return { endpoint: 'https://push.example/ep', keys: { p256dh: 'p256', auth: 'auth' } };
  }
  async unsubscribe(): Promise<boolean> {
    this.unsubscribed = true;
    return true;
  }
}

class FakePushManager {
  subscribeCalls = 0;
  lastKey: ArrayBuffer | null = null;
  constructor(public current: FakeSubscription | null) {}
  async getSubscription(): Promise<FakeSubscription | null> {
    return this.current;
  }
  async subscribe(opts: { applicationServerKey: BufferSource }): Promise<FakeSubscription> {
    this.subscribeCalls += 1;
    const u =
      opts.applicationServerKey instanceof Uint8Array
        ? opts.applicationServerKey
        : new Uint8Array(opts.applicationServerKey as ArrayBuffer);
    this.lastKey = u.slice().buffer;
    this.current = new FakeSubscription({ applicationServerKey: this.lastKey });
    return this.current;
  }
}

function install(pm: FakePushManager, permission: 'granted' | 'denied' | 'default' = 'granted'): void {
  vi.stubGlobal('window', { PushManager: class {} });
  vi.stubGlobal('Notification', { requestPermission: async () => permission });
  vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve({ pushManager: pm }) } });
}

describe('subscribeForPush VAPID key binding', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('subscribes fresh when there is no existing subscription', async () => {
    const pm = new FakePushManager(null);
    install(pm);
    const wire = await subscribeForPush(KEY_A);
    expect(wire).not.toBeNull();
    expect(pm.subscribeCalls).toBe(1);
    expect(new Uint8Array(pm.lastKey!)).toEqual(urlBase64ToUint8Array(KEY_A));
  });

  it('reuses an existing subscription bound to the SAME key (no resubscribe)', async () => {
    const existing = new FakeSubscription({ applicationServerKey: keyBuffer(KEY_A) });
    const pm = new FakePushManager(existing);
    install(pm);
    const wire = await subscribeForPush(KEY_A);
    expect(wire).not.toBeNull();
    expect(pm.subscribeCalls).toBe(0);
    expect(existing.unsubscribed).toBe(false);
  });

  it('resubscribes when the existing subscription is bound to a DIFFERENT key', async () => {
    const existing = new FakeSubscription({ applicationServerKey: keyBuffer(KEY_A) });
    const pm = new FakePushManager(existing);
    install(pm);
    const wire = await subscribeForPush(KEY_B); // agent now signs with B
    expect(wire).not.toBeNull();
    expect(existing.unsubscribed).toBe(true); // the stale A-keyed sub is dropped
    expect(pm.subscribeCalls).toBe(1);
    expect(new Uint8Array(pm.lastKey!)).toEqual(urlBase64ToUint8Array(KEY_B));
  });

  it('treats a null applicationServerKey as a mismatch and resubscribes', async () => {
    const existing = new FakeSubscription({ applicationServerKey: null });
    const pm = new FakePushManager(existing);
    install(pm);
    await subscribeForPush(KEY_A);
    expect(existing.unsubscribed).toBe(true);
    expect(pm.subscribeCalls).toBe(1);
  });

  it('subscribes fresh even if unsubscribe() of the stale sub throws', async () => {
    const existing = new FakeSubscription({ applicationServerKey: keyBuffer(KEY_A) });
    existing.unsubscribe = async () => {
      throw new Error('boom');
    };
    const pm = new FakePushManager(existing);
    install(pm);
    const wire = await subscribeForPush(KEY_B);
    expect(wire).not.toBeNull();
    expect(pm.subscribeCalls).toBe(1);
  });

  it('returns null when permission is not granted (no subscribe attempted)', async () => {
    const pm = new FakePushManager(null);
    install(pm, 'denied');
    expect(await subscribeForPush(KEY_A)).toBeNull();
    expect(pm.subscribeCalls).toBe(0);
  });
});
