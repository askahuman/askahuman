# 0005 — Relay is RAM-only; the agent owns retries

**Status:** accepted · 2026-06-20

## Context
"No database" is a hard constraint. The only state is "who is connected right now." We must
never tell an agent "approved" because of a failure (offline phone, dropped relay).

## Decision
- **Relay** (`github.com/coder/websocket`): groups connections into **rooms of two** keyed by
  room id, forwards opaque frames verbatim, injects `peer_joined`/`peer_left`/`undeliverable`,
  ping keepalive, `/healthz`. Holds no keys, no content, no DB. Restart ⇒ clients re-pair.
- **Agent** holds the pending request in memory and re-announces (backoff) until it receives an
  **authenticated** (`secretbox.Open`-verified) `decision`. `undeliverable`, dial/write
  failures, and relay restarts all trigger reconnect + resend. Hard timeout ⇒ error, never
  "approved". Phone de-dupes by request `id`.
- **Scaling:** single replica to start. Past one pod, both peers of a room must hit the same
  pod (room-id-hash routing or a Redis bridge) — deferred; not needed at personal scale.

## Consequences
- Crash-safety for free: there is no server-side state to lose.
- All durability/resilience logic lives in the agent, which is the only party that must not be
  fooled. See [[0002_spake2_ristretto255_secretbox]] for the authentication that gates a decision.
