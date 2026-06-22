# ask-a-human

**Let your AI agent ask a human — on your phone.** End-to-end encrypted. No accounts, no database.

> **Zero setup.** Paste one line into your agent and go — no install, no account, no API key, no dependency to wire up.

[![npm](https://img.shields.io/npm/v/@askahuman/mcp?logo=npm)](https://www.npmjs.com/package/@askahuman/mcp)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![release](https://github.com/askahuman/askahuman/actions/workflows/release.yml/badge.svg)](https://github.com/askahuman/askahuman/actions/workflows/release.yml)

The MCP server runs **locally next to your agent** (Cursor / Claude / Codex) and exposes **one tool you
call — `request_approval`** (plus a read-only `pair_status`) — that **blocks until a human answers**
(approve / decline / choose / reply) on a phone PWA. It never auto-approves. The **relay** in the middle
is content-blind: it only ever sees `base64(nonce‖ciphertext)` + which room talks to which. Pairing is a
[Magic-Wormhole](https://github.com/magic-wormhole/magic-wormhole)-style **SPAKE2** handshake — a short
code becomes a strong shared key, with no relay MITM. No DB, RAM-only; restart ⇒ re-pair.

- Repo: [github.com/askahuman/askahuman](https://github.com/askahuman/askahuman)
- Website: [ask-a-human.ai](https://ask-a-human.ai) · npm: [`@askahuman/mcp`](https://www.npmjs.com/package/@askahuman/mcp)
- For agents: [ask-a-human.ai/llms.txt](https://ask-a-human.ai/llms.txt)

```
  AGENT SIDE                    RELAY (kind / GKE)            USER SIDE
 ┌──────────────┐  seal       ┌──────────────────┐  blob   ┌────────────────┐
 │ MCP agent    │ ──────────► │ rooms-of-two WS   │ ──────► │ phone PWA      │
 │ request_     │             │ verbatim forward  │         │ swipe / choose │
 │   approval   │ ◄────────── │ RAM-only, no DB   │ ◄────── │ / reply → seal │
 └──────────────┘   open      └──────────────────┘  blob   └────────────────┘
        the relay sees only ciphertext + which room-id talks to which
```

## Quickstart — copy-paste MCP (npx)

Paste into Cursor `~/.cursor/mcp.json`, Claude Desktop `claude_desktop_config.json`, or your Codex MCP config:
```json
{ "mcpServers": { "ask-a-human": {
  "command": "npx",
  "args": ["-y", "@askahuman/mcp", "serve"]
}}}
```
No checkout, no build, no flags — the published binary defaults to `wss://ask-a-human.ai/ws` +
`https://ask-a-human.ai`. The first `request_approval` opens a local browser page showing a short
pairing **code** (and also prints it to stderr); open the PWA at
[ask-a-human.ai/app](https://ask-a-human.ai/app) on your phone and **type the code** (RAM-only,
restart ⇒ re-pair). Override `--relay`/`--public-relay` to self-host.

The MCP server runs **on your machine** (stdio) on purpose: it holds the SPAKE2 key + plaintext, so it is
never hosted — only the content-blind relay is. See `docs/decisions/architecture/0011`.

## Security & trust

This is the whole point of the project:
- **Open-source + self-hostable** — read the code, run your own relay/PWA (`--relay` / `--public-relay`).
- **End-to-end encrypted** — plaintext only ever exists on your machine and your phone.
- **Content-blind relay** — it forwards `base64(nonce‖ciphertext)` verbatim and knows only which room-id
  talks to which. It cannot read, log, or replay your approvals.
- **No DB, no accounts** — pairing lives in RAM for the server's lifetime; a restart simply means re-pair.
- **Never auto-approves** — `request_approval` blocks until a real human answers (or it times out).

Found a bug? Report it — see [SECURITY.md](SECURITY.md). I patch and release fast.

## Crypto — the magic wormhole (see `docs/decisions/architecture/0002`)
Pairing borrows [Magic Wormhole](https://github.com/magic-wormhole/magic-wormhole)'s trick: a short,
human-readable code becomes a strong shared key via a **SPAKE2** PAKE (password-authenticated key
exchange). A passive *or* active relay can never read or forge the channel — and even if the short code leaks, an
attacker still gets only **one online guess** against the live handshake. We follow the SPAKE2
construction of [RFC 9382](https://www.rfc-editor.org/rfc/rfc9382.html) over the **ristretto255** group
([RFC 9496](https://www.rfc-editor.org/rfc/rfc9496.html)); the protocol glue (transcript, HKDF,
key-confirmation) is ours, so this is RFC 9382-*style*, not a byte-for-byte implementation. Foundations:
Abdalla & Pointcheval, *Simple Password-Based Encrypted Key Exchange Protocols* (CT-RSA 2005,
[doi:10.1007/978-3-540-30574-3_14](https://doi.org/10.1007/978-3-540-30574-3_14)); reference impl:
[`warner/python-spake2`](https://github.com/warner/python-spake2).

- **Pairing:** SPAKE2 over ristretto255 — Go uses `gtank/ristretto255`, the PWA uses `@noble/curves`;
  roles agent = A, phone = B. Go↔JS interop is pinned by `frontend/test/spake2-interop.mjs`.
- **App traffic:** **`nacl/secretbox`** (XSalsa20-Poly1305) keyed by the SPAKE2 session key (symmetric,
  so `secretbox` not `box`).

## Layout
| Dir | What |
|---|---|
| `backend/` | Go relay (`cmd/relay`) + MCP agent (`cmd/agent`); `pkg/spake2`, `pkg/sealedbox`, `pkg/wire` |
| `frontend/` | Astro 5 + React 19 + Tailwind 4 static PWA (9 screens, service worker, client crypto) |
| `npm/` | `@askahuman/mcp` wrapper — `postinstall` pulls the matching release binary, `bin/cli.js` execs it |
| `infra/` | `ctlptl`/`kind` cluster, `ko`/Tilt build, kustomize `base`/`local`/`prod` (GKE) |
| `docs/` | `plan.md` + `decisions/` (ADRs) — read these first |

## Local dev (Tilt + kind)
Requires Docker, plus `tilt`/`ko`/`ctlptl`/`kind` on `PATH` (`/opt/homebrew/bin`).
```bash
make up        # ctlptl cluster + registry, then `tilt up` (interactive UI at :10350)
# ...or headless:
make ci-up     # build (ko relay + docker web) → apply infra/local → wait healthy
```
Then:
- Relay: `http://localhost:8080/healthz` · WS `ws://localhost:8080/ws?room=<id>`
- PWA:   `http://localhost:8081/app`
- Pair manually: run `./bin/agent pair` (or `serve`) — it prints a short pairing **code**; open the
  PWA (`http://localhost:8081/app`) and **type the code** to pair, then approvals show up live.
```bash
make down      # tilt down + ctlptl delete (tears down the cluster + registry)
```

### From your iPhone (same Wi-Fi)
The kind cluster publishes the relay (`:8080`) and PWA (`:8081`) on all interfaces, so they're reachable at
this Mac's LAN IP. The agent points the phone at the LAN-IP relay; you type the printed code:
```bash
make pair                  # auto-detects LAN IP, prints a pairing code, sends one demo request
#   scripts/pair-lan.sh pair    # just hold pairing open    serve  # MCP server bound to the LAN IP
```
Open the PWA at `http://<lan-ip>:8081/app` on the iPhone and **type the printed code** → the PWA pairs over
SPAKE2 → approve/decline/choose/reply. If the page won't load, allow incoming connections for Docker in
System Settings → Network → Firewall.

**Plain http caveat (iOS secure-context rule):** over `http://<lan-ip>` the **service worker and Web Push
are disabled** — pairing (type the code) and all decisions still work.

**Want service worker + push?** Run a local HTTPS proxy (mkcert), trust its CA on the phone once:
```bash
make https                 # mkcert cert for the LAN IP + a TLS proxy on :8443 (keep it running)
HTTPS=1 make pair          # advertises wss://<lan>:8443/ws to the phone; agent still dials plain local
```
`make https` prints the `rootCA.pem` path — AirDrop it to the phone, install the profile (Settings →
General → VPN & Device Management), then enable full trust (Settings → General → About → Certificate Trust
Settings). After that `https://<lan-ip>:8443/app` is a secure context, so the service worker + push work. The
agent never needs the cert (it dials the relay over plain local `ws`); only the phone trusts the CA.

## Connect an agent from source (register the MCP server)
Build it: `make backend-build` → `./bin/agent`. Register the launcher (it binds to your LAN IP so a
phone can pair, and tees the pairing code to a log) as an MCP **stdio** server in your client —
Cursor `~/.cursor/mcp.json`, Claude Desktop `claude_desktop_config.json`, or Codex MCP config:
```json
{ "mcpServers": { "ask-a-human": {
  "command": "/ABS/PATH/ask-a-human/scripts/mcp-serve.sh"
}}}
```
That exposes one tool — `request_approval(title, category, summary, response_kind, options?,
placeholder?, max_len?, expires_in_s?)` — which **blocks until the human answers** (or times out;
never auto-approves). First call pairs: the pairing **code** is shown on an auto-opened local browser
page (loopback-only; the code is in the page body, never in a URL) **and** printed to the server's
stderr — **type the code** into the PWA on your phone. Pairing is held in RAM for that server's
lifetime (no DB); restart ⇒ re-pair.

Localhost-only (no phone)? Skip the launcher and point `command` at `./bin/agent` with
`"args": ["serve", "--relay", "ws://127.0.0.1:8080/ws"]`.

## Tests
```bash
make backend-test                         # go test ./...  (unit, -race)
( cd backend && go test -tags integration -race ./... )   # hermetic round trip + relay blindness + MCP
( cd frontend && bunx vitest run )        # 38 PWA/crypto unit tests
( cd frontend && node test/spake2-interop.mjs )           # Go↔JS SPAKE2 interop
make ci-up && make e2e                    # LIVE: integration vs kind relay + real PWA in headless Chromium
```
`make e2e` proves the whole path with nothing mocked: the MCP agent + relay-in-kind + the real PWA
(it spawns `agent ask`, drives headless Chromium to approve, asserts the agent gets the sealed decision).

## Production
The hosted relay + PWA at **[ask-a-human.ai](https://ask-a-human.ai)** run on a private GKE cluster.
`infra/prod` (kustomize) defines a `gce` ingress + `ManagedCertificate` + `BackendConfig` (long-lived-WS
timeout); each `v*` tag builds the `relay`/`web` images and rolls them out keylessly via Workload Identity
Federation — see [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). The registry, GCP
project, and cluster identity live **only** in GitHub Secrets, never in this repo. Prefer your own
infra? Self-host the relay + PWA and point the agent at them with `--relay` / `--public-relay`.
</content>
</invoke>
