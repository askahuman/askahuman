# 0015 — Code-only pairing: drop the QR + `#p=`/`?p=` deep link for a typed code

**Status:** accepted · 2026-06-22 · supersedes [0006](0006_pairing_payload_query_for_qr.md), [0009](0009_qr_surfacing.md)

## Context
Pairing originally minted a random room + a short code, packed `{r, room, code}` into a
base64url payload, and surfaced it as a QR + a `<web>/app#p=<payload>` deep link (`?p=` for
QR scanning). Two problems in practice: (1) the `?p=` scan path sends the SPAKE2 code to the
web origin in a single GET — a residual the relay never sees but the web origin can (0006);
(2) the in-app camera scanner was awkward and opened on every pairing load.

## Decision
The agent mints an 8-char code and **prints it** (stderr); the human opens `/app` and **types
it**. Nothing secret ever rides a URL, QR, history, or referrer.

- **Code:** 8 symbols of the 31-char Crockford-ish alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ`
  (no 0/O/1/I/L), ~39.6 bits, shown grouped `XXXX-XXXX`. Case- and hyphen-insensitive.
- **Room derivation (the key idea):** `room = lowercasehex(HKDF-SHA256(canonicalize(code),
  info="ask-a-human:pair-room:v1")[:8])` → 16 hex, matching the relay's frozen room-id
  contract. The phone derives the room from the code ALONE, so no payload is needed; the room
  is a one-way, domain-separated function of the code, so the content-blind relay learns
  nothing about it. The SAME canonical string feeds both the room KDF and the SPAKE2 password.
  Shared, byte-exact Go↔JS contract: `backend/pkg/paircode` + `frontend/src/lib/codegen.ts`
  (`canonicalizeCode`/`roomFromCode`), pinned by `frontend/test/spake2-interop.mjs`.
- **MCP:** new `start_pairing` tool mints + prints the code (NEVER returns it in the tool
  result — prompt-injection safe) and runs the A-side handshake eagerly; `request_approval`
  still pairs lazily. SPAKE2 / `nacl/secretbox` / rooms-of-two relay are unchanged (0002, 0005).
- **Online-guess bound:** `pairTTL` abandons an unpaired room, and a failed key-confirmation
  voids + re-mints the code, so an attacker gets at most one online guess per code lifetime.

## Consequences
- Removed: QR generation (go-qrcode, `@zxing/browser`, qrcode), `DeepLink`/`PrintPairing`,
  the `PairPayload` URL codec, `#p=`/`?p=` parsing + address-bar scrubbing, the camera, and
  the `--web`/`webOrigin` plumbing. 0006 and 0009 no longer describe the shipped flow.
- The code can no longer carry the relay URL; self-hosters set it out-of-band (the agent's
  `--relay`/`--public-relay`, and an optional "Advanced" relay field on the PWA).
- Prior `#p=` deep links/bookmarks stop working — acceptable for a pre-1.0 pairing surface.
