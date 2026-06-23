# 0018 — Memory-hard (Argon2id) room KDF + 10-symbol code

**Status:** accepted · 2026-06-23 · amends the room-derivation half of [0015](0015_code_only_pairing.md)

## Context
[0015](0015_code_only_pairing.md) derives the rendezvous room from the code alone:
`room = lowercasehex(HKDF-SHA256(canonicalize(code), info="ask-a-human:pair-room:v1")[:8])`,
over an 8-symbol code (`8 × log2(31) ≈ 39.6` bits). HKDF is a single fast HMAC, and 0015
claims the content-blind relay "learns nothing about the code from the room". A 2026-06-23
review (B1, HIGH) showed that claim is too strong once you treat the room id as observable —
it is, by anyone who sees `/ws?room=<id>`: the relay, a proxy, a log line, the URL itself.

- **Offline brute-force.** A room-id observer guesses codes offline at one fast HMAC per
  guess. `2^39.6 ≈ 8.2e11` candidates fall to a commodity GPU in minutes. The attacker
  recovers the code, then impersonates the human's phone in the SPAKE2 handshake.
- **Reusable precompute table.** The HKDF salt is fixed (none) and the keyspace small, so an
  attacker builds a one-time `room → code` table once (seconds of compute, ~hundreds of GB)
  and reverses **every future room** by lookup — the `pairTTL`/void-re-mint online-guess
  bound (0015) does nothing against a table the attacker already holds.

Constraint that shaped the fix: ADR 0015 is load-bearing — **nothing secret may ride any
URL/QR** — so we cannot move the room into a payload. The room must stay a function of the
code. The only levers are (1) make each guess expensive and (2) enlarge the keyspace.

## Decision
Apply **both** levers, keeping code-only pairing intact.

1. **Memory-hard room KDF.** Replace HKDF-SHA256 with **Argon2id** (RFC 9106):
   `room = lowercasehex(Argon2id(ikm=canonicalize(code), salt="ask-a-human:pair-room:v1",
   m=19 MiB, t=2, p=1, dkLen=8))`. The salt is the existing domain separator (public,
   intentionally non-secret, ≥8 bytes). Output stays 8 bytes → 16 hex; the relay's frozen
   16-hex room-id contract (`roomBytes=8`, relay `validRoomID` `roomIDLen=16`) is unchanged.
2. **Code 8 → 10 symbols.** `10 × log2(31) ≈ 49.5` bits. Displayed `XXXXX-XXXXX` (5+5) — the
   SINGLE midpoint hyphen is preserved, so there is no multi-hyphen input rewrite.

Only the room KDF and the code length change. **The SAME canonical string still feeds BOTH
`RoomFromCode` and the SPAKE2 password.** SPAKE2, `nacl/secretbox`, the wire frames, and the
rooms-of-two relay are all unchanged (0002, 0005, 0015, 0016).

### Argon2id parameters (pinned, byte-exact Go ↔ JS)
| param | value |
| --- | --- |
| algorithm | Argon2id, version `0x13` |
| memory `m` | `19 × 1024 = 19456` KiB (19 MiB) |
| iterations `t` | 2 |
| parallelism `p` | 1 |
| salt | UTF-8 bytes of `"ask-a-human:pair-room:v1"` |
| password | the canonical code bytes (e.g. `4F2K9QHRXY`) |
| output `dkLen` | 8 bytes → 16 lowercase hex |

Go `golang.org/x/crypto/argon2.IDKey` and JS `@noble/hashes` `argon2id` produce
**byte-identical** output at every benchmarked row (verified, not asserted); the cross-language
gate is `frontend/test/spake2-interop.mjs`. `@noble/hashes` is now an explicit, pinned
dependency (`2.2.0`) — it was a transitive hoist (a known low finding cleared here too).

**Param selection.** Argon2id runs as **pure JS in the phone browser, once, at pair time**.
Benchmark matrix (node v26, `dkLen=8`, `p=1`, 8-call average):

