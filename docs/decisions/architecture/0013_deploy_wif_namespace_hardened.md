# 0013 — Deploy via keyless WIF into a hardened, isolated `ask-a-human` namespace

**Status:** accepted · 2026-06-21

## Context
The hosted relay + PWA ([[0012_deploy_hosted_relay_pwa]]) target a private GKE
cluster. The follow-on flagged in 0012 was "a CI job to build/push images + apply
on tag." Standing that job up raises three questions: how does CI authenticate to a
private GCP project, where do the workloads land on the cluster, and how do we
not leak the private identifiers / any secrets to a public log once the repo is open
([[0014_public_repo_and_distribution_identity]]).

A deploy anti-pattern to avoid: a pipeline that runs
`sops --decrypt --in-place` then `kubectl apply -k`. On any apply failure the
plaintext `Secret` manifest is echoed to the (now public) Actions log — GitHub masks
registered secrets, but it does **not** mask values SOPS decrypts at runtime, and
`set -x` / `-o yaml` dumps make it worse.

## Decision
- **Isolated namespace.** Relay + web deploy to a **dedicated** `ask-a-human` namespace.
  The deployer SA is granted `edit` on that namespace only (a
  RoleBinding, not cluster-admin), so a compromised pipeline can't touch other
  workloads on the cluster.
- **Keyless auth via Workload Identity Federation.** CI authenticates through the
  **reused** WIF pool/provider already on the project, impersonating a **dedicated
  deployer SA** — no long-lived JSON key in the repo or in GitHub Secrets. The OIDC
  trust is scoped to this repo.
- **Tag-triggered, owner-gated.** `.github/workflows/deploy.yml` runs automatically on
  a `v*` tag (same trigger that publishes npx, [[0011_npx_distribution_stdio_local_mcp]]);
  what reaches a tag is gated by CODEOWNERS (a single code owner) + required review.
- **No SOPS, by construction.** Relay + web carry **zero server-side secrets**. The
  only secret in the system is the VAPID *private* key, which is **agent-side env only**
  ([[0010_push_vapid_configured_shared_key]]) and never ships to the cluster. With no
  Secret manifest to decrypt, the SOPS-leak path above does not exist here.
- **Hardened pipeline.** No `set -x`, no `env` dumps, no `kubectl ... -o yaml` on
  manifests in the logged steps. Private project / Artifact Registry / cluster
  identifiers are injected from GitHub Secrets (masked), never committed.

## Consequences
- A `v*` tag now builds, pushes, and rolls out relay + web with no human cloud step —
  closing the manual gap 0012 left open.
- Blast radius is confined to the one namespace; other workloads on the cluster are
  unaffected by our deploys and vice-versa.
- We avoid that secret-leak class entirely *because* the relay is
  secret-free — this is a property to preserve: do not add a server-side Secret without
  revisiting this ADR (it would reintroduce the decrypt-then-apply log-leak risk).
- WIF means no key to rotate or leak; the cost is the one-time IAM setup (pool binding +
  deployer SA + namespace RoleBinding), which lives in the private project, not the repo.
