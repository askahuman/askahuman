// push wraps Web Push subscription for the PWA. The phone subscribes with a
// VAPID public key, then delivers its PushSubscription to the agent SEALED
// (plan §7: the relay never learns the endpoint). The agent sends the actual
// push directly; a contentless nudge wakes the phone, which reconnects over WS.
//
// The VAPID public key is provided by the agent during pairing (inside a sealed
// message) OR via PUBLIC_VAPID_KEY env at build time as a placeholder. Without
// a real push service the rest of the app still works — subscription is best
// effort and never blocks pairing or decisions.

import type { PushSubscription as WirePushSubscription } from './wire.ts';
import { PUSH_WORKER_URL, pushScope } from './push-routing.ts';

/** urlBase64ToUint8Array decodes a VAPID public key (base64url) to bytes
 *  backed by a plain ArrayBuffer (so it satisfies BufferSource for the
 *  PushManager.subscribe applicationServerKey). */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** arrayBufferToBase64Url encodes raw bytes to base64url (for p256dh/auth). */
export function arrayBufferToBase64Url(buf: ArrayBuffer | null): string {
  if (!buf) return '';
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** toWireSubscription maps a browser PushSubscription to the wire shape. */
export function toWireSubscription(sub: PushSubscriptionJSON): WirePushSubscription | null {
  if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return null;
  return {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
  };
}

/** sameServerKey compares a subscription's stored applicationServerKey to the
 *  requested VAPID key bytes. A null/absent stored key, or any length/byte
 *  difference, is NOT a match — the caller then resubscribes under `want`. */
function sameServerKey(stored: ArrayBuffer | null, want: Uint8Array): boolean {
  if (!stored) return false;
  const a = new Uint8Array(stored);
  if (a.length !== want.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== want[i]) return false;
  return true;
}

export type PushPermission = NotificationPermission | 'unsupported';

export function pushPermission(): PushPermission {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return 'unsupported';
  if (typeof Notification === 'undefined' || typeof window === 'undefined' || !('PushManager' in window)) return 'unsupported';
  return Notification.permission;
}

/** Call directly from an explicit user gesture. No asynchronous work may
 * precede the native prompt; iOS rejects prompts from a handshake callback. */
export function requestPushPermission(): Promise<PushPermission> {
  const current = pushPermission();
  if (current !== 'default') return Promise.resolve(current);
  try { return Notification.requestPermission().catch(() => pushPermission()); }
  catch { return Promise.resolve(pushPermission()); }
}

const operations = new Map<string, Promise<unknown>>();
function withRoom<T>(room: string, action: () => Promise<T>): Promise<T> {
  const previous = operations.get(room) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  operations.set(room, current);
  void current.finally(() => { if (operations.get(room) === current) operations.delete(room); }).catch(() => {});
  return current;
}

async function activated(reg: ServiceWorkerRegistration): Promise<void> {
  if (reg.active?.state === 'activated') return;
  const worker = reg.installing ?? reg.waiting ?? reg.active;
  if (!worker) throw new Error('push worker unavailable');
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      if (worker.state !== 'activated' && worker.state !== 'redundant') return;
      clearTimeout(timer); worker.removeEventListener('statechange', finish);
      if (worker.state === 'activated') resolve(); else reject(new Error('push worker failed'));
    };
    const timer = setTimeout(() => {
      worker.removeEventListener('statechange', finish);
      reject(new Error('push worker activation timed out'));
    }, 10000);
    worker.addEventListener('statechange', finish);
    finish();
  });
}

/** One registration/subscription per room. Never prompts automatically and
 * never changes another room's subscription or the shell worker. */
export async function subscribeForPush(vapidPublicKey: string, room: string): Promise<WirePushSubscription | null> {
  try {
    const wantKey = urlBase64ToUint8Array(vapidPublicKey);
    if (wantKey.length !== 65 || wantKey[0] !== 4) return null;
    const scope = pushScope(room);
    return await withRoom(room, async () => {
      if (pushPermission() !== 'granted') return null;
      const reg = await navigator.serviceWorker.register(PUSH_WORKER_URL, { scope });
      await activated(reg);
      let sub = await reg.pushManager.getSubscription();
      if (sub && !sameServerKey(sub.options.applicationServerKey, wantKey)) {
        await sub.unsubscribe();
        // If removal failed or is not yet reflected, do not claim that a new
        // key was subscribed. A future explicit retry can safely try again.
        if (await reg.pushManager.getSubscription()) return null;
        sub = null;
      }
      sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wantKey });
      return sameServerKey(sub.options.applicationServerKey, wantKey) ? toWireSubscription(sub.toJSON()) : null;
    });
  } catch {
    return null; // best-effort: a missing push service must not break the app
  }
}

/** Forget only the exact room registration created by this application.
 * The queue also cleans up a subscribe that was in flight when Forget was tapped. */
export async function removePushForRoom(room: string): Promise<void> {
  try {
    const scope = new URL(pushScope(room), window.location.origin).href;
    await withRoom(room, async () => {
      const reg = (await navigator.serviceWorker.getRegistrations()).find((r) => r.scope === scope);
      if (!reg) return;
      const worker = reg.active ?? reg.waiting ?? reg.installing;
      if (worker?.scriptURL !== new URL(PUSH_WORKER_URL, window.location.origin).href) return;
      try { await (await reg.pushManager.getSubscription())?.unsubscribe(); }
      finally { await reg.unregister(); }
    });
  } catch { /* best-effort; never remove broader/sibling registrations */ }
}
