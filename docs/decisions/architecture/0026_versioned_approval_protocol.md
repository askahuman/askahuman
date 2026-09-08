# 0026 — Versioned, mutually authenticated approval protocol

Status: implementation in progress. Supersedes the unsigned compatibility mode and post-pairing key enrollment in ADR 0021. Addresses review findings R02, R07, R08, and R09; retains the R01/R03 acceptance guards and the atomic signer initialization from R16.

## Trust and pairing

The threat includes a party that copied a persisted symmetric session key and can read, alter, replay, or inject relay traffic. That key alone must not authorize a decision, change the question shown to the human, or forge proof that the agent accepted an answer. An attacker executing JavaScript in the phone origin can use its signing key; this protocol does not claim to protect a compromised endpoint.

Protocol v2 is required. Before pairing, the phone loads its existing non-extractable P-256 signer; signer initialization failure blocks pairing. The agent generates a fresh P-256 signing key for the session. Each `pake` payload carries a versioned hello containing its SPAKE2 message and signing public key. The v2 protocol label, room ID, and both signing public keys in role order are included in the SPAKE2 transcript before session and confirmation keys are derived. The existing role-specific key confirmations therefore authenticate the enrollment identities. Application traffic starts only after that confirmation. Subsequent sealed `device_key` frames cannot replace the bound pin.

The agent retains its private signer only in memory. The phone persists the confirmed agent public key, its own signer identity, and protocol version alongside the session key. A restored entry must match the current device signer. Legacy or incomplete entries are retained for an explanatory upgrade/re-pair state; they cannot send approvals. Unsupported versions fail with refresh/update and explicit `start_pairing {"reset":true}` guidance. There is no environment switch or negotiated fallback to unsigned decisions.

## Canonical authorization

Canonical messages use UTF-8 fields with eight-byte unsigned big-endian byte-length prefixes in a fixed order, and distinct v2 domains for pairing, requests, decisions, receipts, and push subscriptions. Integer fields use bounded, canonical decimal representations. Optional fields have specified defaults; arbitrary JSON ordering and platform-specific JSON escaping are not part of the signature contract. Both implementations reject invalid Unicode scalar strings and ambiguous/malformed message shapes, including duplicate fields where parsing could change authorization meaning.

The request signature and digest bind protocol, room, request ID, full title, summary, category and agent context, the entire response definition, and the fixed absolute deadline. Every field displayed as authorization context is covered. The phone verifies the agent's request signature before showing an actionable card. Its decision signature binds that exact request digest and the complete typed result. The agent compares the digest to its original request and rejects extra result fields before returning any output to MCP.

The agent also signs `vapid_key` updates over protocol, room and public key using a separate `aah:vapid:v2` domain. A copied session key cannot change the phone's subscription key selection.

The same device identity authenticates subscription changes: a push-subscription signature binds v2, room, endpoint, and both subscription keys. This preserves the existing subscription value/API semantics while preventing a copied session key from installing a different push endpoint. Push transport restrictions remain independently enforced.

## Validation and expiry

Go and TypeScript use Unicode scalar-value counts, without silently trimming or normalizing the accepted answer. They share limits for request metadata, full question text, 1–32 unique nonempty choice options, text answers up to 4,096 scalars, and optional request lifetimes up to 86,400 seconds. Only response-kind-relevant fields are permitted. A 16 KiB aggregate encoded/padded plaintext bound keeps sealed frames below the relay's 32 KiB limit, including JSON escaping, signatures, non-ASCII text, padding, and base64 overhead. MCP validates the original argument JSON, input fields, and encoded size before starting pairing or sending anything. An answer that hits the encoded size bound keeps its card editable with a message to shorten it; it is never persisted or sent as a pending decision.

The agent assigns one `deadline_ms` from the earlier of the caller's deadline and requested lifetime, with zero representing no deadline. Re-announcements reuse that value. The phone persists it with the active request and pending answer; changing screens, restoring a page, or reconnecting never starts a fresh approval window. The agent's monotonic context/deadline remains authoritative. Clock skew or jumps can affect the phone's informative countdown, but cannot extend agent authorization.

## Acceptance receipts and retries

There is a single acceptance commit point: after complete validation and immediately after checking cancellation/deadline, the agent records the accepted decision and terminal receipt. Receipt I/O never runs on the acceptance/MCP return path. Receipt delivery is bounded, best effort, and cannot turn an already committed answer into a timeout or change its result.

Receipts are signed with the PAKE-bound agent key. They bind protocol, room, request ID, request digest, decision digest, status. Status is `accepted`, `expired`, or `unknown`; unknown is uncertain and retryable, never a rejection. A bounded per-session terminal cache re-sends the same receipt for exact duplicates without re-authorizing. A result evicted from the cache is unknown; the agent must not falsely claim that a previously accepted answer was rejected.

The phone distinguishes an actionable question, an answer awaiting acknowledgment, a verified terminal receipt, and uncertain delivery. Sending to a WebSocket never displays success. A lost receipt retains the exact signed pending decision for retry; it does not invite a different answer or imply rejection. Only a verified accepted receipt matching both digests displays that the agent received the answer. This confirms receipt/acceptance by the agent, not execution of an external action. Invalid, expired, unverifiable, and unknown outcomes cannot show an accepted-success screen.

## Required evidence

- Golden Go/TypeScript canonical bytes and signatures, plus v2 PAKE transcript interoperability and enrollment-key substitution failures.
- Tampering each request field, response definition, deadline, result, room, protocol, and receipt binding fails safely.
- Explicit old/new-client tests demonstrate upgrade guidance without downgrade.
- Unicode boundary and malformed-scalar tests, ambiguous JSON tests, and aggregate encoded-size checks agree across languages.
- Cancellation/expiry during transport stalls, duplicate answers, lost/forged/evicted receipts, roster switches, reloads, clock skew/jumps, and concurrent signing-key initialization retain safe state.
- Real MCP/relay/browser reproductions of copied-key question substitution, unsigned-result injection, and forged success receipts yield no accepted approval or falsely confirmed UI.

Deployment requires coordinated agent/PWA updates and re-pairing for old sessions. Returning to unsigned compatibility is not an acceptable rollback.
