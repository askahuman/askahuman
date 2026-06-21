# 0001 — Pairing UX: SPAKE2, QR + short code, no manual SAS

**Status:** accepted · 2026-06-20

## Context
Pairing is the only onboarding step and must feel like Magic Wormhole: scan or type a short
code, done. The initial design shows a "Scan a code" / "Show my code" tab, a QR, a 7-char
pairing code (`4F2-9KQ`), and a confirm code (`48-213`).

## Decision
- One short code drives a **SPAKE2** handshake (see architecture
  [[0002_spake2_ristretto255_secretbox]]). The code is shown as QR *and* copy-paste text; the
  QR encodes `{relay URL, room id, code}` so a camera scan auto-fills.
- **No manual SAS confirmation** is required for trust — SPAKE2 key-confirmation MACs do it
  automatically. The "confirm code" affordance becomes an optional, display-only reassurance
  derived from the session key (shown matching on both screens).
- Either side may initiate; the agent prints the QR/code to **stderr** (stdout is MCP JSON-RPC).

## Consequences
- A network/relay attacker gets only one online guess per attempt at the code; no offline
  attack, no pubkey-swap MITM.
- Simpler UX than ECDH+SAS (no "do these 5 digits match?" gate), at the cost of a more involved
  crypto implementation that the interop test must guard.
