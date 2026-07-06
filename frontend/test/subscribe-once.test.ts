// Unit tests for subscribeOnce (App.tsx): the per-room push-subscribe latch that
// replaced a single global boolean. It must mark a room done ONLY on success, so
// a denied/failed/dropped first attempt stays retryable (never latches push off
// for the page), and it must track agents independently so one denied agent never
// blocks the others. No DOM/component framework needed — deps are injected.

import { describe, expect, it, vi } from 'vitest';

import { subscribeOnce } from '../src/components/App.tsx';
import { type PushSubscription } from '../src/lib/wire.ts';

const SUB: PushSubscription = { endpoint: 'https://push/x', keys: { p256dh: 'p', auth: 'a' } };

describe('subscribeOnce', () => {
  it('marks the room done on success (subscribed AND delivered)', async () => {
    const done = new Set<string>();
    const subscribe = vi.fn(async (_k: string): Promise<PushSubscription | null> => SUB);
    const deliver = vi.fn(() => true);
    await subscribeOnce(done, 'roomA', 'keyA', subscribe, deliver);
    expect(done.has('roomA')).toBe(true);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(SUB);
  });

  it('does NOT latch on a denied subscribe (null) and retries on the next call', async () => {
    const done = new Set<string>();
    const subscribe = vi.fn(async (_k: string): Promise<PushSubscription | null> => SUB);
    subscribe.mockResolvedValueOnce(null); // first attempt: permission denied / no service
    const deliver = vi.fn(() => true);

    await subscribeOnce(done, 'roomA', 'keyA', subscribe, deliver);
    expect(done.has('roomA')).toBe(false); // not latched off after a failure

    await subscribeOnce(done, 'roomA', 'keyA', subscribe, deliver);
    expect(done.has('roomA')).toBe(true); // retried and succeeded
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it('does NOT mark done when delivery fails (socket closed), stays retryable', async () => {
    const done = new Set<string>();
    const subscribe = vi.fn(async (_k: string): Promise<PushSubscription | null> => SUB);
    const deliver = vi.fn(() => false); // sendPushSubscription* returned false (not open)
    await subscribeOnce(done, 'roomA', 'keyA', subscribe, deliver);
    expect(done.has('roomA')).toBe(false);
  });

  it('skips entirely (no subscribe) when the room is already done', async () => {
    const done = new Set<string>(['roomA']);
    const subscribe = vi.fn(async (_k: string): Promise<PushSubscription | null> => SUB);
    const deliver = vi.fn(() => true);
    await subscribeOnce(done, 'roomA', 'keyA', subscribe, deliver);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('forget-then-re-pair: clearing the room from done re-subscribes (App onRemove hook)', async () => {
    // Room ids are deterministic from the pairing code, so forget -> re-pair the
    // same code reuses the SAME room id. The App's onRemove deletes the id from
    // the done set before manager.remove; this pins the invariant it relies on.
    const done = new Set<string>(['roomA']); // delivered once, then forgotten
    done.delete('roomA');
    const subscribe = vi.fn(async (_k: string): Promise<PushSubscription | null> => SUB);
    const deliver = vi.fn(() => true);
    await subscribeOnce(done, 'roomA', 'keyA', subscribe, deliver);
    expect(subscribe).toHaveBeenCalledTimes(1); // re-subscribed, not short-circuited
    expect(done.has('roomA')).toBe(true);
  });

  it('tracks agents independently: A succeeding does not mark B (multi-agent)', async () => {
    const done = new Set<string>();
    const subscribe = vi.fn(async (k: string): Promise<PushSubscription | null> =>
      k === 'keyB' ? null : SUB,
    );
    const deliver = vi.fn(() => true);
    await subscribeOnce(done, 'roomA', 'keyA', subscribe, deliver); // ok
    await subscribeOnce(done, 'roomB', 'keyB', subscribe, deliver); // denied
    expect(done.has('roomA')).toBe(true);
    expect(done.has('roomB')).toBe(false); // B still retryable, independent of A
  });
});
