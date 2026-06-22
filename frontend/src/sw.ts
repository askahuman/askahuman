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

// --- app-icon badge ---------------------------------------------------------
// The OS app-icon badge (the red number on the home-screen icon) counts
// unanswered requests. While the PWA is OPEN the foreground page is
// authoritative and pushes the true count here via postMessage; while it is
// CLOSED this worker owns the badge and bumps it by one on every wake-up push.
// The count is persisted in IndexedDB so it survives the worker being killed
// between pushes. The Badging API is feature-detected (iOS 16.4+ installed PWA);
// everywhere else these are no-ops and never throw.

const BADGE_DB = 'aah-badge';
const BADGE_STORE = 'kv';
const BADGE_KEY = 'count';

type BadgeNavigator = WorkerNavigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

function openBadgeDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BADGE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(BADGE_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readBadgeCount(): Promise<number> {
  try {
    const db = await openBadgeDB();
    return await new Promise<number>((resolve, reject) => {
      const r = db.transaction(BADGE_STORE, 'readonly').objectStore(BADGE_STORE).get(BADGE_KEY);
      r.onsuccess = () => resolve(typeof r.result === 'number' ? r.result : 0);
      r.onerror = () => reject(r.error);
    });
  } catch {
    return 0; // best-effort: a storage failure must not break the push.
  }
}

async function writeBadgeCount(count: number): Promise<void> {
  try {
    const db = await openBadgeDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(BADGE_STORE, 'readwrite');
      tx.objectStore(BADGE_STORE).put(count, BADGE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // best-effort.
  }
}

// applyBadge persists count and reflects it on the icon (zero clears it).
async function applyBadge(count: number): Promise<void> {
  await writeBadgeCount(count);
  const nav = self.navigator as BadgeNavigator;
  try {
    if (count > 0) await nav.setAppBadge?.(count);
    else await nav.clearAppBadge?.();
  } catch {
    // best-effort: the Badging API may be absent or reject.
  }
}

// The foreground page sends the authoritative count so a later background push
// increments from truth (and a count of 0 clears a stale badge on resume).
self.addEventListener('message', (event) => {
  const data = event.data as { type?: string; count?: number } | undefined;
  if (data?.type === 'badge' && typeof data.count === 'number') {
    event.waitUntil(applyBadge(data.count));
  }
});

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
    (async () => {
      // Bump the app-icon badge by one only while the PWA is NOT visible: when a
      // window is open and visible the foreground page is authoritative and sets
      // the exact pending count itself, so incrementing here would double-count a
      // request the page can already see. When closed/backgrounded the page is
      // not running, so this worker is the only thing that can move the badge.
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const visible = clients.some((c) => c.visibilityState === 'visible');
      if (!visible) await applyBadge((await readBadgeCount()) + 1);
      await self.registration.showNotification('ask-a-human', {
        body: 'You have a request to review',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: 'ask-a-human-request',
        requireInteraction: true,
      });
    })(),
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
