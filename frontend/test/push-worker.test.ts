import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ precache: vi.fn(), updateBadge: vi.fn(async () => 1) }));
vi.mock('workbox-precaching', () => ({ precacheAndRoute: mocks.precache }));
vi.mock('../src/lib/badge-store.ts', () => ({ updateBadgeCount: mocks.updateBadge }));

const ORIGIN = 'https://phone.example', ROOM = '0123456789abcdef';
async function worker(wake = true) {
  const handlers = new Map<string, (event: any) => void>();
  const clients = {
    matchAll: vi.fn(async (): Promise<any[]> => []),
    claim: vi.fn(async () => {}),
    openWindow: vi.fn(async () => {}),
  };
  const showNotification = vi.fn(async () => {});
  vi.stubGlobal('self', {
    location: { href: ORIGIN + '/sw.js' + (wake ? '?mode=push' : ''), origin: ORIGIN },
    registration: { scope: ORIGIN + (wake ? `/app/_push/${ROOM}/` : '/app/'), showNotification },
    __WB_MANIFEST: [], navigator: {}, clients,
    addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    skipWaiting: async () => {},
  });
  await import('../src/sw.ts');
  const event = (name: string, values: Record<string, unknown> = {}) => {
    const pending: Promise<unknown>[] = [];
    handlers.get(name)!({ waitUntil: (p: Promise<unknown>) => pending.push(p), ...values });
    return Promise.all(pending);
  };
  return { clients, showNotification, event };
}
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

describe('wake-only workers', () => {
  it('does not precache or take over the shell; the normal shell still does', async () => {
    const wake = await worker(); await wake.event('activate');
    expect(mocks.precache).not.toHaveBeenCalled();
    expect(wake.clients.claim).not.toHaveBeenCalled();
    vi.resetModules();
    const shell = await worker(false); await shell.event('activate');
    expect(mocks.precache).toHaveBeenCalledOnce();
    expect(shell.clients.claim).toHaveBeenCalledOnce();
  });
  it('shows fixed notification content immediately and ignores the entire push payload', async () => {
    const w = await worker();
    w.clients.matchAll.mockImplementation(() => new Promise(() => {}));
    void w.event('push', { data: { json: () => { throw new Error('must not read payload'); } } });
    expect(w.showNotification).toHaveBeenCalledWith('ask-a-human', expect.objectContaining({ body: 'You have a request to review', tag: `ask-a-human-${ROOM}` }));
    expect(mocks.updateBadge).not.toHaveBeenCalled();
  });
  it('increments atomically in the background but leaves a visible PWA authoritative', async () => {
    const w = await worker();
    w.clients.matchAll.mockResolvedValue([{ url: ORIGIN + '/', visibilityState: 'visible' }]);
    await w.event('push');
    expect(mocks.updateBadge).toHaveBeenCalledWith('increment');
    mocks.updateBadge.mockClear();
    w.clients.matchAll.mockResolvedValue([{ url: ORIGIN + '/app/', visibilityState: 'visible' }]);
    await w.event('push');
    expect(mocks.updateBadge).not.toHaveBeenCalled();
  });
  it('routes an existing app window to the owning room and ignores a supplied room', async () => {
    const w = await worker();
    const client = { url: ORIGIN + '/app/', postMessage: vi.fn(), focus: vi.fn(async () => {}) };
    w.clients.matchAll.mockResolvedValue([{ url: 'https://other.example/app/' }, { url: ORIGIN + '/application' }, client]);
    const close = vi.fn();
    await w.event('notificationclick', { notification: { close, data: { room: 'bad', key: 'secret' } } });
    expect(close).toHaveBeenCalledOnce();
    expect(client.postMessage).toHaveBeenCalledWith({ type: 'aah:push-open', room: ROOM });
    expect(client.focus).toHaveBeenCalledOnce();
    expect(w.clients.openWindow).not.toHaveBeenCalled();
  });
  it('opens only the canonical app with an opaque room fragment when no app is open', async () => {
    const w = await worker();
    w.clients.matchAll.mockResolvedValue([{ url: ORIGIN + '/' }]);
    await w.event('notificationclick', { notification: { close: () => {} } });
    expect(w.clients.openWindow).toHaveBeenCalledWith(`/app/#wake=${ROOM}`);
  });
  it('ignores malformed foreground badge messages', async () => {
    const w = await worker();
    for (const count of [NaN, Infinity, -1, 0.2, Number.MAX_SAFE_INTEGER + 1, '1']) await w.event('message', { data: { type: 'badge', count } });
    expect(mocks.updateBadge).not.toHaveBeenCalled();
    await w.event('message', { data: { type: 'badge', count: 0 } });
    expect(mocks.updateBadge).toHaveBeenCalledWith(0);
  });
});
