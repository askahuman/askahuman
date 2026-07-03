# 0020 — Persist the phone's paired sessions (session key at rest in localStorage)

Date: 2026-07-03
Status: accepted

## Context

All phone-side pairing state (the SPAKE2-derived session key, the roster, the
de-dupe bookkeeping) lived in RAM inside the React island. iOS kills a
backgrounded PWA page routinely — memory pressure, a user swipe, a Safari
reload on return — and every kill silently destroyed the pairing:

- The phone fell back to the pair screen with no way back in. Re-typing the
  old code cannot help: the agent's `askOnce` ignores `pake` frames after
  pairing (by design — ADR 0018 caps online guessing to one attempt per code
  lifetime), so only a brand-new `start_pairing` on the agent could recover.
- The agent keeps its `Session` in RAM for its whole process lifetime, so
  `Paired()` stayed true and every `request_approval` re-announced into a room
  the phone could never rejoin, blocking until timeout. This was the single
  biggest reliability complaint in real use: "the agent thinks it is paired
  but requests go nowhere."

## Decision

Persist, per paired agent, in `localStorage` under the PWA's origin
(`lib/store.ts`, `aah:sessions:v1`):

- the relay URL and 16-hex room id,
- the **derived 32-byte session key** (base64),
- the last-known agent label and the agent's VAPID **public** key,
- bounded de-dupe bookkeeping: seen request ids (≤50) and sent decisions
  (≤32), so a re-announce after a reload is deduped or re-answered correctly.

On boot the app restores every entry: the session rejoins its room already
paired (`Session` is constructed with the key; the handshake object is not
created at all, so stray `pake`/`confirm` frames can never re-derive over a
live key). No protocol or agent change is needed — the agent's existing Ask
loop re-announces the pending request within its ≤5s backoff once the phone's
socket rejoins, and the phone re-subscribes for push with the persisted VAPID
key.

The pairing **code is never stored** — only the one-way-derived key. Removing
an agent from the roster deletes its entry; entries are validated on load
(relay URL scheme, room shape, 32-byte key) and dropped when malformed.

## Alternatives considered

- **Re-type the code to re-pair**: requires the agent to accept `pake` frames
  forever after pairing, reopening the unbounded online-guess window ADR 0018
  deliberately closed. Rejected.
- **IndexedDB**: same origin trust class as localStorage for this threat
  model, more code. The values are tiny JSON; localStorage suffices.
- **Encrypt the stored key**: there is no key to encrypt it under — WebCrypto
  non-extractable keys cannot wrap tweetnacl secretbox keys we must hand to JS
  anyway, and a wrapping key would live in the same storage. Rejected as
  security theater.

## Security tradeoff

The session key at rest is origin-scoped, the same trust class as a session
cookie in any authenticated web app. An attacker who can read another origin's
localStorage on an unlocked device has already won bigger prizes. What the key
grants: sealing/opening app frames for one room until either side re-pairs.
What it does not grant: the pairing code (one-way), other rooms, or the
agent's VAPID private key. Mitigation for a lost/sold phone: re-pair the agent
(new code → new room + key); the old key is useless the moment the agent's
process restarts or re-pairs, and the roster "remove" wipes it locally.
