# 0027 — Independent push registrations for paired agents

Date: 2026-09-08

Status: accepted design; physical iPhone delivery remains a release test.

## Problem

R15 exposed a mismatch between per-agent VAPID keys and the phone's single
service-worker subscription. Subscribing with agent B's different key first
unsubscribed agent A, leaving A with an invalid endpoint. Tracking successful
subscriptions by room in React did not change the browser's registration model.

## Decision

Keep the shell registration and cache. Give every paired room a separate
registration at `/app/_push/<16-hex-room>/`, all using the fixed script URL
`/sw.js?mode=push`. Room workers do not precache or claim pages. The scope is
registration metadata, not a fetched URL; the HTTP server sees the same script
request regardless of room. No pairing code, encryption key, request content,
or private VAPID key is placed in a URL or sent to a new service.

Each registration subscribes under its own agent's public key. Same-room key
rotation may replace that room's subscription. Different rooms never share a
subscription, including when they happen to use the same key. Removing an agent
unsubscribes and unregisters only its exact reserved scope and known script.
Cleanup waits for in-flight subscription operations across same-origin pages and still
unregisters if the push service fails to unsubscribe. Storage/network/browser
failures remain best effort and never interrupt approval handling.

Every delivery, including a reconnect, reconciles the current native room
subscription under an exclusive Web Lock. The lock covers subscription lookup,
creation/replacement, and the complete asynchronous sequence allocation,
signature, and socket write. Cleanup uses the same lock. Managers retain only
the room/key retry intent, never an endpoint snapshot. This prevents a stale
tab that once delivered E1 from freshly signing E1 with a higher sequence after
another tab has renewed and delivered E2. A delayed older lookup must complete
before a newer tab can mutate/deliver; queued work reads native state after
acquiring the lock. Local generations suppress replaced effects and removed
sessions. Signing, ledger, and wire formats are unchanged.

Unavailable/rejected coordination or native lookup failures report failed
setup without a cached fallback. A setup waiting more than ten seconds for a
lock fails and can be retried; an acquired lock is never stolen or released
before its asynchronous operation settles. Forget remains queued for cleanup
even beyond this setup timeout. A frozen page holding the lock may therefore
delay setup or cleanup until it resumes or closes. These bounds preserve
ordering rather than pretending a timed-out operation stopped executing.

Permission is requested directly from **Enable notifications**. Pairing and
reload never prompt automatically. When permission is already granted, new and
restored rooms subscribe silently. Setup is reported only after obtaining a
subscription and awaiting its sealed delivery; unavailable, denied, waiting,
and failed states stay visible on both listening and offline screens, with
controls reachable at small touch heights. Persist the sealed VAPID public key on receipt,
even when pairing is followed by no request or other state change.

A push always starts a fixed generic visible notification before optional
badge storage work. The worker ignores all payload content and derives the
target room from its own registration. A click sends the opaque room to a
same-origin app client over an acknowledged message channel. A hydrated app
selects the room without navigation. A small shell receiver loads independently
of React; before hydration it retains `/app/#wake=<room>` with `replaceState`
before acknowledging. App restores its roster and consumes that fragment when
hydration finishes. If no receiver acknowledges within 700 ms, the worker opens
the durable URL through the notification gesture. It also opens that URL when
no app client is available. Room workers cannot navigate a client controlled
by the shell worker. The shell receiver validates the worker sender; App
validates roster membership before selecting or reconnecting a room. It clears
the fragment and never creates a pairing
or approves a request from a notification. Badge increments use one IndexedDB
read/write transaction across workers; the visible app remains authoritative.

Existing shell subscriptions from earlier app versions are not forcibly
unsubscribed during migration. Each agent receives its replacement room
endpoint when that room is configured. Old shell wake-ups remain generic;
the shell worker must never be unregistered as room cleanup.

## Standards and platform evidence

