# 0002 — Ship the full PWA (all nine states) + contentless push

**Status:** accepted · 2026-06-20

## Context
The initial design (`frontend/initial-design/`) specifies nine screens. The build scope is
"all phases 0–4," so the PWA ships complete rather than yes/no-only.

## Decision
- Implement every designed state: **lock** (push banner), **home** (installed icon + badge),
  **pair** (scan / show-my-code, QR, code), **listening** (connected, room id), **yes/no**
  (full-screen card, swipe right=approve / left=decline, button fallback), **choice** (tappable
  options), **text** (short input + max length), **confirmed** (Approved/Declined/Sent, E2E
  badge), **offline** (reconnecting, retry count, "nothing is auto-approved").
- Three response kinds: `yesno` | `choice` | `text`. Category badge: `cash | deploy | data |
  access | other` with the design's color per category. Optional `expires_in_s` countdown.
- **Web Push v1 = contentless nudge** ("New approval request"); the real sealed request arrives
  over the WebSocket once the PWA wakes. The agent sends the push directly to a subscription the
  phone delivered **sealed**, so the relay never learns the endpoint. Rich (SW-decrypted) push
  is deferred.

## Consequences
- Full design coverage; accessibility-friendly button fallbacks alongside swipe.
- Push preserves anonymity (relay never sees the push endpoint) at the cost of a second
  round-trip on wake — acceptable for v1.
- Web Push cannot be fully verified headlessly (needs a real push service + device); its tests
  cover sealing/sending against a mock endpoint, with full delivery validated manually.
