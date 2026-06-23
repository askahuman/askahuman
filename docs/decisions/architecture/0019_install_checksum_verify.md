# 0019 — Verify the downloaded binary's sha256 before install

**Status:** accepted · 2026-06-23 · refines [0011](0011_npx_distribution_stdio_local_mcp.md)

## Context
`npm/install.js` (the `@askahuman/mcp` postinstall) downloads the prebuilt `ask-a-human`
binary from the GitHub Release and `chmod +x`'d it with **no integrity check** — the
exact upgrade ceiling [0011](0011_npx_distribution_stdio_local_mcp.md) flagged. The
binary is privileged: it holds the SPAKE2 pairing key and sees plaintext approvals
([0002](0002_spake2_ristretto255_secretbox.md), [0011](0011_npx_distribution_stdio_local_mcp.md)),
so a swapped binary is a full compromise of the local trust boundary.

Three concrete gaps (security review B2, HIGH, supply-chain):
- **No integrity gate.** Any archive that downloaded was extracted and made executable.
- **Transport downgrade.** The downloader picked its client per-hop from the URL scheme,
  so a `3xx` to `http://` silently downgraded a release fetch to cleartext (MITM-able).
- **Ungated redirects + mirror.** Redirects were followed to any host, and
  `AAH_BINARY_BASEURL` was honored without constraint.

GoReleaser already publishes `checksums.txt` (default sha256, `name_template:
checksums.txt`) to the **same release** as the archives (`.goreleaser.yaml`). The fix
should consume what already ships — zero new release machinery, zero new npm deps
(node ≥18 gives `URL` + `crypto` as builtins).

Considered and rejected for now:
- **cosign / SLSA provenance signature verification.** Strongest, but needs a signing
  key in the release pipeline and a verifier in the installer (a real dep or a bundled
  public key). Deferred to the release-signing work (mediums #1).
- **Pin the digest by embedding it in the published npm package.** The end-state (the
  package and the binary it fetches are version-locked byte-for-byte), but it requires
  the release-then-publish ordering to thread the digest into `install.js`/`package.json`.
  Out of scope here.

## Decision
**Fail-closed sha256 verification in `install.js`, before extract + chmod**, plus
transport hardening. install.js-only; no new deps.

- **Integrity (fail-closed).** Compute `sha256(archive)` and compare to an expected
  digest resolved in priority order:
  1. `AAH_BINARY_SHA256` env — an **out-of-band pin** (air-gapped / self-rebuilt mirror);
  2. else `${base}/checksums.txt` from the same base/tag, parsed in GoReleaser's format
     (`<64-hex>␠␠<filename>`, whitespace-tolerant), matching the line whose filename is
     our asset.
  If no expected digest can be determined, or the digests differ → **fail and do not
  extract**. Extract + chmod happen only on a match. This is **TLS-TOFU-on-the-tag**:
  we trust the TLS connection to the release to deliver an honest `checksums.txt`, then
  pin every byte of the archive to it.
- **Transport.** Reject any non-`https:` URL (kills the per-hop `http://` downgrade).
  Always use the https client. On a `3xx`, resolve `Location` and check the resolved host
  against an allowlist before recursing: `github.com`, `*.githubusercontent.com` (suffix
  match — GitHub rotates the asset CDN subdomain), and the host of `AAH_BINARY_BASEURL`
  when set. Keep the existing `redirects > 10` cap.
- **Escape hatches unchanged.** `AAH_SKIP_DOWNLOAD` still self-places the binary;
  `AAH_BINARY_SHA256` covers mirrors that cannot serve `checksums.txt`.

## Consequences
- A tampered or wrong-arch archive can no longer reach disk as an executable; the install
  fails with the existing manual-install message. Verified by a throwaway https/http mock
  (byte-flipped archive, `http://` base, off-allowlist redirect — each fails closed before
  extract) plus an in-process self-check on the `checksums.txt` parser.
- **Self-host behavior change.** A custom `AAH_BINARY_BASEURL` mirror must now serve
  `checksums.txt` over **https** (matching the archives) **or** the installer must be given
  `AAH_BINARY_SHA256`. Plain `http://` mirrors are rejected. Operators who place the binary
  by hand keep using `AAH_SKIP_DOWNLOAD`. Documented in the README self-hosting section.
- **Threat model honesty.** TLS-TOFU-on-the-tag stops network-position attackers and
  downgrade, but not a compromised GitHub release (the attacker who rewrites the archive
  can also rewrite `checksums.txt`). Closing that needs **cosign/SLSA signature
  verification** — deferred to the release-signing work; **pin-by-embedded-digest** is the
  future end-state. Both noted above as the upgrade path.
