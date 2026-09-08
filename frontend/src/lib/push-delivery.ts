import type { PushSubscription } from './wire.ts';

export type PushSubscriptionProvider = (
  key: string,
  room: string,
  use: (sub: PushSubscription) => Promise<boolean>,
  current: () => boolean,
) => Promise<boolean>;

/** The provider holds the room's cross-tab lock while obtaining its current
 * native subscription AND awaiting sealed delivery. No subscription snapshot
 * escapes the lock to be freshly signed by a later reconnect/effect. */
export async function subscribeAndDeliver(
  room: string,
  key: string,
  subscribe: PushSubscriptionProvider,
  deliver: (sub: PushSubscription) => boolean | Promise<boolean>,
  current: () => boolean,
): Promise<boolean> {
  try {
    if (!current()) return false;
    return await subscribe(key, room, async (sub) => {
      if (!current()) return false;
      return await deliver(sub) && current();
    }, current) && current();
  } catch { return false; }
}
