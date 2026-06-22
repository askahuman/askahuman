# 0004 — Marketing landing at `/`, the PWA at `/app`

> Note: the agent deep link and `?p=`/`#p=` QR payload described below were dropped for code-only pairing ([0015](../architecture/0015_code_only_pairing.md)); only the `/` landing vs `/app` split decision stands.

**Status:** accepted · 2026-06-21

## Context
Going public ([[0014_public_repo_and_distribution_identity]]) changes who hits the root
URL. Today `ask-a-human.ai/` *is* the PWA: a stranger who lands there sees a bare
"scan / show-my-code" pairing screen ([[0002_full_pwa_states]]) with no explanation of
what the product is, who runs it, or why a sealed-approval relay can be trusted. An
open-source product that wants to spread needs a front door that builds trust, not a
function it doesn't understand yet.

## Decision
- **`/` is a marketing/trust landing page** — a catchy, indexable explainer (what it is,
  the E2E/relay-blind story, "get started" → the npx command, links to the public repo).
- **The PWA moves to `/app`** — every functional screen ([[0002_full_pwa_states]],
  [[0003_agent_roster_switcher]]) lives under `/app`.
- **Agent deep link → `<webOrigin>/app#p=<payload>`** (the agent's `DeepLink`,
  `internal/agent/display.go`). The private `#p=` fragment is unchanged
  ([[0006_pairing_payload_query_for_qr]]); only the path gains `/app`. The scan-safe
  `?p=` QR form rewrites to `/app?p=` the same way.
- **PWA manifest `start_url` + `scope` → `/app`.** Only `/app` is installable and
  service-worker-scoped; the landing is a plain indexable page (SEO / Open Graph tags),
  never prompts "Add to Home Screen," and is not part of the app shell.

## Consequences
- First-time visitors get context and trust before any pairing UI; the installed app is
  unchanged for existing users (it launches straight into `/app`).
- Indexing splits cleanly: the landing is crawlable/shareable; `/app` stays a private,
  no-index application surface — keeping room ids / payloads out of search exactly as the
  no-referrer / path-only-logging guards intend ([[0006_pairing_payload_query_for_qr]]).
- Any place that builds a pairing URL must carry the `/app` segment — agent `DeepLink`,
  QR renderer, manifest. A link to bare `/#p=` would now land on the marketing page and
  never pair; covered by the `DeepLink` test.
- Skipped for now: a separate marketing domain/subdomain and a CMS for the landing copy —
  a static page under `/` is enough until the copy needs to change without a deploy.
