# 0017 — Keyless (sigstore) release signing + SLSA provenance

**Status:** accepted · 2026-06-23

## Context
A tagged push runs `release.yml`: GoReleaser cross-compiles the agent, publishes a GitHub Release,
and writes `checksums.txt` (a sha256 over every archive). The npm wrapper `@askahuman/mcp` downloads
the matching archive on install (`npm/install.js`).

The release was **unsigned end-to-end**. `.goreleaser.yaml` emitted `checksums.txt` but had no
`signs:` block, and `release.yml` had no signing step. Anyone who can publish to the Release (a
compromised token, a malicious maintainer, a registry MITM) can swap a binary **and** regenerate a
matching `checksums.txt` — the checksum verifies the swapped artifact, so a downloader has no way to
tell a tampered release from a genuine one. The checksum proves integrity, not authenticity.

`release.yml` granted only `contents: write`. Keyless cosign/sigstore needs `id-token: write` (the
OIDC scope `deploy.yml` already uses for Workload Identity Federation), and SLSA build provenance
needs `attestations: write`.

## Decision
**Sign the release keylessly with sigstore, and attach SLSA build provenance to every archive.** No
key material is stored or committed — the GitHub Actions OIDC identity is the signer.

- **Sign the checksum, not each archive.** `checksums.txt` already chains to every archive via sha256,
  so a single cosign signature over it covers the whole release. GoReleaser's `signs:` block runs
  `cosign sign-blob --bundle=${artifact}.sigstore.json checksums.txt --yes`, producing one
  `checksums.txt.sigstore.json` bundle (certificate + signature combined). Verification checks the
  Rekor transparency-log entry and must constrain the certificate to this repository's release
  workflow, the expected version tag, and the GitHub Actions OIDC issuer.
- **SLSA build provenance** (`actions/attest-build-provenance`) is attached over the built archives
  (`dist/ask-a-human_*.tar.gz,*.zip`), recording who built what, from which commit, with which builder
  — verifiable with `gh attestation verify`.
- **Permissions:** `release.yml` gains `id-token: write` (sigstore OIDC) and `attestations: write`.
  `cosign` is installed by a pinned `sigstore/cosign-installer` step **before** GoReleaser
  (`goreleaser-action` does not bundle cosign).
- **No stored key.** Keyless means there is no long-lived signing key to leak, rotate, or commit —
  identity comes from the ephemeral OIDC token, the certificate is short-lived, and the proof of
  signing lives in the public Rekor transparency log.

Download `checksums.txt` and `checksums.txt.sigstore.json` from the same release, then set `VERSION`
to the version you intend to verify, without the `v` prefix:

```sh
VERSION=0.2.0
cosign verify-blob \
  --bundle checksums.txt.sigstore.json \
  --certificate-identity "https://github.com/askahuman/askahuman/.github/workflows/release.yml@refs/tags/v${VERSION}" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  checksums.txt
```

Both certificate constraints are required for keyless verification by the
[pinned cosign version](https://github.com/sigstore/cosign/blob/v2.6.1/cmd/cosign/cli/options/certificate.go).
After this succeeds, compare the downloaded archive's SHA-256 with its entry in the verified
`checksums.txt`.

## Consequences
- A downloader can verify the checksum file under the expected release workflow/tag identity, then
  check the archive against those signed checksums. Provenance additionally records the build source.
- **Composes with B2 (installer verification), via a deferred upgrade.** Today B2
  ([0019](0019_install_checksum_verify.md)) fetches `checksums.txt` and verifies the archive's sha256
  against it before extract — integrity, but **not** signature authenticity (it does not yet run
  `cosign verify-blob`). This signing work is what *enables* that upgrade: once shipped, the installer
  can fetch `checksums.txt.sigstore.json`, run `cosign verify-blob` to establish a **trusted**
  `checksums.txt`, then pin the archive sha256 to it. That signature-verification step (and its test:
  good bundle passes, tampered checksum fails) is the deferred B2 follow-up, not part of either change yet.
- **Deliberate ceilings** (marked in `.goreleaser.yaml`):
  - *Checksum-only signing.* We do not sign each archive individually — the checksum is the single
    anchor B2 needs, and it chains to every archive. Upgrade path: set `artifacts: archive` to sign
    each archive when per-artifact attestation is required.
  - *No SBOM.* No dependency provenance is shipped. Upgrade path: add a `sboms:` (syft) block when
    dependency-level provenance is required.
- CI-only change: no runtime or binary behavior changes. End-to-end signing first runs on the next
  real tag (`signs:` does not run on `build --snapshot`); `goreleaser check` guards the syntax now.
  Ref. [0011](0011_npx_distribution_stdio_local_mcp.md),
  [0014](0014_public_repo_and_distribution_identity.md).
