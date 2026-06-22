# 0006 — Carry the pairing payload in `?p=` (query) for QR, `#p=` (fragment) for links

> **Superseded by [0015](0015_code_only_pairing.md) (2026-06-22): the QR + `#p=`/`?p=`
> deep link was dropped for a typed code; the room is now derived from the code (no payload
> in any URL). Kept for decision history.**

**Status:** superseded · accepted 2026-06-21

## Context
The pairing payload (`{r, room, code}`) was delivered only in the URL **fragment**
(`<web>/#p=<base64url>`). The fragment was chosen deliberately for privacy: a fragment is
never sent to the server, so the web origin (and any proxy/log) never sees the SPAKE2 code or
room id — only the client JS reads `location.hash`.

In on-device testing the fragment **does not survive iOS Camera QR scanning**: scanning the QR
opens the bare origin (`http://<lan>:8081`) with the `#p=` dropped, so the PWA loads with no
payload, falls into "Show my code" (self-minted room), and never pairs with the agent. Relay
logs confirmed it: the phone connected to a self-minted room, never the agent's room.
Clicking/opening the same link directly preserves the fragment and works.

## Decision
- The PWA accepts the payload from **either** `#p=<blob>` (fragment) **or** `?p=<blob>`
  (query): `parseHash(location.hash) ?? parseQuery(location.search)` (`frontend/src/lib/payload.ts`,
  `App.tsx`). `parseScanned` likewise accepts a scanned `?p=` URL.
- **QR codes encode the `?p=` form** (scan-safe); the renderer rewrites `/#p=` → `/?p=`
  (`scripts/render-pair-page.mjs`). The agent's printed/clicked deep link stays `#p=` (private).

## Consequences
- **Privacy trade-off (scanned pairings only):** a `?p=` URL sends the payload to the web
  server, so the origin/proxy *can* log the room id + SPAKE2 code for scans. This narrows the
  server-blind property for the QR path. Mitigations: (a) clicked links and prod still use the
  private `#p=` fragment; (b) SPAKE2 limits an attacker who learns the code to a single online
  guess against the live handshake, and key-confirmation aborts on mismatch — a logged code is
  low-risk, not a key compromise; (c) the relay (the actual rendezvous) still only ever sees
  `base64(nonce‖ciphertext)`. Ref. [[0002_spake2_ristretto255_secretbox]].
- Pairing now works from the iPhone Camera over plain-LAN http; the in-app camera still needs a
  secure context (HTTPS) — unchanged.

## Update 2026-06-21 — tighten the `?p=` residual (security review)
The deep review (`docs/reviews/0001_deep_review_2026-06-21.md`) flagged the `?p=` code leak. We keep
`?p=` (it is required for the iOS-Camera path) but added defense-in-depth so the only residual is the
single GET that reaches the web origin:
- **Address bar / history / referrer:** the PWA scrubs the payload out of the URL the instant it is
  parsed via `history.replaceState` (`App.tsx`), and serves `Referrer-Policy: no-referrer`
  (`nginx.conf`, `Layout.astro`) so the code never rides a Referer header.
- **Access logs:** `nginx.conf` uses a `log_format` built on `$uri` (path only, no `$args`), so the
  scanned `?p=` never lands in the web access log. The GKE L7 LB request logging for the relay is
  disabled in `infra/prod/frontend-config.yaml` (BackendConfig) to keep room ids out of LB logs.
- **Full upgrade path (not yet taken):** carry only `{r, room}` in the QR and require manual code
  entry, removing the secret from every server-visible channel — deferred as a UX change.
