# 0010 — Web Push uses a configured, deployment-shared VAPID key

**Status:** accepted · 2026-06-21

## Context
The agent wakes the phone with a contentless Web Push. VAPID (RFC 8292) signs that push with a
keypair; the phone subscribes with the **public** half (`applicationServerKey`), and the push service
accepts the push only if it is signed by the **matching private** half.

The original code generated a *fresh ephemeral* VAPID keypair in the agent at startup
(`agent.New` → `webpush.GenerateVAPIDKeys`) but never delivered the public half to the phone. The PWA
subscribed with its build-time `PUBLIC_VAPID_KEY` instead. The two keys never matched, so **push was
effectively broken**: every wake-up was rejected by the push service. (Found in the 2026-06-21 review,
`docs/reviews/0001_deep_review_2026-06-21.md`.)

Two ways to make the keys agree:
1. **Configured, deployment-shared key** — the agent signs with a keypair whose public half *is* the
   PWA's `PUBLIC_VAPID_KEY`. No protocol change.
2. **Per-agent key delivered over the sealed channel** — each agent ships its own public key to the
   phone post-pairing; the phone subscribes per agent. Cleaner for independent agents, but adds a new
   sealed wire message and per-agent subscription management.

## Decision
Take option 1. The agent reads its VAPID keypair from the environment:
- `AAH_VAPID_PUBLIC_KEY` / `AAH_VAPID_PRIVATE_KEY` — when **both** are set the agent signs with them.
  The operator MUST set `AAH_VAPID_PUBLIC_KEY` equal to the PWA's build-time `PUBLIC_VAPID_KEY`.
- When either is unset the agent falls back to a fresh RAM-only pair (prior behavior); push then will
  not reach a phone subscribed under a different key, but pairing and decisions still work — push is
  strictly best-effort and never blocks a decision.

Fanout: the phone seals its single push subscription to **every** paired agent, including agents added
*after* it subscribed (`SessionManager` retains the last subscription and re-sends it on `add`). All
agents in a deployment share the one VAPID key, so any of them can wake the phone.

The push notification itself stays **generic/contentless** (`sw.ts` renders a fixed
"You have a request to review", never payload-supplied text) so a notification never leaks request
content to the lock screen or to the push provider.

## Consequences
- Push works once the operator provisions one VAPID keypair per deployment and wires the public half
  into both the agent env and the PWA build (`PUBLIC_VAPID_KEY`).
- All agents behind one deployment are indistinguishable to the push service (shared sender key). For
  the personal-scale, single-operator model this is acceptable.
- **Upgrade path** to per-agent sender identity (option 2): deliver the agent's public VAPID key in a
  sealed post-pairing control frame and have the phone subscribe per agent. Deferred until multi-tenant
  isolation is actually needed. Ref. [[0005_relay_ramonly_agent_retries]].
