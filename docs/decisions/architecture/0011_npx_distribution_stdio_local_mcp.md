# 0011 — Distribute the MCP agent as a copy-paste `npx` command; keep it stdio-local

**Status:** accepted · 2026-06-21

## Context
Goal: make the project frictionless to adopt ("go viral") — ideally one copy-paste
MCP config block, no source checkout, no local infra. Today the agent is built from
source (`scripts/mcp-serve.sh` → `go build` → `./bin/agent serve`) and dials a
localhost relay/PWA; there is no published artifact (no `go install` path, no npm
package, no release binaries).

Two shapes were considered for "copy-paste MCP":
1. **Remote/hosted MCP** (config is just a URL, HTTP/SSE transport).
2. **Local stdio MCP** delivered via a package manager (the `command` needs no build).

## Decision
- **The MCP server stays a local stdio process** (`mcp.StdioTransport`, unchanged).
  A hosted MCP would hold the SPAKE2 pairing key and plaintext approvals, breaking the
  core invariant that *only the user's machine sees plaintext* — the relay sees only
  ciphertext. Ref. [[0002_spake2_ristretto255_secretbox]], [[0005_relay_ramonly_agent_retries]].
- **Primary distribution channel: npm wrapper `@askahuman/mcp`** (`npm/`). Copy-paste
  config `command: "npx", args: ["-y", "@askahuman/mcp", "serve"]`. A `postinstall`
  (`npm/install.js`, zero npm deps) downloads the prebuilt binary matching the host
  OS/arch from the GitHub Release, the `bin/cli.js` shim execs it with stdio inherited.
- **Releases via GoReleaser + GitHub Actions** (`.goreleaser.yaml`,
  `.github/workflows/release.yml`): tag `vX.Y.Z` → cross-compiled archives
  (darwin/linux/windows × amd64/arm64) named `ask-a-human_<os>_<arch>.<ext>` →
  npm publish `@askahuman/mcp@X.Y.Z`. The asset name is the contract between
  GoReleaser and the installer.
- **Release builds bake the hosted endpoints** via `-ldflags -X main.defaultRelayURL=...
  -X main.defaultWebOrigin=...` so the npx command is zero-config. The defaults were
  changed from `const` to `var` (`backend/cmd/agent/pair.go`); a plain `go build` keeps
  the localhost dev defaults. Both stay overridable by `--relay`/`--web` flags.

## Consequences
- Adoption is one paste + typing an 8-char code on a phone; no Go toolchain, no checkout, no local relay.
- The hosted relay + PWA become a hard dependency of the default install — tracked
  separately. Ref. [[0012_deploy_hosted_relay_pwa]].
- Channel reach is "anyone with Node". `go install` and a curl installer remain easy
  follow-ons (same release artifacts) but were not built now.
- Supply-chain surface: the postinstall fetches a binary over HTTPS from GitHub
  Releases. Mitigation path (not yet wired): verify against the published
  `checksums.txt`. Marked as the upgrade ceiling in `npm/install.js`.
