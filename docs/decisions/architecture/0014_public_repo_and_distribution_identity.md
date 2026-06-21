# 0014 — Go public as one repo `askahuman/askahuman`; rename module + scope npm

**Status:** accepted · 2026-06-21

## Context
We are open-sourcing the project. Today it lives under the maintainer's personal
account (Go module the same), the npm package
is the unscoped `ask-a-human-mcp` ([[0011_npx_distribution_stdio_local_mcp]]), the
website is `ask-a-human.ai` ([[0012_deploy_hosted_relay_pwa]]), and the history
contains private GCP identifiers and (previously) a committed private key. Open-sourcing
under those names invites squatting, ties the project to one person's account, and risks
leaking private infra into a public log/history.

Naming options: keep the hyphenated `ask-a-human` everywhere; or move to a stable org.
npm options: keep unscoped `ask-a-human-mcp` (free, but unscoped names are first-come and
squat-able); use the unscoped `askahuman-mcp` (already taken by an unrelated project); or
a scope.

## Decision
- **Single public repo: `github.com/askahuman/askahuman`** under a dedicated org — one
  repo for backend + frontend + infra, not a split ([[0001_split_repos]] stays the
  *internal* layout). The product website remains `ask-a-human.ai`.
- **Go module rename** from the personal-account path →
  `github.com/askahuman/askahuman`. The import path is now org-owned and account-portable.
- **Scoped npm package `@askahuman/mcp`** (`publishConfig.access=public`); the copy-paste
  command becomes `npx @askahuman/mcp serve`. The scope blocks squatters and matches the
  org. We did not keep unscoped `ask-a-human-mcp` (squat-prone) and could not take
  `askahuman-mcp` (owned by an unrelated project).
- **Redact private identifiers.** GCP project / Artifact Registry / cluster ids become
  placeholders in the tree and are injected from CI secrets at deploy
  ([[0013_deploy_wif_namespace_hardened]]) — never committed.
- **Publish with clean history.** Copy into the new repo as a fresh tree
  (`rm -rf .git && git init`, repo-local author identity, one initial commit). No
  personal-account history, no resurrected secrets, no force-push to rewrite a shared
  remote.
- **Ongoing guard.** `gitleaks` secret-scan CI on push/PR (`.github/workflows/secret-scan.yml`)
  plus GitHub push protection.

## Consequences
- The npx/module/import contracts all change in one cut; the earlier baked-endpoint
  ldflags and asset-name contract ([[0011_npx_distribution_stdio_local_mcp]]) move with
  the rename and must be updated together (any stale old-namespace import or
  `ask-a-human-mcp` reference is a release break).
- Clean history means the public repo starts at commit 1 — the link between public and
  private history is intentionally cut; the private working copy keeps the full log.
- The earlier purge of a committed private key from history is the reason clean-init is
  the floor, not just a `.gitignore` add: the only reliable scrub of a leaked secret is a
  history that never contained it. Scan CI + push protection catch the *next* one.
- Cost of the scope: publishing `@askahuman/*` requires the npm org to exist and the
  publish token to be org-scoped — a one-time setup, kept out of the repo.
