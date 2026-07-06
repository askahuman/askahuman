# 0022 — Persistent session reader on the agent (own the socket for the session, not just during a request)

Date: 2026-07-06
Status: accepted

## Context

The agent read its relay WebSocket **only while a `request_approval` was in
flight** (inside `askOnce`). Between pairing and the first request — and between
requests — nothing read the socket. Two consequences, both matching the top
real-world complaint ("the agent thinks it is paired but requests go nowhere"):

- **The idle socket was reaped.** coder/websocket only answers the relay's
  keepalive pings while a `Read` is pending (`read.go`: "it will ensure that
  ping, pong and close frames are responded to" — only during a read). With no
  read pending, the relay's 20s ping goes unanswered and the relay closes the
  agent in ~20-40s. Confirmed against the deployed relay: an idle socket returns
  EOF within the keepalive window while a continuously-reading one survives.
- **The phone's post-pairing frames were lost.** Right after pairing the PWA
  seals and sends its **Web Push subscription** and **device key**. With no
  reader running, those frames landed in an unread socket and were never
  absorbed, so `a.sub` stayed `nil`. The phone-side manager marks the sub
  "sent" on a successful *write* and never re-sends it, so the loss was
  permanent: the agent could not wake a backgrounded phone, and every later
  request timed out with no notification.

The lazy path (`request_approval` pairs then immediately Asks) mostly worked
because the Ask's read loop was running when the frames arrived; the
`start_pairing`-then-later-request path — and any request answered before the
async subscription round-tripped — did not.

## Decision

A **single persistent reader** (`readLoop`) owns `sess.conn` for the session's
lifetime, started by `Pair` and (idempotently) by the first `Ask`:

- It reads continuously, which keeps the socket alive (the relay keeps getting
  pongs) and absorbs the push subscription, device key, and relay signals
  **whenever they arrive**, including the idle window after pairing.
- It **owns reconnect**: on a read error it re-dials the same room (same key, no
  re-pairing) and tells any in-flight Ask to re-announce. Reconnects are
  backoff-paced and the backoff is cleared only by a successful *read* — a relay
  that accepts the upgrade then closes at once (room full / overloaded / an LB
  draining a backend) must not spin a connect→close hot loop.
- `Ask` no longer reads. It registers a single-flight mailbox
  (`askWaiter{decCh, evCh}`), writes the request (on a write context derived from
  `context.Background`, so a request timeout can never cancel the write and close
  the shared socket), proactively wakes once, then waits on its mailbox,
  re-announcing on `evPeerAbsent` (backoff-paced, throttled re-wake) and
  `evReconnected`.
- Live peer presence is a reader-maintained flag (`peerPresent`), set on
  pairing / `peer_joined` / any authenticated frame and cleared on
  `peer_left` / `undeliverable`. The timeout diagnostic reads it, so a
  silent-but-connected phone is reported as "nobody answered" rather than
  misread as "lost pairing" now that presence is proven before the request runs.

## Consequences

- The security and correctness invariants are unchanged: a failure/timeout is
  never returned as an approval, the device key is still pinned first-seen, only
  a decision that opens under the session key and matches id + shape + signature
  is ever routed to Ask, and the relay stays content-blind.
- The connection is kept alive by reading, not by a re-pair or reconnect on the
  next request, so a backgrounded phone is woken by a push that now reliably has
  a subscription to sign.
- New failure surface is a background goroutine per session; `Agent.Close`
  cancels it and waits for exit. Verified with the race detector (unit +
  integration, high `-count`), an adversarial multi-lens review, and end-to-end
  against the production relay (idle push-sub absorption, a full round-trip, and
  a ~25s idle that crosses the ping cycle and still delivers).

Supersedes the "the agent's existing Ask loop re-announces within its ≤5s
backoff once the phone rejoins" assumption in [0020](0020_phone_session_persistence.md):
the agent now also keeps its own end of the connection alive between requests.
