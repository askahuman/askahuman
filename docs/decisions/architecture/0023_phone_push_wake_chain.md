# 0023 — Phone-side push-wake chain: at-least-once sub delivery per connection, wake re-entry always targets the PWA scope

Date: 2026-07-06
Status: accepted

## Context

[0022](0022_persistent_session_reader.md) fixed the AGENT end of the wake chain
(own the socket for the session, keep it alive, absorb the push subscription
whenever it arrives). The PHONE end still had four defects that broke the same
chain (push delivery -> background -> wake push -> notification tap -> reconnect):

- **Wake tap left the PWA.** The service worker's `notificationclick` opened `/`
  on a cold start (no window client). `/` is the marketing landing, OUTSIDE the
  PWA scope `/app` (astro.config.mjs scope/start_url). After iOS kills the PWA,
  tapping the wake notification opened Safari on the marketing page — restore +
  reconnect never ran and the real request was never seen.
- **A push subscription bound to the wrong VAPID key was reused forever.**
  `subscribeForPush` reused any `pushManager.getSubscription()` result regardless
  of the key it was created under. After a re-pair / regenerated agent key /
  second agent, every push the current agent signs is rejected 403 permanently.
- **A single failed subscribe latched push off for the page.** `pushDoneRef` was
  one global boolean flipped BEFORE the async subscribe resolved: a denied/failed
  first attempt disabled push for the page's life, and with multiple agents only
  the first agent's VAPID key ever subscribed.
- **A sub sent while the agent was briefly absent was counted delivered.**
  `pushSent` latched on a socket WRITE (relay accepted the frame), not on agent
  receipt. The relay is content-blind and replays nothing, so a sub written into
  a momentarily peer-less socket was never re-sent for the page's life.

## Decision

**Push subscription delivery is at-least-once per connection, and wake re-entry
always lands inside the PWA scope.**

- **Wake re-entry targets `/app/`.** `notificationclick` focuses an already-open
  PWA window (in `/app` scope) so its visibilitychange handler forces the
  reconnect; else it steers a stray marketing-page window into `/app/`
  (`WindowClient.navigate`, which only works on a controlled client and otherwise
  rejects) and falls back to `openWindow('/app/')`. It never opens `/`.
- **Resubscribe on VAPID-key mismatch.** `subscribeForPush` compares the stored
  subscription's `applicationServerKey` bytes to the requested key; on any
  difference (or a null stored key) it `unsubscribe()`s and subscribes fresh under
  the current key, so the subscribe key always matches the agent's push signer.
- **Per-room subscription tracking, marked done only on success.** `pushDoneRef`
  is a `Set` of room ids; `subscribeOnce` records a room only after a subscription
  is both obtained AND delivered, and forgetting an agent clears its room from the
  set (room ids are deterministic from the code, so forget-then-re-pair reuses the
  same id). Each agent subscribes under its own key, and a page kill re-subscribes
  every restored agent by its own persisted key (`SessionManager.vapidKeys()`),
  not just the first.
- **The manager retains the subscription PER ROOM and re-delivers it on every
  fresh connection.** `sendPushSubscriptionTo` stores the agent-keyed sub on the
  room's entry even when the write fails (a page restore races the socket open);
  when that room's transport transitions back to `open`, `pushSent` re-arms and
  the retained sub is re-sent. The retention plus open-transition re-delivery IS
  the retry — there is no App-level retry loop. The room's own agent-keyed sub
  always wins; the global build-key fanout sub (`lastSub`) is delivered only to
  rooms that hold no per-room sub and is never re-sent over one, so a self-hosted
  build key can never clobber an agent-keyed subscription. This matters because
  the hosted build bakes an EMPTY build key (0016): in production every room is a
  per-agent-key room and the fanout path is idle. Re-delivery is idempotent on
  the agent (it just overwrites `a.sub`, per 0022).

## Consequences

- A backgrounded, killed phone that is woken by a push now re-enters the PWA,
  restores its sessions, reconnects, and receives the sealed request — instead of
  landing on the marketing page with nothing listening.
- The privacy/security invariants are unchanged: the push payload stays
  contentless, the subscription is still sealed to the agent, and a resubscribe
  only swaps the local endpoint binding — it exposes nothing to the relay.
- Cost is a few redundant sends (idempotent) and, on a key mismatch, one extra
  unsubscribe/subscribe round-trip — both best-effort and never blocking a
  decision.
- Multi-agent background push is capped by the platform, not by this change. Web
  Push permits only one `applicationServerKey` per service-worker registration,
  so with several distinct-key agents paired at once a page-kill restore can
  leave only ONE agent's push subscription live — resubscribing the next key
  rebinds the single slot and the previous endpoint goes 410/403. The Decision's
  "re-subscribes every restored agent by its own key" runs the subscribe for each
  agent, but the registration keeps only the last, so read that as "each restored
  agent is offered its own key" not "every agent ends up with a live sub".
  Single-agent wake — the common case — is unaffected. This is a pre-existing
  platform ceiling, not a regression and not a single-agent issue.
- Named follow-ups, deliberately out of scope here:
  - A `pushsubscriptionchange` handler in the service worker, so a push-service
    initiated endpoint rotation re-delivers the new subscription without waiting
    for the next page open.
  - An on-device check that WebKit reports `options.applicationServerKey` for an
    existing subscription: if it is null on iOS for a valid sub, the
    null-means-mismatch resubscribe churns the endpoint on every restore. Churn
    is safe now that the fresh sub is re-delivered per connection, but it is
    wasted work worth confirming on hardware.
  - One `applicationServerKey` per SW registration ⇒ with multiple distinct-key
    agents only one can hold a live push subscription; revisit if multi-agent
    background wake is needed (e.g. subscribe only the active room's key on
    restore to avoid churning a working sub).
