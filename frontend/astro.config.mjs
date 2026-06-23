import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import AstroPWA from "@vite-pwa/astro";

// Dark palette anchor from the design mockup (renderVals().page).
const THEME_COLOR = "#08090c";

// ref. https://vite-pwa-org.netlify.app/frameworks/astro
// output 'static' => pure static dist/, no Node server at runtime (architecture/0004).
export default defineConfig({
  output: "static",
  // CSP: the PWA is the only key-holding party, so an XSS/clickjack defeats E2E.
  // Astro emits a <meta http-equiv="content-security-policy"> at build time and
  // auto-computes the sha256 for EVERY inline <script>/<style> it generates
  // (anti-FOUC + the astro-island hydration bootstraps + the display:contents
  // style). Manual hashing in nginx would silently break on any Astro bump; this
  // stays in sync per build. frame-ancestors/HSTS live in nginx.conf because a
  // <meta> CSP cannot enforce frame-ancestors (spec: meta-delivered CSP ignores
  // it) — see frontend/nginx.conf. ref. https://docs.astro.build/en/reference/experimental-flags/csp/
  experimental: {
    csp: {
      directives: [
        "default-src 'none'",
        "img-src 'self' data:",
        // Fonts ship both inlined (data:) and as /_astro/*.woff2 ('self'); without
        // this they fall back to default-src 'none' and the whole UI loses its
        // typeface. Keep in sync with nginx.conf $sec_csp.
        "font-src 'self' data:",
        "manifest-src 'self'",
        "worker-src 'self'",
        // wss: for the dynamic relay (host not known at build time); ws: for localhost dev.
        // This stays a scheme-wildcard ON PURPOSE: this one prebuilt bundle is served to
        // self-hosters / Advanced-relay users whose relay origin is unknown at build time,
        // and to astro dev/preview on localhost (ws:). The prod nginx header pins
        // connect-src to wss://ask-a-human.ai (it knows the hosted origin); the browser
        // enforces the intersection. ref. frontend/nginx.conf $sec_csp (m6-csp-egress).
        "connect-src 'self' wss: ws:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ],
    },
  },
  integrations: [
    react(),
    AstroPWA({
      // autoUpdate: a new SW activates as soon as the static bundle changes.
      registerType: "autoUpdate",
      // injectManifest: hand-written SW (src/sw.ts) so we can add the Web Push
      // 'push' + 'notificationclick' handlers (plan §7) on top of precaching.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      manifest: {
        name: "ask-a-human",
        short_name: "ask-a-human",
        description:
          "End-to-end-encrypted approvals from your AI agents, on your phone.",
        display: "standalone",
        orientation: "portrait",
        // The installed app opens the PWA (pairing screen) at /app; the marketing
        // landing lives at / and is intentionally outside the PWA scope.
        start_url: "/app",
        scope: "/app",
        theme_color: THEME_COLOR,
        background_color: THEME_COLOR,
        icons: [
          { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      injectManifest: {
        // Precache the static shell; the relay WS traffic is never cached.
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
