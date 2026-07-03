# 0021 — Per-device decision-signing keypair (a stolen session key cannot forge an approval)

Date: 2026-07-03
Status: accepted

## Context

[0020](0020_phone_session_persistence.md) persists the phone's SPAKE2 session
key at rest (`aah:sessions:v1` in `localStorage`) so an iOS page kill does not
lose pairing. That key is *both* the encryption key and the sole authenticator
of a decision: whoever holds the blob can seal an approval the agent accepts,
on any device, forever. 0020 accepted this as "the same trust class as a session
cookie," but a copied cookie and a copied *approval authority* are not the same
risk — the latter moves money / ships deploys / grants access.

0020's own "encrypt the stored key" alternative was dismissed as theater
("there is no key to encrypt it under… a wrapping key would live in the same
storage"). That dismissal **under-counted WebCrypto non-extractable keys**: a
key generated `extractable:false` and held in IndexedDB is usable but never
readable, so it is precisely a wrapping/authenticating key that does *not* live
copyably in storage. This ADR uses that property for authentication (signing);
at-rest *wrapping* of the secretbox key with a non-extractable key remains a
cheap, complementary follow-up (option 2) that 0020 wrongly wrote off.

## Decision

The phone holds one **per-origin ECDSA P-256 signing keypair** and signs every
decision; the agent verifies against the device public key it learned at
pairing. A stolen session key can then still *decrypt* traffic but **cannot
forge an approval**.

- **Private key**: generated `extractable:false`, stored as a `CryptoKey` in
  **IndexedDB** (`aah-devicekey`, `frontend/src/lib/devicekey.ts`). It is usable
  for signing across page reloads but never readable — it is **not** in the
  copyable session blob. Only the **public** key (SPKI DER, base64) crosses the
  (sealed) wire, as a new `device_key` message mirroring `vapid_key`.
- **Signature**: WebCrypto ECDSA `sign` returns raw IEEE-P1363 `r‖s` (64 bytes
  for P-256), base64'd onto `Decision.sig` (`omitempty`). Go verifies with
  `ecdsa.Verify` over the `r,s` halves — **not** `VerifyASN1`, which expects DER.
- **Canonical signed message** (`DecisionSigningMessage`, byte-identical Go ↔ TS,
  a cross-language contract like the SPAKE2 transcript):
  `UTF8("aah:decision:v1" 0x00 roomID 0x00 id 0x00 resultTag)`, `resultTag` one
  of `yesno:{1,0}` / `choice:<c>` / `text:<t>` by which result field is set (no
  trailing separator). It **binds room + request id + exact answer**, so a
  signature cannot be replayed across rooms, requests, or flipped answers. The
  bytes are pinned to the same hex in both `pkg/wire` and `lib/wire` tests plus a
  Go↔WebCrypto interop vector, so the two implementations can never drift.
- **Enforcement** (`agent`): once the agent has learned a device key
  (`sess.devicePub != nil`), every decision MUST carry a verifying signature or
  it is rejected — the Ask loop keeps waiting; a bad/missing signature is **never**
  an approval. Before any device key, an unsigned decision is accepted (**compat**
  with an older phone). `AAH_REQUIRE_DEVICE_SIG=1` forces **strict** mode: reject
  until a device key arrives (fail closed). The phone fails closed too — if a
  device key exists but signing throws, it surfaces offline rather than sending
  an unsigned decision.
- **Graceful interop both directions**: a phone without WebCrypto/IndexedDB sends
  unsigned and an older-but-updated agent accepts it (compat); a signing phone
  paired to an older agent that ignores `device_key` still has its decision
  accepted (the extra `sig` field is ignored). The phone re-sends its device key
  on every reconnect / `peer_joined`, so an agent that restarted (losing
  `devicePub` from RAM) is re-armed before the next decision.

### Key establishment & pinning (what makes the signature meaningful)

The device public key is **pinned first-seen**: the agent records the first valid
device key it sees for a session and rejects any later, different one. This pin
is load-bearing. A `device_key` frame is only *session-key-sealed* — it carries
no independent authentication — so without a pin the exact thief this feature
targets (someone who stole the persisted session key) could seal a `device_key`
frame carrying **their own** public key, overwrite the agent's key, and then sign
a forged approval that verifies. The signature layer would add nothing.

Pinning closes that: the real phone establishes its key **at pairing**, when only
it is the room peer (the SPAKE2 password gates who can be there), so the pinned
key is the genuine one; a re-send of the same key on reconnect/restore is a
no-op, and a later key-swap by a session-key thief is rejected — their forged
decision then fails against the pinned real key.

Residual: an attacker would have to inject a device key **before** the real
phone's first delivery. That is not reachable in the normal flow — the persisted
session key only exists *after* pairing, and the real phone sends its device key
immediately at pairing, so it wins the pin.

### Why P-256, not Ed25519

WebCrypto Ed25519 is not universally available on iOS PWAs; P-256 is. For an
iOS-first PWA that is the deciding constraint.

## Residual limit (not fixable by any browser storage)

Same-origin XSS on the live, unlocked device can still **use** (not read/copy)
the non-extractable key in place to sign one forged decision. The win is
converting "copy a string, forge anywhere, forever" into "must run code on the
victim's unlocked device, once." Standard XSS hygiene (the pinned prod CSP)
remains the mitigation for that class.