- The [W3C Push API](https://www.w3.org/TR/push-api/) associates service-worker
  subscriptions with registration scopes and defines deactivation when the
  owning registration is unregistered. This supports using separate scopes for
  separate signing authorities without a shared private key.
- [WebKit's iOS Web Push introduction](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
  specifies iOS/iPadOS 16.4+ Home Screen apps and a direct user interaction for
  permission. Its standard APIs are the basis for this implementation.
- [WebKit PushManager implementation](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/push-api/PushManager.cpp)
  requires a valid public key and visible notifications. Its permission path
  checks activation while permission is default and proceeds directly when
  already granted. That supports an explicit permission action followed by
  automatic setup of additional rooms. Sources reviewed on 2026-09-08.
- The [Service Workers navigation algorithm](https://www.w3.org/TR/service-workers/#client-navigate)
  rejects navigation by a worker which does not control the client. Native
  Chrome testing confirmed that restriction for wake-only workers; the early
  page receiver retains the fragment without worker-driven navigation.
- The [W3C Web Locks API](https://www.w3.org/TR/web-locks/)
  holds an exclusive origin-scoped lock until the callback's promise settles.
  [WebKit added Web Locks in Safari 15.4](https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/),
  before its iOS Web Push release. Browsers without this coordination API
  remain visibly unconfigured; there is no unlocked signing fallback.

These sources support the design; they do not substitute for testing the
shipping iOS version, install state, service-worker quotas, or APNs delivery.
No fixed supported agent count is promised beyond what the browser accepts.
An unsupported or quota-limited registration remains visibly unconfigured;
the user can keep the app open for WebSocket requests.

## Reproducible verification

From `frontend` after installing the pinned dependencies:

```sh
bun run test
bun run check
bun run build
CHROME_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  RECOVERY_PORT=23080 node e2e/multi-agent-push.mjs
RECOVERY_PORT=23180 node e2e/push-reconciliation.mjs
RECOVERY_BROWSER=webkit RECOVERY_PORT=23280 node e2e/push-reconciliation.mjs
```

The browser test runs two real local Go agents with independently generated
VAPID keys, a real relay, encrypted pairing, native worker registrations and
cache/persistence behavior. A deterministic PushManager service fixture keeps
external delivery out of this test. It checks permission gesture, independent
bindings, reload reuse, failure/retry/denied/unsupported states (including an
unavailable relay), acknowledged selection without navigation, a click while
App hydration is deliberately held, saved-room navigation, exact cleanup,
320 × 568 touch targets, and concurrent IndexedDB
increments from four tabs. Worker regressions separately check fixed visible
content, no room precache/claim, acknowledgement and bounded fallback navigation,
and badge handling. The browser click fixture invokes the built native worker
handler and stubs only focus, which otherwise requires a trusted OS gesture.
The no-receiver timeout and fallback `openWindow` URL are unit-tested. A trusted
OS click opening or reusing the installed app remains part of the device test.

The separate reconciliation harness first pairs with a real local agent, then
restores production managers in two pages using captured local transports.
Actual Web Locks, worker registrations, shared IndexedDB counters, and device
signatures verify E1 → E2 → E2 on stale-tab reconnect. A deliberately delayed
native lookup blocks the other tab's renewal/signing until the older write
completes, while a sibling room can proceed. It also checks lookup failure,
retry, and cross-page Forget waiting without a stale signature or resurrected
registration. The push service is deterministic, and captured signed updates
are not evidence of external provider acceptance or OS notification delivery.

A fresh native Chrome prototype activated two registrations with the shared
script but actual `PushManager.subscribe()` returned `AbortError: Registration
failed - permission denied` in the automation environment. Therefore native
FCM subscriptions and APNs delivery are **not** claimed as verified by this PR.

## Required iPhone release test

Use the deployed version and an iOS 16.4+ Home Screen install, with notifications
allowed and Focus settings permitting delivery. Keep both agent processes alive
on two machines with independently generated VAPID identities.

1. Pair agent A, tap **Enable notifications**, and allow the native prompt.
   Pair agent B. Confirm setup is reported for two agents without another prompt.
2. Background and lock the phone. Ask A for a harmless request, receive the
   generic notification, tap it, and verify A's exact request opens. Answer it.
   Repeat for B, then repeat A after B has delivered successfully.
3. Close and reopen the Home Screen app. Confirm both setups return. Repeat
   locked-phone notifications from both agents, including two outstanding
   requests; each notification must select the matching agent.
4. Forget A. Confirm B still notifies and opens correctly after another reload.
   Block notification permission in iPhone Settings and reopen the app: it must
   say notifications are blocked, while foreground requests still work.

Record iOS version, deployed commit, permission/install state, and the result
for each step. If per-room native subscriptions fail on iOS, keep this limitation
visible and investigate a separate Home Screen install/origin per agent as a
concrete fallback. That isolates push state but adds installation and switching
overhead. A central shared private signing key is not an acceptable fallback.