| m (MiB) | t | node ms | out (hex) |
| --- | --- | --- | --- |
| **19** | **2** | **~410** | **aadc3abc85f729eb** ← CHOSEN |
| 46 | 1 | ~433 | ae9747fee40611cd |
| 32 | 2 | ~628 | 994503259bc12db6 ← documented upgrade |
| 32 | 3 | ~876 | 0dfc042e338ed1de |
| 64 | 2 | ~1243 | 7399b7c4288a5ac4 |
| 64 | 3 | ~1743 | c42cc9e693688eb5 |

`m=19 MiB, t=2` is the OWASP-interactive / RFC 9106 floor: the strongest setting whose
one-time cost fits the mobile budget (target `< ~1.5 s` on a mid-range phone; mobile JS is
~2–4× slower than node, so `~410 ms` node ≈ `~0.8–1.6 s` mobile). The `m=64 MiB` rows breach
that budget on slow phones. `m=32 MiB` (`~628 ms` node) is the documented next step up if more
margin is wanted — both consts are byte-verified, so the upgrade is a 1-line change on each
side (`backend/pkg/paircode/paircode.go` `roomKDF*` and `frontend/src/lib/codegen.ts`
`ROOM_KDF_*`). `p` MUST stay 1 and `m` a multiple of 4: that is the only regime where Go's
`4×threads` and `@noble`'s `4×p` memory rounding agree.

### Attacker-cost math (49.5-bit code @ m=19 MiB, t=2)
- **Keyspace:** `31^10 = 8.20e14 ≈ 2^49.54`.
- **Single online guess:** unchanged and still load-bearing — `pairTTL` (3 min) abandons an
  unpaired room and a failed key-confirmation voids + re-mints the code, so an attacker gets
  **at most one online guess per code lifetime** (0015).
- **Offline brute of one code:** Argon2id at 19 MiB is memory-bandwidth bound. Even an
  optimistic `1e6` guesses/s GPU/ASIC farm needs `2^49.54 / 1e6 ≈ 8.2e8 s ≈ ~26 years` worst
  case (`~13 years` expected) — vastly beyond the 3-min `pairTTL`. The code is void + re-minted
  long before. **Floor holds.**
- **Precompute `room → code` table:** building the full table is `~31^10 ≈ 8.2e14` Argon2id
  evaluations — `≈ 26 years` even at the same optimistic `1e6` evals/s farm rate as the
  single-code brute above (`≈ ~10 million core-years` single-core at a few evals/s/core) —
  **and** `31^10 × 8 bytes ≈ 6.5 PB` of storage, which is infeasible on storage alone. (Versus
  the old HKDF table: seconds of compute + a few hundred GB at 39.6 bits.) **Infeasible.**

No param/length tension: both the GPU-within-`pairTTL` floor and the table-infeasibility hold
at the chosen setting **and** inside the mobile budget. Ship (not a draft-PR situation).

## Consequences
- **The HKDF preimage-recovery + reusable-table attacks are closed.** The room is now a
  memory-hard, 49.5-bit-keyspace one-way function of the code; an observer brute-forces neither
  a single code (within its `pairTTL` lifetime) nor a reusable table.
- **`pairTTL` + void-and-re-mint stay load-bearing.** They remain the bound on the single
  surviving cheap attack — the one online guess per code lifetime. Do not remove them.
- **Residual.** A room id still uniquely tags one pairing attempt while it is live, so the relay
  can correlate which two sockets share a room (the rendezvous it forwards by design — 0005).
  It cannot recover the code or pre-map rooms to codes.
- **UX:** one extra group of typing (10 vs 8 symbols); `XXXXX-XXXXX` keeps the single-hyphen
  display, so no multi-hyphen input rewrite. The phone pays a one-time `~0.8–1.6 s` Argon2id
  cost at submit; the async variant (`argon2idAsync`, overlapped with the relay dial) is the
  documented upgrade path if a low-end phone janks.
- **Amends [0015](0015_code_only_pairing.md):** its room-derivation formula (HKDF), its 39.6-bit
  figure, and its "relay learns nothing about the code from the room" claim are superseded by
  this ADR. SPAKE2/secretbox/wire/relay and the code-only / nothing-in-a-URL invariant are
  untouched.
- **Public-repo hygiene:** no secrets/PII introduced. The salt is a public domain-separator
  string, non-secret by design.
