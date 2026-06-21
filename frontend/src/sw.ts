/// <reference lib="webworker" />
// sw is the PWA service worker (injectManifest). It precaches the static shell
// and adds Web Push handling: a contentless nudge ("New approval request")
// shows a notification that wakes the phone; tapping it focuses/opens the PWA,
// which reconnects over WS and receives the real sealed request (plan §7).
//
// The push payload is intentionally contentless — the request itself never
// transits the push service; only the agent and phone can read it.

import { precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// __WB_MANIFEST is injected by vite-plugin-pwa at build time.
precacheAndRoute(self.__WB_MANIFEST);

// Activate immediately so a new SW controls open clients (registerType autoUpdate).
self.addEventListener('install', () => {
  void self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Web Push: show a FIXED, generic nudge. The push payload arrives via the
// untrusted push service / relay, so we never render any of its content — no
// title/body/category from the wire is echoed into the notification (privacy +
// anti-injection). The sealed request itself arrives over WS once the PWA wakes.
self.addEventListener('push', (event) => {
  event.waitUntil(
    self.registration.showNotification('ask-a-human', {
      body: 'You have a request to review',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'ask-a-human-request',
      requireInteraction: true,
    }),
  );
});

// Tapping the notification focuses an open PWA window or opens a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of all) {
        if ('focus' in client) {
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow('/');
    })(),
  );
});
