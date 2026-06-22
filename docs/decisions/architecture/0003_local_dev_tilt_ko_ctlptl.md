# 0003 — Local dev via ctlptl + kind + ko + Tilt

**Status:** accepted · 2026-06-20

## Context
Sibling projects use `make dev` + docker-compose + `air` + raw `kind load`. We want
a tighter, no-DB local loop where the *same* kustomize manifests run locally and in prod, with
live-reload. We have no database to spin up, which removes most of a typical dev rig.

## Decision
- **Cluster:** `ctlptl` provisions a `kind` cluster wired to a local image registry
  (`ctlptl` cluster + registry yaml in `infra/local/`).
- **Go image:** `ko` builds the relay (distroless, reproducible, no Dockerfile) — see
  `.ko.yaml`. The MCP agent is a plain `go build` binary (not an image).
- **Web image:** multi-stage Docker build of the Astro static bundle (mirrors the reference app's
  hardened Node-alpine pattern, but serving static files).
- **Orchestrator:** a `Tiltfile` builds both images, applies `infra/local`, port-forwards the
  relay and web, and live-updates on source change.
- Installed as prebuilt binaries (Apple CLT too old for brew source builds) into
  `/opt/homebrew/bin`: tilt 0.37.x, ctlptl 0.9.x, ko 0.18.x. `kind`, `docker`, `kubectl`,
  `gofumpt`, `golangci-lint`, Go 1.26, Node 26, bun already present.

## Consequences
- One command (`tilt up`) brings the whole system up in kind; `ctlptl delete` tears it down.
- Local and prod diverge only by kustomize overlay + image refs.
- ko/Tilt are a divergence from a typical rig — justified by the no-DB, two-image shape.
