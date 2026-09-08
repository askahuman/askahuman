import { describe, expect, it, vi } from 'vitest';
import { subscribeAndDeliver, type PushSubscriptionProvider } from '../src/lib/push-delivery.ts';
const provider = (sub: typeof SUB | null): PushSubscriptionProvider => async (_key, _room, use) => sub ? use(sub) : false;
const SUB = { endpoint: 'https://push/x', keys: { p256dh: 'p', auth: 'a' } };

describe('subscription delivery status', () => {
  it('awaits asynchronous signing and delivery before reporting setup', async () => {
    let finish!: (value: boolean) => void;
    const subscribe = vi.fn(provider(SUB));
    const deliver = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const pending = subscribeAndDeliver('roomA', 'keyA', subscribe, deliver, () => true);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalled());
    expect(subscribe).toHaveBeenCalledWith('keyA', 'roomA', expect.any(Function), expect.any(Function), undefined);
    finish(false);
    expect(await pending).toBe(false);
    expect(await subscribeAndDeliver('roomA', 'keyA', subscribe, async () => true, () => true)).toBe(true);
  });
  it('does not deliver if the room was removed during subscription', async () => {
    const deliver = vi.fn(async () => true);
    expect(await subscribeAndDeliver('a', 'k', provider(SUB), deliver, () => false)).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });
  it('does not report setup if the effect was replaced during signing/delivery', async () => {
    let current = true;
    expect(await subscribeAndDeliver('a', 'k', provider(SUB), async () => { current = false; return true; }, () => current)).toBe(false);
  });
  it('keeps subscription and delivery failures retryable without throwing', async () => {
    expect(await subscribeAndDeliver('a', 'k', provider(null), async () => true, () => true)).toBe(false);
    expect(await subscribeAndDeliver('a', 'k', provider(SUB), async () => { throw new Error('closed'); }, () => true)).toBe(false);
  });
});
