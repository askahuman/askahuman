/// <reference lib="webworker" />
// The shell registration precaches the app. Room registrations use this same
// script with ?mode=push but only handle wake-ups: no per-room shell cache or
// page controller. Push content is never rendered or trusted.
import { precacheAndRoute } from 'workbox-precaching';
import { updateBadgeCount } from './lib/badge-store.ts';
import { isAppURL, pushOpenURL, roomFromPushScope } from './lib/push-routing.ts';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

const wakeOnly = new URL(self.location.href).searchParams.get('mode') === 'push';
const room = wakeOnly ? roomFromPushScope(self.registration.scope, self.location.origin) : null;

// __WB_MANIFEST is injected once at build time. Merely registering a room must
// not download or retain another copy of the app under its registration scope.
if (!wakeOnly) precacheAndRoute(self.__WB_MANIFEST, {
  urlManipulation: ({ url }) => url.pathname === '/app' ? [new URL('/app/', url.origin)] : [],
});

type BadgeNavigator = WorkerNavigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

async function applyBadge(value: number | 'increment'): Promise<void> {
  const count = await updateBadgeCount(value);
  if (count === null) return;
  const nav = self.navigator as BadgeNavigator;
  try {
    if (count > 0) await nav.setAppBadge?.(count);
    else await nav.clearAppBadge?.();
  } catch { /* The Badging API is optional. */ }
}

// The visible app is authoritative; background wake-ups only approximate the
// pending count until the next resume. Each increment is atomic across workers.
self.addEventListener('message', (event) => {
  const data = event.data as { type?: string; count?: number } | undefined;
  if (data?.type === 'badge' && Number.isSafeInteger(data.count) && data.count! >= 0) {
    event.waitUntil(applyBadge(data.count!));
  }
});

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => {
  if (!wakeOnly) event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  // Start the visible notification before any optional database/badge work.
  // iOS requires every push to result in a visible notification.
  const shown = self.registration.showNotification('ask-a-human', {
    body: 'You have a request to review',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: room ? `ask-a-human-${room}` : 'ask-a-human-request',
    requireInteraction: true,
  });
  const badge = (async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = clients.some((c) => isAppURL(c.url, self.location.origin) && c.visibilityState === 'visible');
    if (!visible) await applyBadge('increment');
  })();
  event.waitUntil(Promise.all([shown, badge]));
});

// The small app-shell receiver retains a wake in the fragment while React is
// loading, or selects directly when hydrated. No response within the bound
// means we must open the durable URL through the trusted notification gesture.
function selectRoom(client: WindowClient, target: string): Promise<boolean> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let finished = false;
    const finish = (selected: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
      resolve(selected);
    };
    const timer = setTimeout(() => finish(false), 700);
    channel.port1.onmessage = ({ data }) => {
      if (data?.type === 'aah:push-opened' && data.room === target) finish(true);
    };
    try {
      client.postMessage({ type: 'aah:push-open', room: target }, [channel.port2]);
    } catch { finish(false); }
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (!isAppURL(client.url, self.location.origin)) continue;
      // The target comes from this worker's own registration, never a payload.
      // App validates both sender and known roster membership before selecting.
      try {
        const selected = room ? selectRoom(client, room) : Promise.resolve(true);
        await client.focus();
        if (await selected) return;
        break;
      } catch { /* The window may have closed; try another app window. */ }
    }
    // Room workers do not control app clients, so client.navigate() is forbidden
    // here. openWindow may reuse the installed app's existing window. A fragment
    // is not sent in HTTP requests and contains only an opaque room.
    await self.clients.openWindow(pushOpenURL(room));
  })());
});
