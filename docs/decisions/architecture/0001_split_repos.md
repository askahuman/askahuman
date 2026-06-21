# 0001 — Split into backend / frontend / infra, two images

**Status:** accepted · 2026-06-20

## Context
`ask-a-human` is one product but three independently-shippable units: a Go relay + MCP
agent (backend), an Astro PWA (frontend), and Kubernetes/Tilt config (infra). The agent
and the phone are two clients on different networks; the relay is their meeting point.

## Decision
- Top-level split: `backend/`, `frontend/`, `infra/`. No shared build coupling.
- **Two container images**, built and pushed independently:
  - `ask-a-human-relay` — the Go relay (the only thing that runs server-side).
  - `ask-a-human-web` — the static PWA bundle, served by a tiny static server.
- The **MCP agent** is a Go binary that runs next to the LLM client (Cursor/Claude/Codex),
  not a server image. It is built/distributed as a binary, not deployed to the cluster.
- Local dev and prod share the same two images; only kustomize overlays differ.

## Consequences
- Frontend and backend deploy, scale, and roll back on their own cadence.
- The relay image stays minimal (distroless via `ko`); the web image is just static files.
- Cross-cutting contracts (wire frames, SPAKE2 params, message schemas) must be kept in
  sync by tests, not by a shared module — see [[0002_spake2_ristretto255_secretbox]].
