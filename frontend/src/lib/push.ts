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

/**
 * subscribeForPush registers/uses the active service worker, requests
 * Notification permission, and subscribes for Web Push with the VAPID key.
 * Returns the wire-shaped subscription, or null if unavailable/denied.
 * Never throws to the caller; push is strictly best-effort.
 */
export async function subscribeForPush(vapidPublicKey: string): Promise<WirePushSubscription | null> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
    if (typeof Notification === 'undefined' || !('PushManager' in window)) return null;
    if (!vapidPublicKey) return null;

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return null;

    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    const sub =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      }));
    return toWireSubscription(sub.toJSON());
  } catch {
    return null; // best-effort: a missing push service must not break the app
  }
}
