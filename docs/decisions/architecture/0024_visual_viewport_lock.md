# 0024 — Visual-viewport-locked app shell (iOS keyboard)

Date: 2026-07-07
Status: accepted

## Context

On iOS, the on-screen keyboard does not resize the layout viewport: WebKit
overlays it and then **scrolls/pans the page** to reveal the focused input.
For our full-viewport PWA (every screen is a fixed-height `Frame`, nothing is
meant to scroll as a document) that produced two visible bugs on the free-text
reply card:

1. While typing, the page was focus-scrolled so the input floated mid-screen
   with black gaps above and below and the request card pushed off-screen.
2. After replying, the focus-scroll offset stuck: the whole app sat misaligned
   (status bar overlapping the roster) and the page could be dragged up/down.

`100dvh` cannot express "the area above the keyboard" — dynamic viewport units
track browser chrome, not the keyboard.

## Decision

Lock the document and track the *visual* viewport instead:

- `body.app-shell { position: fixed; inset: 0; overflow: hidden }`
  (global.css). The app never scrolls as a document, so iOS focus-scroll can
  leave no residual offset. Applies only to the app shell; the marketing
  landing keeps normal scrolling.
- `useVisualViewportLock` (App.tsx) listens to `visualViewport` resize/scroll
  and publishes `Math.round(height * scale)` as `--app-vvh` on `<html>`, and
  resets any leftover `window` scroll to (0,0). Scale correction keeps
  pinch-zoom from shrinking the layout: only the keyboard (scale stays 1)
  changes the effective height.
- Every screen sizes with `height: var(--app-vvh, 100dvh)` (Frame +
  PairScreen). With the keyboard open the whole screen compresses to the
  visible area, so the reply input lands directly above the keyboard and the
  card stays on-screen; the text card gets `min-height: 0` + `overflow-y:
  auto` so it shrinks and scrolls internally when compressed.

No `visualViewport` (very old browsers) → the var is never set and the
`100dvh` fallback preserves today's behavior.

## Alternatives rejected

- `interactive-widget=resizes-content` viewport meta: not supported by iOS
  Safari (the platform with the bug); Android Chrome already shrinks the
  visual viewport, which the hook handles uniformly.
- Translating just the input bar above the keyboard: keeps the card at full
  height but needs per-screen transforms and still requires the document lock;
  strictly more moving parts for the same result.

## Consequences

- The keyboard now compresses all screens uniformly; any future screen gets
  keyboard-safe layout for free by using `Frame`.
- Nothing in the app may rely on document scrolling (already true: all nine
  screens are fixed-height; the roster scrolls horizontally within itself).
- `effectiveViewportHeight` is the unit-tested slice (test/viewport.test.ts);
  the listener wiring rides the existing PWA e2e.
