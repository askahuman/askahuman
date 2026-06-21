# 0012 — Host the relay + PWA at `ask-a-human.ai` (GKE) as the default endpoint

**Status:** accepted · 2026-06-21 · _implementation pending cloud auth_

## Context
The npx distribution ([[0011_npx_distribution_stdio_local_mcp]]) bakes hosted
endpoints into release binaries so `npx @askahuman/mcp serve` is zero-config. That
only works if a relay + PWA are publicly reachable. Today both are localhost/kind
only; `infra/prod` scaffolds a GKE deploy (`ask-a-human.ai`, `gce` ingress +
`ManagedCertificate` + `BackendConfig` for long-lived WS) but the repo never pushes
images or applies to a live cluster (README "Production (scaffolded, not deployed)").

Alternative considered: a cheaper single VM / Fly.io / Cloud Run host.

## Decision
- **Finish the scaffolded GKE deploy at `ask-a-human.ai`** rather than stand up a new
  single-host platform. The manifests, ingress, managed cert, and WS-timeout
  `BackendConfig` already exist in `infra/prod`; reusing them is the shortest path and
  keeps the relay's blindness/no-DB properties intact ([[0005_relay_ramonly_agent_retries]]).
- Default release endpoints: relay `wss://ask-a-human.ai/ws`, PWA `https://ask-a-human.ai`
  (the ldflags in `.goreleaser.yaml`).

## Required steps (need GCP/DNS access — not executable from this repo)
1. Build + push images: `relay` (ko) and `web` (static PWA) to
   `<artifact-registry>/ask-a-human/{relay,web}:VERSION`.
2. Reserve global static IP `ask-a-human-global-ip`; point `ask-a-human.ai` DNS at it.
3. Set `VERSION` and `kubectl apply -k infra/prod` against the private GKE cluster.
4. Build the PWA with `PUBLIC_RELAY_URL=wss://ask-a-human.ai/ws` so the phone dials the
   same relay the agent does.

## Consequences
- The hosted relay/PWA become the default trust + availability dependency for every
  npx install. Relay still sees only ciphertext + room ids; outage ⇒ re-pair, no data loss.
- Until deployed, released binaries point at a domain that does not yet resolve — do not
  cut a `v*` tag (which would publish npx) before steps 1–4 are done. Dev `go build`
  stays on localhost and is unaffected.
- Follow-on: a CI job to build/push images + apply on tag would remove the manual steps;
  deferred until the first manual deploy proves the path.
