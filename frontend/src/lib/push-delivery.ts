import type { PushSubscription } from './wire.ts';

/** Only report setup after obtaining a room-specific subscription and awaiting
 * its sealed delivery. An interrupted/replaced effect must not deliver or latch. */
export async function subscribeAndDeliver(
  room: string,
  key: string,
  subscribe: (key: string, room: string) => Promise<PushSubscription | null>,
  deliver: (sub: PushSubscription) => boolean | Promise<boolean>,
  current: () => boolean,
): Promise<boolean> {
  try {
    const sub = await subscribe(key, room);
    if (!sub || !current()) return false;
    return await deliver(sub) && current();
  } catch { return false; }
}
