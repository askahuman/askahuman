import { describe, expect, it, vi } from 'vitest';
import { subscribeAndDeliver } from '../src/lib/push-delivery.ts';
const SUB = { endpoint: 'https://push/x', keys: { p256dh: 'p', auth: 'a' } };

describe('subscription delivery status', () => {
  it('awaits asynchronous signing and delivery before reporting setup', async () => {
    let finish!: (value: boolean) => void;
    const subscribe = vi.fn(async () => SUB);
    const deliver = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const pending = subscribeAndDeliver('roomA', 'keyA', subscribe, deliver, () => true);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalled());
    expect(subscribe).toHaveBeenCalledWith('keyA', 'roomA');
    finish(false);
    expect(await pending).toBe(false);
    expect(await subscribeAndDeliver('roomA', 'keyA', subscribe, async () => true, () => true)).toBe(true);
  });
  it('does not deliver if the room was removed during subscription', async () => {
    const deliver = vi.fn(async () => true);
    expect(await subscribeAndDeliver('a', 'k', async () => SUB, deliver, () => false)).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });
  it('does not report setup if the effect was replaced during signing/delivery', async () => {
    let current = true;
    expect(await subscribeAndDeliver('a', 'k', async () => SUB, async () => { current = false; return true; }, () => current)).toBe(false);
  });
  it('keeps subscription and delivery failures retryable without throwing', async () => {
    expect(await subscribeAndDeliver('a', 'k', async () => null, async () => true, () => true)).toBe(false);
    expect(await subscribeAndDeliver('a', 'k', async () => SUB, async () => { throw new Error('closed'); }, () => true)).toBe(false);
  });
});
