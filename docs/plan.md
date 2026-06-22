# Build Plan — E2E Anonymous Agent Approval ("ask me on my phone")

A self-hosted, end-to-end-encrypted channel where **any agent** (Cursor, Claude, Codex, …)
can ask a human to **approve / decline / answer**, and the request lands on a **phone PWA**
with push notifications. No database. Wormhole-style pairing. Relay is a dumb, content-blind pipe.

---

## 1. Goal & hard constraints

- **E2E encrypted.** The server only ever sees `base64(nonce || ciphertext)`. It cannot read content.
- **No database.** The only state is "who is connected right now," in RAM. Restart ⇒ re-pair.
- **Anonymous.** No accounts, no login, no logged identities. (See §11 for what "100%" truly costs.)
- **Resilient.** If the relay is down *or* the phone is offline, the agent is **not** told "approved" —
  it detects the failure and **re-requests** until it gets a real answer or times out.
- **Wormhole idea.** Pairing uses a **short code** (PAKE/SPAKE2): a low-entropy code becomes a strong
  shared key, and the relay cannot MITM it.
- Runs on the **existing GKE cluster** on Google Cloud.

---

## 2. Architecture decision: thin backend + static frontend

**Question raised:** backend + frontend, or frontend only?
**Answer: one thin backend (the relay) + a static frontend (the PWA).** You need the backend because
the agent and the phone are two clients on different networks that need a **meeting point** — they
cannot reach each other directly. The backend is *not* an app server with business logic; it is a
**dumb rendezvous relay** (the "mailbox" from Magic Wormhole). The frontend is just static files.

```
   AGENT SIDE                         BACKEND (GKE)                    USER SIDE
 ┌───────────────┐   seal (NaCl)   ┌───────────────────┐  blob   ┌──────────────────┐
 │ MCP server    │ ─────────────►  │  relay pod        │ ──────► │ phone PWA        │
 │ request_appr. │                 │  room = pairing-id│         │ swipe / choose /  │
 │ (Cursor/Claude│ ◄─────────────  │  forwards ciphertxt│ ◄────── │ type → seal back │
 │  /Codex)      │   open  (NaCl)  │  RAM-only, no DB  │  blob   │ + push notifs    │
 └───────────────┘                 └───────────────────┘         └──────────────────┘
        ▲  the relay sees only ciphertext + which pairing-id talks to which
        └─ Web Push sent agent → phone directly (subscription delivered to agent *sealed*)
```

### Three components
1. **Relay pod** (backend) — stateless WebSocket rendezvous. Groups connections into **rooms of two**,
   forwards opaque blobs, emits `undeliverable` when a peer is absent. Holds **no keys, no content, no DB**.
2. **PWA** (frontend) — installable web app. Decrypts requests in-browser, renders the UI
   (swipe yes/no, multiple choice, short text), seals the answer back, registers for push.
3. **MCP agent** — a small binary that runs next to the agent (Cursor/Claude/Codex). Owns the keys
   (RAM only), runs pairing, seals/opens, sends Web Push, and **retries** on any failure.

---

## 3. Crypto

- **Primitive:** NaCl `box` (Curve25519 + XSalsa20-Poly1305) on **both** sides.
  - Go: `golang.org/x/crypto/nacl/box`. Browser: **TweetNaCl.js** (`nacl.box`). Identical construction,
    wire-compatible, **no custom key-derivation step to get wrong**.
- **Per message:** fresh random **24-byte nonce**; payload = `base64(nonce || box(plaintext))`.
- **Session key:** derived once at pairing (see §4). The relay never sees keys or plaintext.

---

## 4. Pairing (the "wormhole" part)

Pairing replaces login. Agent generates a random **room id** + a **short code**; presents both as a
**QR code** *and* as copy-pasteable text. The QR encodes `{ relay URL, room id, code }` so a scan
auto-fills; manual copy-paste of the code works too.

**Target (faithful wormhole): SPAKE2.**
- Both sides enter the same short code. They run **SPAKE2** over the relay → both derive the **same
  strong key** from the weak code. A network/relay attacker gets only **one online guess per attempt**
  at the code — no offline attack, **no pubkey-swap MITM**.
