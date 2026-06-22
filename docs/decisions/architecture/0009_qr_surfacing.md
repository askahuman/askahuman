# 0009 — QR pairing surfacing: scannable `?p=` terminal QR + `pair_status` MCP tool

> **Superseded by [0015](0015_code_only_pairing.md) (2026-06-22): the terminal QR was dropped;
> the agent now prints a short code the human types at `/app`. `pair_status` remains; a new
> `start_pairing` tool was added. Kept for decision history.**

**Status:** superseded · accepted 2026-06-21

## Context
Pairing was unscannable from an iPhone and only surfaced via a fragile bash watcher.

- `PrintPairing` (`backend/internal/agent/display.go`) encoded the deep link
  `<web>/#p=<payload>` in the terminal QR. iOS Camera **drops the URL fragment**
  (ref. [[0006_pairing_payload_query_for_qr]]), so the QR could not pair an iPhone — the
  HTML renderer already rewrites to `?p=`, but the terminal path did not.
- The only way to get a scannable QR was `scripts/mcp-serve-lan.sh`'s `tail -F` watcher:
  it greps the stderr pair-log, shells out to node + the `qrcode` npm dep, writes HTML,
  and `open`s it. Fragile (PATH, line-format coupling, detached job).
- go-sdk (`github.com/modelcontextprotocol/go-sdk v1.6.0`) surfacing channels:
  - `ServerSession.Log` is **silently dropped** unless the client first sent
    `logging/setLevel` (Cursor/Claude/codex do not reliably set a level). Unreliable.
  - `NotifyProgress` needs a `progressToken` and renders a progress bar, not scannable
    text. Wrong shape.
  - A **tool RESULT** (`CallToolResult.Content`) IS rendered in-window by every MCP
    client. The only reliable "show in the agent window" channel.

## Decision
1. **Terminal QR is now scannable.** `ScanURL(webOrigin, payload) = "<web>/?p=<payload>"`
   (mirrors `render-pair-page.mjs` and ADR 0006). `PrintPairing` encodes the QR from
   `ScanURL` at **`qrcode.Low`** (bigger modules → easier phone scan) and keeps the
   clickable `link:` line as the private `#p=` `DeepLink` (a clicked fragment survives).
2. **`pair_status` MCP tool (read-only).** Returns a `CallToolResult` whose single
   `TextContent` is markdown: a fenced ASCII QR of `ScanURL`, the scan URL, the clickable
   deep link, the manual code, and the room. It renders the QR **in the agent chat on
   demand** — the only channel every client renders. The pairing is lifted into an
   `MCPServer.pairing` field (set in `pairOnce`, `mu`-guarded) so the QR shown is the exact
   one `request_approval` is waiting on. If **no** pairing exists yet, it returns
   `"no active pairing — call request_approval first"` and does **not** mint one
   (lazy-create would start a SPAKE2 handshake the human may never scan; that is the
   marked upgrade path). If already paired, it returns a "paired" line.

### Rejected / cut
- **MCP `Log` / `NotifyProgress`** — gated/wrong-shape per Context above.
- **Scope item B (`--open-qr` Go-native browser page + `WritePairPage`)** — cut from v1.
  Heaviest rung (os/exec opener, `runtime.GOOS` switch, 1024px base64 PNG, temp file,
  rewriting `mcp-serve-lan.sh`) and duplicates the `pair_status` channel that already
  renders in every client. MUST-DO + `pair_status` fully solve "unscannable + fragile
  watcher". The bash watcher is left **untouched** in v1 (no `scripts/` change). Revisit B
  if a no-terminal / no-agent-window path is needed.

## Consequences
- Pairing now scans from the iPhone Camera over plain-LAN http (within ADR 0006's accepted
  `?p=` trade-off; relay still only ever sees `base64(nonce‖ciphertext)`).
- **New surface (accepted):** `pair_status` renders the SPAKE2 code + `?p=` URL as a tool
  result, so the code can land in the MCP client's chat transcript/history (Cursor/Claude/
  codex may persist it). Beyond ADR 0006's terminal+camera surfaces. Mitigation is the same
  single-online-guess SPAKE2 bound + key-confirmation abort (ref. [[0002_spake2_ristretto255_secretbox]])
  — a logged code is low-risk, not a key compromise. Documented, not gated.
- **ECC ceiling:** the terminal QR drops from `Medium` to `Low` (least damage tolerance);
  acceptable for a short LAN payload on a clean terminal. First knob to revisit if scans
  fail on noisy/low-contrast displays.
- Additive only: `request_approval` flow and existing tests are untouched.
