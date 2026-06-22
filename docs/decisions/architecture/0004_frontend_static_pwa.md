# 0004 — Frontend is a static Astro PWA (no SSR)

**Status:** accepted · 2026-06-20

## Context
`the reference app` (our Astro reference) uses SSR with `@astrojs/node` because it has server endpoints
(waitlist API). Our PWA has **no server logic**: it is a content-blind client that does all
crypto in-browser and talks only to the relay over WebSocket. PWAs/service workers/Web Push
require a secure context (HTTPS) and benefit from aggressive static caching + SRI pinning.

## Decision
- Mirror the reference app's stack (Astro 5 + React 19 islands + Tailwind 4 + bun) but set
  `output: 'static'` — `astro build` emits a pure static `dist/`.
- Add what the reference app lacks: `vite-plugin-pwa` (service worker + Web App Manifest), client crypto
  (`@noble/curves`, `tweetnacl`), QR generate + camera scan.
- Serve `dist/` from a minimal hardened static container; no Node server at runtime.
- Design tokens (fonts JetBrains Mono + IBM Plex Sans, accent approve `#39d98a` /
  decline `#ff5d52`, category badge palette, dark+light) come from the initial design in
  `frontend/initial-design/` and the reference app's `global.css` conventions.

## Consequences
- Smaller, cacheable, SRI-pinnable bundle; honors the "browser-delivered crypto" hardening in
  plan §11.1.
- React is used only as Astro islands for the interactive card/pairing screens; the shell is
  static HTML/CSS.
- Divergence from the reference app (SSR) is justified: no server-side work exists to do.