- Note for the builder: Go ↔ JS SPAKE2 must use **identical parameters** (curve, M/N points, hash,
  identity strings) or they won't interoperate. Safest path: reuse one library lineage on both sides
  (e.g. a WASM build of the Rust/Python `magic-wormhole` SPAKE2), then HKDF the result to a 32-byte key.

**Pragmatic v1 fallback (ship first): ECDH + short confirm code (SAS).**
- QR carries the **agent's public key** (authentic — never touched the relay). Phone generates its own
  keypair, sends its public key back through the relay (public keys aren't secret).
- Residual hole: a malicious relay could swap the **phone's** public key. Close it by showing a
  **5-digit confirmation code** derived from both public keys on **both screens** — the human confirms
  they match once. Easy to build; upgrade to SPAKE2 in Phase 4 to remove the manual step.

---

## 5. Wire protocol

**Relay frames** (JSON; the relay only ever generates `_relay` and forwards everything else verbatim):
```json
{ "_relay": "peer_joined" | "peer_left" | "undeliverable" }   // relay-injected only
{ "pake":  "<base64 SPAKE2 msg>" }      // pairing (SPAKE2 path)
{ "hello": "<base64 public key>" }       // pairing (ECDH/SAS path) — not secret
{ "box":   "<base64 nonce||ciphertext>" } // ALL application traffic, post-pairing
```

**Application messages** (plaintext that lives *inside* `box`):

Request (agent → phone):
```json
{
  "kind": "request",
  "id": "req_8f3a",
  "title": "Production deploy",            // window title
  "category": "deploy",                     // badge: cash | deploy | data | access | other (free-form)
  "summary": "Deploy v2.3.1 to prod cluster?",
  "agent": "cursor @ workstation",          // optional: who is asking
  "response": {
    "kind": "yesno"                          // "yesno" | "choice" | "text"
    // choice ⇒ "options": ["Rollback", "Proceed", "Hold"]
    // text   ⇒ "placeholder": "amount / reason", "max_len": 200
  },
  "expires_in_s": 300
}
```

Response (phone → agent):
```json
{ "kind": "decision", "id": "req_8f3a", "result": { /* one of: */ } }
// yesno : { "approved": true }
// choice: { "choice": "Proceed" }
// text  : { "text": "approve up to $500" }
```

Push subscription (phone → agent, **sealed** so the relay never sees the endpoint):
```json
{ "kind": "push_sub", "subscription": { "endpoint": "...", "keys": { "p256dh": "...", "auth": "..." } } }
```

---

## 6. Request / response model (UX)

- **yesno** → full-screen card; **swipe right = approve, swipe left = decline** (pointer/touch events;
  buttons as fallback for desktop and accessibility).
- **choice** → the `options` rendered as tappable buttons; one tap sends the choice.
- **text** → single short input with `placeholder` + `max_len`; send button.
- Every card shows: **title**, a **category badge** (color per category), the **summary**, and **who** is
  asking. Optional countdown from `expires_in_s`.

---

## 7. Notifications (wake a closed phone)

- PWA registers a **service worker** + **Web Push** subscription (VAPID).
- **Who sends the push: the agent, directly.** The phone delivers its `PushSubscription` to the agent
  **sealed** (§5), so the **relay never learns the endpoint** → preserves anonymity. The agent generates
  a VAPID keypair at startup (RAM) and POSTs the push to the endpoint itself when it needs to wake the phone.
- **Payload:** a contentless nudge ("New approval request") for v1 — the real sealed request arrives over
  the WebSocket once the PWA wakes and reconnects. (Optional later: put the sealed request in the push and
  let the service worker decrypt to show a rich notification — requires persisting the key in IndexedDB.)
- Web Push transport is itself encrypted (RFC 8291); the push service sees only ciphertext, but **does**
  see that *a* push happened to *an* endpoint (metadata — see §11).

---

## 8. Resilience (no DB, agent owns retries)

The agent holds the pending request **in memory** and re-announces until it gets a real `decision`:
- **Phone offline / not in room** → relay replies `undeliverable` → agent resends (backoff).
- **Relay down** → WS dial/write fails → agent reconnects + resends (backoff).
- **Relay restarts / pod rescheduled** → connections drop → both sides reconnect to the same room id
  → agent resends. Safe because there is no server-side state to lose.
- Phone **de-dupes by `id`**, so re-announcing shows the request **once**.
- A `decision` is only returned to the calling agent when an **authenticated** (successfully `box.Open`-ed)
  response arrives. A failure is **never** silently treated as "approved." Hard timeout (e.g. 5 min) ⇒ error.

---

## 9. Deployment on GKE

- **Image:** single Go binary (the relay) in a `distroless`/`scratch` container. Static PWA assets either
  baked into the same image (served at `/`) **or** hosted on a **GCS bucket + Cloud CDN** (nicer caching).
- **Workload:** one `Deployment`. Start with **1 replica** (stateless + restart-safe via agent retry).
- **Service + Ingress:** must support **WebSockets + TLS (WSS)**. GKE L7 Ingress or nginx-ingress;
  TLS via Google-managed cert or cert-manager. **HTTPS is mandatory** — PWAs, service workers, and Web
  Push require a secure context.
- **Scaling past one pod:** the two peers of a room must hit the **same** pod. Either (a) route by
  **room-id hash** at the ingress, or (b) add a small **Redis pub/sub** to bridge rooms across pods.
  Not needed at personal scale — defer.
- **Anonymity hardening:** disable access logs that record client IPs; consider fronting the relay with
  a **Tor onion service** for true IP anonymity (a public GCP load balancer sees client IPs otherwise).
- **Resources:** idle WS connections are memory-bound (~KBs each); a tiny pod handles thousands. Add a
  `readiness`/`liveness` probe on `/healthz`. Set generous WS idle/timeouts on the ingress.

---

## 10. MCP integration

- The agent is a **stdio MCP server** (Go binary, official `github.com/modelcontextprotocol/go-sdk`).
- **Tool surface (one tool):** `request_approval(title, category, summary, response_kind, options?, placeholder?, max_len?, expires_in_s?)`
  → returns `{ approved | choice | text }`. Blocks until the human answers (with retry/timeout from §8).
- **Pairing UX:** on first run the agent prints a **QR + short code** to stderr (stdout is reserved for
  MCP JSON-RPC). A `pair` subcommand can re-display it.
- **Register with clients:** add the binary to Cursor (`mcp.json`), Claude Desktop
  (`claude_desktop_config.json`), and Codex MCP config. Any MCP client works.
- **Optional convenience:** cache the derived session key in a **single local file** (not a DB) so you
  don't re-pair after every agent restart. Default is ephemeral (re-pair) to honor "no database."

---

## 11. Honest limits of "100%" (do not skip)

1. **Browser-delivered crypto is backdoorable by whoever serves the JS.** Ship the PWA as an **installed
   app** with an **SRI-pinned** (ideally reproducible) bundle. Without that it's weaker than a native app.
2. **Encryption hides content, not metadata.** The relay still sees **IPs, timing, and which pairing-id
   pairs talk.** "Anonymous" only fully holds as: no accounts + **no logs** + **Tor** front.
3. **Web Push adds a third party.** Apple/Google/Mozilla see that a push hit an endpoint (content stays
   E2E). If that matters, make push optional and rely on WS-while-open.
4. **Pairing MITM** exists in the v1 ECDH path until the SAS code is confirmed; **SPAKE2 removes it.**

---

## 12. Build phases (suggested order for the next agent)

- **Phase 0 — Relay.** Stateless WS rendezvous: rooms of 2, verbatim forwarding, `undeliverable` signal,
  ping keepalive, `/healthz`. Deploy to GKE behind WSS. *(Reference relay already compiles in Go with
  `github.com/coder/websocket`.)*
- **Phase 1 — E2E MVP.** NaCl box + **ECDH/QR/SAS** pairing + minimal PWA (**yes/no + swipe**) + MCP
  `request_approval`. Full agent → phone → agent round trip working over WSS.
- **Phase 2 — Rich requests.** Add **choice** + **text** response kinds, **title** + **category** badge,
  polished PWA, install manifest.
- **Phase 3 — Push.** Service worker + Web Push (**agent-sends**, subscription sealed to agent) to wake a
  closed phone.
- **Phase 4 — Wormhole + hardening.** Upgrade pairing to **SPAKE2**; no-logs config; Tor onion option;
  PWA SRI/reproducible build.

---

## 13. Stack summary

| Layer | Choice |
|---|---|
| Relay | Go + `github.com/coder/websocket` (zero-dep, context-based) |
| Agent | Go + `github.com/modelcontextprotocol/go-sdk` (stdio) + `golang.org/x/crypto/nacl/box` + a Web Push lib (e.g. `github.com/SherClockHolmes/webpush-go`); SPAKE2 lib in Phase 4 |
| PWA | Vanilla JS (or tiny framework) + **TweetNaCl.js** + service worker + Web App Manifest; swipe via pointer/touch events |
| Deploy | Docker → GKE `Deployment` + `Service` + Ingress (WSS/TLS, managed cert); static via pod or GCS+CDN |

---

## 14. Open decisions to confirm before building

1. Pairing: ship **ECDH+SAS** first and upgrade to **SPAKE2**, or go straight to SPAKE2? (Recommend: ship first.)
2. Static assets: **baked into the relay image** (simplest) or **GCS + Cloud CDN** (better caching)?
3. Push payload: **contentless nudge** (simpler) or **encrypted rich notification** via service-worker decrypt?
4. Key persistence: **fully ephemeral re-pair** (purest) or **single local key file** for convenience?
5. Multi-replica now (room-id hashing / Redis) or **single pod** until you actually need scale?

---

## 15. Locked decisions (this build — 2026-06-20)

Resolves §14 and sets scope. Full rationale in `docs/decisions/`.

- **Scope:** all phases 0–4 in one build, end-to-end tested locally on `kind`.
- **Pairing:** **SPAKE2 now** (no manual SAS gate) over **ristretto255** — `@noble/curves`
  (JS) ↔ in-house Go protocol on a ristretto255 group lib. App traffic uses **`nacl/secretbox`**
  (symmetric, PAKE-derived key), a deliberate change from §3's Curve25519 `box`.
  → `architecture/0002`, `product/0001`.
- **Layout:** `backend/` + `frontend/` + `infra/`, **two images** (`ask-a-human-relay`,
  `ask-a-human-web`); the MCP agent is a distributed **binary**, not an image. → `architecture/0001`.
- **Frontend:** static Astro PWA (mirror `the reference app`, `output: 'static'`), add `vite-plugin-pwa`,
  client crypto, QR. Served from a static container. → `architecture/0004`, `product/0002`.
- **Local dev:** `ctlptl` + `kind` + local registry, `ko` for the relay image, `Tiltfile`
  orchestrates. → `architecture/0003`.
- **Prod:** scaffold kustomize + GKE ingress/managed-cert targeting
  `<region>-docker.pkg.dev/<gcp-project>/...` (cluster `<gke-cluster>`),
  but **deploy + E2E-test only on local kind** — do not push to the real registry or cluster.
- **Static assets:** in the web image (not GCS+CDN) for v1.
- **Push:** contentless nudge; agent sends; subscription sealed to the agent. → `product/0002`.
- **Replicas:** single pod; room-affinity/Redis deferred. → `architecture/0005`.

### Verification bar (must be green, headless)
1. **SPAKE2 interop:** Go-generated vectors ↔ Node `@noble` produce identical `K` + secretbox round-trip.
2. **Relay round trip:** Go agent ↔ relay ↔ Go phone-stub: `request_approval` → sealed decision.
3. **MCP:** drive the agent's `request_approval` tool via an MCP client; assert the returned decision.
4. **Real PWA E2E:** Playwright (headless Chromium) pairs the actual PWA to the relay-in-kind and approves.
5. **Relay blindness:** assert the relay never decodes a `box`/`secretbox` frame.

