# 0002 — SPAKE2 over ristretto255; secretbox for app traffic

**Status:** accepted · 2026-06-20

## Context
Pairing replaces login. We need a PAKE so a short human code becomes a strong shared key
with no MITM by the relay, and it must interoperate between Go (agent/relay-side test) and
JS (PWA). The original plan suggested NaCl `box` (Curve25519 ECDH). We chose **SPAKE2 now**
(no manual SAS confirm step), which yields a *symmetric* shared key, not an ECDH pair.

## Decision
- **Group:** ristretto255 (prime-order, canonical 32-byte encodings → trivial Go↔JS interop).
  - JS: `@noble/curves` `RistrettoPoint` (audited, maintained — fits "latest & greatest").
  - Go: a ristretto255 group lib for point/scalar ops; the **SPAKE2 protocol is written
    in-house** (we only borrow group arithmetic, never roll our own field math).
- **Construction (RFC 9382-style, single shared password = the short code):**
  - `M`, `N` are fixed points derived by hash-to-group from domain-separated strings
    (`"ask-a-human:spake2:M"` / `":N"`) — computed identically on both sides.
  - Agent plays A (uses `M`), phone plays B (uses `N`). Roles are fixed by the QR/initiator.
  - `w = scalar_from_uniform(SHA-512(code))`. A→ `T=x·G+w·M`; B→ `S=y·G+w·N`;
    shared `K` via `x·(S−w·N)` = `y·(T−w·M)`.
  - `key = HKDF-SHA256(transcript)`, transcript = length-prefixed `idA‖idB‖S‖T‖K‖w`.
  - **Key confirmation:** each side sends an HMAC over the transcript and verifies the
    peer's before trusting the channel. This is what removes the manual SAS step.
  - Optional: a 6-char SAS rendered from `key` for the "confirm code" UI affordance — display
    only, trust comes from the MAC.
- **Application traffic:** `nacl/secretbox` (XSalsa20-Poly1305) keyed by `key`, fresh 24-byte
  nonce per message, wire = `base64(nonce ‖ ciphertext)`. Go `golang.org/x/crypto/nacl/secretbox`
  ↔ JS `tweetnacl` `secretbox`. **Deviation from plan §3 `box`** — a PAKE gives one symmetric
  key, so `secretbox` is the correct primitive (not Curve25519 `box`).

## Consequences
- The relay still only sees `base64(nonce‖ciphertext)` and SPAKE2 messages; no keys, no content.
- **Critical safety net:** a cross-language interop test (Go-generated vectors consumed by a
  Node `@noble` script and vice-versa) must assert identical `K` + a successful secretbox
  round-trip **before** any E2E work proceeds. If interop fails, nothing downstream can work.
- ristretto255 lib choice is a single, swappable dependency; the protocol code is ours.
