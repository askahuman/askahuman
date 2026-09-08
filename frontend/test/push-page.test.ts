import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://phone.example', ROOM = '0123456789abcdef';
let receive: (event: MessageEvent) => void;
const replaceState = vi.fn();
const addEventListener = vi.fn((_type: string, listener: (event: MessageEvent) => void) => { receive = listener; });
function message(changes: Record<string, unknown> = {}) {
  const port = { postMessage: vi.fn(), close: vi.fn() };
  receive({ origin: ORIGIN, source: { scriptURL: ORIGIN + '/sw.js?mode=push' }, data: { type: 'aah:push-open', room: ROOM }, ports: [port], ...changes } as unknown as MessageEvent);
  return port;
}
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); replaceState.mockReset();
  vi.stubGlobal('navigator', { serviceWorker: { addEventListener } });
  vi.stubGlobal('window', { location: { origin: ORIGIN } });
  vi.stubGlobal('history', { state: { saved: true }, replaceState });
});
afterEach(() => vi.unstubAllGlobals());

describe('app-shell wake receiver', () => {
  it('durably retains the room before acknowledging while React is not hydrated', async () => {
    const { installPushReceiver } = await import('../src/lib/push-page.ts');
    installPushReceiver(); installPushReceiver();
    expect(addEventListener).toHaveBeenCalledOnce();
    const port = message();
    expect(replaceState).toHaveBeenCalledWith({ saved: true }, '', `/app/#wake=${ROOM}`);
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'aah:push-opened', room: ROOM });
    expect(replaceState.mock.invocationCallOrder[0]).toBeLessThan(port.postMessage.mock.invocationCallOrder[0]);
    expect(port.close).toHaveBeenCalledOnce();
  });
  it('hands a hydrated app the room without navigation and retains again after unmount', async () => {
    const { onPushRoom } = await import('../src/lib/push-page.ts');
    const select = vi.fn();
    const stop = onPushRoom(select);
    const port = message();
    expect(select).toHaveBeenCalledWith(ROOM);
    expect(select.mock.invocationCallOrder[0]).toBeLessThan(port.postMessage.mock.invocationCallOrder[0]);
    expect(replaceState).not.toHaveBeenCalled();
    stop(); message();
    expect(select).toHaveBeenCalledOnce();
    expect(replaceState).toHaveBeenCalledOnce();
  });
  it('ignores invalid origins, worker senders, and rooms without acknowledging them', async () => {
    const { installPushReceiver } = await import('../src/lib/push-page.ts');
    installPushReceiver();
    for (const changes of [
      { origin: 'https://other.example' },
      { source: { scriptURL: ORIGIN + '/sw.js' } },
      { source: null },
      { data: { type: 'aah:push-open', room: '../secret' } },
    ]) expect(message(changes).postMessage).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });
  it('leaves fallback available if the durable fragment could not be written', async () => {
    const { installPushReceiver } = await import('../src/lib/push-page.ts');
    installPushReceiver();
    replaceState.mockImplementation(() => { throw new Error('navigation interrupted'); });
    const port = message();
    expect(port.postMessage).not.toHaveBeenCalled();
    expect(port.close).toHaveBeenCalledOnce();
  });
});
