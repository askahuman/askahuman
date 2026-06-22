# 0016 — Per-agent VAPID public key delivered sealed during pairing

**Status:** accepted · 2026-06-22 · supersedes [0010](0010_push_vapid_configured_shared_key.md)

## Context
The agent wakes the phone with a contentless Web Push. VAPID (RFC 8292) signs that push with a
keypair; the phone subscribes with the **public** half (`applicationServerKey`), and the push service
accepts the push only if it is signed by the **matching private** half.

[0010](0010_push_vapid_configured_shared_key.md) chose a single, *deployment-shared* VAPID key: the
operator was to set the agent's `AAH_VAPID_PUBLIC_KEY` equal to the PWA's build-time
`PUBLIC_VAPID_KEY`. That assumption does not hold for the **hosted flow** we now ship (0012, 0014):
there is **one prebuilt PWA** served to **many independent laptop agents**, each minting its own
keypair. The single build-time `PUBLIC_VAPID_KEY` cannot match every agent's signer — and in prod it
is **empty**, so the phone either subscribes under a key no agent signs with, or never subscribes at
all. Concretely:
- The phone subscribes with the build-time `PUBLIC_VAPID_KEY` (empty in the hosted build → no
  subscription).
- The agent signs with a *different* random keypair minted each startup.
- The push service therefore **rejects every wake-up**. (Confirmed root cause; see the 2026-06-21
  review, `docs/reviews/0001_deep_review_2026-06-21.md`.)

No single configured key can reconcile one prebuilt PWA with many self-provisioned agents, so 0010's
option 1 is unworkable for the hosted model. We adopt 0010's deferred option 2 (per-agent key over the
sealed channel) and make it the shipped design.

## Decision
**The agent sends its own VAPID *public* key to the phone, sealed, during pairing; the phone
subscribes with exactly that key.** Signer == subscribe-key, by construction, with zero env
coordination.

- **Wire:** a new sealed message kind `vapid_key` carries the agent's VAPID public key
  (`{"kind":"vapid_key","public_key":"<base64url uncompressed P-256>"}`), padded to the same fixed
  block as the other sealed frames. The Go agent encodes/sends it; the phone decodes/receives it.
  Shared, byte-exact Go↔JS contract: `backend/pkg/wire` + `frontend/src/lib/wire.ts`.
- **Pairing:** right after the session is established, the agent seals and writes one `vapid_key`
  frame (`agent.sendVAPIDKey`, best-effort). The phone routes a `vapid_key` frame to a per-room
  handler, subscribes with that public key, and returns the resulting `PushSubscription` to **exactly
  that room** (per-room routing — room A's key yields room A's subscription; the sub is bound to one
  agent's signer and is never fanned out to siblings).
- **Keypair lifecycle (agent):** the keypair is chosen in priority order —
  1. `AAH_VAPID_PUBLIC_KEY` / `AAH_VAPID_PRIVATE_KEY` env (highest; retained for self-hosters);
  2. a persisted keypair at `<os.UserConfigDir>/ask-a-human/vapid.json` (written `0600`, atomic);
  3. a freshly generated pair, persisted as in (2).
  Persistence is best-effort and falls back to a RAM-only pair, so `New` never fails for push reasons.
  Persisting the key means an agent keeps a stable sender identity across restarts, so a phone that
  already subscribed stays valid.
- **Best-effort:** push remains strictly best-effort. A failure to send the `vapid_key` frame, to
  subscribe, or to wake never blocks pairing or a decision.

## Consequences
- Push works in the hosted flow with **no env coordination**: each agent provisions its own key and
  hands the phone the matching public half. The empty build-time `PUBLIC_VAPID_KEY` is now only a
  fallback for legacy/single-shared-key setups.
- **Privacy invariant preserved.** Only a **public** key transits the sealed channel — never the
  private key, never the push endpoint. The relay stays content-blind: it sees an opaque sealed frame
  and learns nothing about the key, the subscription, or the push provider. The pairing code never
  reaches any model (0015). The wake-up push itself stays generic/contentless (0010), so no request
  content leaks to the lock screen or the push provider.
- Per-agent sender identity: agents are now distinguishable to the push service by their own VAPID
  sender key, which is the correct posture for independent agents (the multi-tenant isolation 0010
  deferred).
- The build-time `PUBLIC_VAPID_KEY` and the shared-key fanout are demoted to a fallback path; for the
  hosted build they are inert. Ref. [0005](0005_relay_ramonly_agent_retries.md),
  [0012](0012_deploy_hosted_relay_pwa.md).
