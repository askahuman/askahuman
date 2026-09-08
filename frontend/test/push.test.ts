import { afterEach, describe, expect, it, vi } from 'vitest';
import { pushPermission, removePushForRoom, requestPushPermission, subscribeForPush, urlBase64ToUint8Array } from '../src/lib/push.ts';
import { PUSH_WORKER_URL, pushScope } from '../src/lib/push-routing.ts';

const ORIGIN = 'https://phone.example';
const ROOM_A = '0123456789abcdef', ROOM_B = 'fedcba9876543210';
// Valid-sized uncompressed public-key fixtures; native curve validation is
// performed by PushManager, which is deterministic and local in this test.
const key = (n: number) => btoa(String.fromCharCode(4, ...Array(64).fill(n)));
const KEY_A = key(1), KEY_B = key(2);
const bytes = (key: string) => urlBase64ToUint8Array(key).buffer;

function install(permission: NotificationPermission = 'granted') {
  let sequence = 0;
  const registrations = new Map<string, ReturnType<typeof registration>>();
  function registration(scope: string, script = PUSH_WORKER_URL) {
    const reg = {
      scope: new URL(scope, ORIGIN).href,
      active: { state: 'activated', scriptURL: new URL(script, ORIGIN).href },
      pushManager: {
        current: null as ReturnType<typeof subscription> | null,
        getSubscription: vi.fn(async () => reg.pushManager.current),
        subscribe: vi.fn(async (options: { applicationServerKey: Uint8Array }) => {
          reg.pushManager.current = subscription(options.applicationServerKey.slice().buffer);
          return reg.pushManager.current;
        }),
      },
      unregister: vi.fn(async () => registrations.delete(reg.scope)),
    };
    function subscription(applicationServerKey: ArrayBuffer | null) {
      const endpoint = `https://push.example/${++sequence}`;
      return {
        options: { applicationServerKey },
        toJSON: () => ({ endpoint, keys: { p256dh: 'p256', auth: 'auth' } }),
        unsubscribe: vi.fn(async () => { reg.pushManager.current = null; return true; }),
      };
    }
    registrations.set(reg.scope, reg);
    return reg;
  }
  const register = vi.fn(async (script: string, { scope }: { scope: string }) => {
    return registrations.get(new URL(scope, ORIGIN).href) ?? registration(scope, script);
  });
  const notification = { permission, requestPermission: vi.fn(async () => (notification.permission = 'granted' as NotificationPermission)) };
  vi.stubGlobal('Notification', notification);
  vi.stubGlobal('window', { PushManager: class {}, location: { origin: ORIGIN } });
  vi.stubGlobal('navigator', { serviceWorker: { register, getRegistrations: async () => [...registrations.values()] } });
  return { registrations, registration, register, notification, room: (room: string) => registrations.get(new URL(pushScope(room), ORIGIN).href)! };
}

afterEach(() => vi.unstubAllGlobals());

