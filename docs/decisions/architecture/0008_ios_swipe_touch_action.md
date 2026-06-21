# 0008 — iOS PWA swipe: root-level touch-action/overscroll lock + pointercancel-commit

**Status:** accepted · 2026-06-21

## Context
The YesNoScreen approve/decline swipe worked on desktop but did nothing on iPhone (Safari +
standalone PWA); the APPROVE/DECLINE buttons worked. Three compounding root causes:

1. **touch-action scoped too narrowly.** Only the card div had `touch-action:none`
   (`screens.tsx`). The `Frame`, `<body>`, and `html` allowed default touch behavior, so iOS owned
   horizontal pan — the left screen edge is reserved for back-navigation and the page can
   rubber-band. A left→right drag (or any drag begun near the edge) was claimed by the system
   edge-pan/scroll recognizer before/while the card saw it. A card-only `touch-action` cannot
   override an ancestor that already started a pan.
2. **pointercancel treated as a reset.** `onPointerCancel={onUp}` reset the card to center when iOS
   reclaimed the gesture mid-drag, so a hijacked (and even a past-threshold) swipe looked dead.
   `setPointerCapture` does not reliably retain a touch pointer once an ancestor scroll/pan is
   recognized — and that recognition is exactly what fires the cancel.
3. **No preventDefault on move, no `-webkit-*` hardening.** `onMove` never called
   `preventDefault()`, leaving the browser free to keep interpreting the move as scroll/selection;
   `-webkit-user-select` / `-webkit-touch-callout` were unset, so long-press selection/callout
   could interrupt.

## Decision
Lock touch at the root, stop treating cancel as a no-op, preventDefault the move. No rewrite —
buttons + drag stay. Minimal rung (stdlib CSS + native PointerEvent + one pure function):

- **`global.css`:** `html, body { overscroll-behavior: none; touch-action: pan-y; }` (allow
  vertical scroll, suppress horizontal/back-swipe + rubber-band) and `-webkit-user-select:none;
  user-select:none; -webkit-touch-callout:none;` on `body`. Applies to standalone PWA too.
- **`Frame` (`screens.tsx`):** `touchAction:'pan-y'` so the ancestor between body and card also
  yields horizontal. Card keeps `touchAction:'none'` (owns both axes once the drag is on it) plus
  `WebkitUserSelect:'none'`, `WebkitTouchCallout:'none'`.
- **Card handlers:** `onMove` calls `if (e.cancelable) e.preventDefault()` once dragging (cancelable
  on a `touch-action:none` element; guarded for a future ancestor that re-enables touch).
  `onPointerUp` and `onPointerCancel` share one `settle()` path — a past-threshold drag commits even
  on cancel; `commit()` is idempotent (`committed.current`) so up+cancel can't double-fire.
- **Pure decision:** `export function swipeOutcome(dx, commitPx): 'approve'|'decline'|'reset'`
  (`|dx|>commitPx` decides). `cancelled` is **not** a parameter — the rule is identical for up and
  cancel, so the flag would be dead. Unit-tested without a DOM env (`test/swipe.test.ts`).

## Consequences
- `overscroll-behavior:none` + `touch-action:pan-y` on `html/body` would disable horizontal scroll
  elsewhere; safe — every screen is a fixed 100dvh `Frame` with `overflow:hidden`, no horizontal
  scroll regions exist.
- **Ceiling:** `touch-action:pan-y` blocks pinch-zoom on the page. Acceptable for a single-action,
  portrait-locked, `display:standalone` approval PWA. Revisit if a zoomable surface is added.
- Service worker precaches `global.css`; a deployed device may need a SW update/hard reload to pick
  up the new rules (autoUpdate handles it; first load after deploy can be stale).
- **Skipped:** a Playwright touch-emulation drag test (no browser test tier / jsdom configured).
  The pure `swipeOutcome` vitest test covers the commit math + cancel-rescue. Add the Playwright
  drag (`pointerdown→pointermove(>110px)→pointerup` over `[data-testid=yesno-card]`) when a browser
  tier exists.
