// badge drives the OS app-icon badge (the red number on the home-screen icon)
// from the live count of unanswered requests. Two surfaces cooperate:
//
//   - this module (the foreground page) is AUTHORITATIVE while the PWA is open:
//     it sets/clears the badge directly from manager.pendingCount() and pushes
//     that truth to the service worker so a later background push counts up from
//     the right baseline.
//   - the service worker (sw.ts) owns the badge while the PWA is closed: each
//     contentless wake-up push increments the persisted count by one.
//
// The Badging API (navigator.setAppBadge / clearAppBadge) is supported by
// installed PWAs on iOS 16.4+; everywhere it is missing this degrades to a
// no-op (feature-detected), never throwing.

interface BadgeNavigator {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

/**
 * syncBadge reflects `count` unanswered requests onto the app icon: a positive
 * count shows that number, zero clears the badge. It also forwards the count to
 * the controlling service worker so a wake-up push received later (while the app
 * is closed) increments from this baseline rather than from a stale value. All
 * of it is best-effort — a missing Badging API or absent SW controller is fine.
 */
export function syncBadge(count: number): void {
  if (typeof navigator === 'undefined') return;
  const nav = navigator as Navigator & BadgeNavigator;
  try {
    if (count > 0) void nav.setAppBadge?.(count);
    else void nav.clearAppBadge?.();
  } catch {
    // best-effort: a badge failure must never break the app.
  }
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'badge', count });
  } catch {
    // best-effort: the SW reconciles on its next push / our next sync.
  }
}