describe('independent per-room subscriptions', () => {
  it('preserves agent A when differently keyed agent B subscribes, including repeat calls/reload reuse', async () => {
    const f = install();
    const a = await subscribeForPush(KEY_A, ROOM_A);
    const original = f.room(ROOM_A).pushManager.current!;
    const b = await subscribeForPush(KEY_B, ROOM_B);
    expect(a).not.toBeNull(); expect(b).not.toBeNull();
    expect(a!.endpoint).not.toBe(b!.endpoint);
    expect(original.unsubscribe).not.toHaveBeenCalled();
    expect(await subscribeForPush(KEY_A, ROOM_A)).toEqual(a);
    expect(await subscribeForPush(KEY_B, ROOM_B)).toEqual(b);
    expect(f.room(ROOM_A).pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(f.room(ROOM_B).pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(f.register.mock.calls.map(([script]) => script)).toEqual(Array(4).fill(PUSH_WORKER_URL));
  });

  it('keeps two rooms independent even if they use the same VAPID key', async () => {
    const f = install();
    const [a, b] = await Promise.all([subscribeForPush(KEY_A, ROOM_A), subscribeForPush(KEY_A, ROOM_B)]);
    expect(a!.endpoint).not.toBe(b!.endpoint);
    expect(f.registrations.size).toBe(2);
  });

  it('changes only the same room when its VAPID key rotates', async () => {
    const f = install();
    await subscribeForPush(KEY_A, ROOM_A); await subscribeForPush(KEY_B, ROOM_B);
    const oldA = f.room(ROOM_A).pushManager.current!, oldB = f.room(ROOM_B).pushManager.current!;
    await subscribeForPush(KEY_B, ROOM_A);
    expect(oldA.unsubscribe).toHaveBeenCalledOnce();
    expect(oldB.unsubscribe).not.toHaveBeenCalled();
    expect(f.room(ROOM_A).pushManager.current!.options.applicationServerKey).toEqual(bytes(KEY_B));
  });

  it.each(['false', 'throw'])('does not claim a replacement when unsubscribe fails (%s)', async (failure) => {
    const f = install();
    await subscribeForPush(KEY_A, ROOM_A);
    const old = f.room(ROOM_A).pushManager.current!;
    old.unsubscribe.mockImplementation(async () => { if (failure === 'throw') throw new Error('failed'); return false; });
    expect(await subscribeForPush(KEY_B, ROOM_A)).toBeNull();
    expect(f.room(ROOM_A).pushManager.subscribe).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent operations for one room', async () => {
    const f = install();
    const values = await Promise.all(Array.from({ length: 8 }, () => subscribeForPush(KEY_A, ROOM_A)));
    expect(values.every((value) => value?.endpoint === values[0]!.endpoint)).toBe(true);
    expect(f.room(ROOM_A).pushManager.subscribe).toHaveBeenCalledOnce();
  });

  it('forget waits for an in-flight subscribe and removes only its exact registration', async () => {
    const f = install();
    const shell = f.registration('/app/', '/sw.js');
    await subscribeForPush(KEY_B, ROOM_B);
    const pending = subscribeForPush(KEY_A, ROOM_A);
    const forget = removePushForRoom(ROOM_A);
    await Promise.all([pending, forget]);
    expect(f.registrations.has(new URL(pushScope(ROOM_A), ORIGIN).href)).toBe(false);
    expect(f.room(ROOM_B)).toBeDefined();
    expect(shell.unregister).not.toHaveBeenCalled();
  });

  it('does not unregister a similarly scoped or differently scripted registration', async () => {
    const f = install();
    const otherScript = f.registration(pushScope(ROOM_A), '/different.js');
    const sibling = f.registration(`${pushScope(ROOM_A)}nested/`);
    await removePushForRoom(ROOM_A);
    expect(otherScript.unregister).not.toHaveBeenCalled();
    expect(sibling.unregister).not.toHaveBeenCalled();
  });

  it('still unregisters the exact room when its push service rejects unsubscribe', async () => {
    const f = install();
    await subscribeForPush(KEY_A, ROOM_A);
    const reg = f.room(ROOM_A);
    reg.pushManager.current!.unsubscribe.mockRejectedValue(new Error('service unavailable'));
    await removePushForRoom(ROOM_A);
    expect(reg.unregister).toHaveBeenCalledOnce();
  });

  it.each(['default', 'denied'] as const)('never prompts automatically when permission is %s', async (permission) => {
    const f = install(permission);
    expect(await subscribeForPush(KEY_A, ROOM_A)).toBeNull();
    expect(f.notification.requestPermission).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
  });

  it('calls the native permission prompt synchronously from the explicit action', async () => {
    const f = install('default');
    const pending = requestPushPermission();
    expect(f.notification.requestPermission).toHaveBeenCalledOnce();
    expect(await pending).toBe('granted');
    await requestPushPermission();
    expect(f.notification.requestPermission).toHaveBeenCalledOnce();
  });

  it('reports unsupported APIs and safely rejects invalid keys/room scopes', async () => {
    const f = install();
    vi.stubGlobal('window', {});
    expect(pushPermission()).toBe('unsupported');
    expect(await requestPushPermission()).toBe('unsupported');
    expect(await subscribeForPush(KEY_A, ROOM_A)).toBeNull();
    expect(await subscribeForPush('invalid', ROOM_A)).toBeNull();
    expect(await subscribeForPush(KEY_A, '../')).toBeNull();
    expect(f.register).not.toHaveBeenCalled();
  });
});
