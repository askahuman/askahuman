// effectiveViewportHeight drives --app-vvh (the app-shell height while the iOS
// keyboard is open, ADR 0024). Pure math, so it is the unit-testable slice of
// useVisualViewportLock — the DOM listener wiring is exercised by the PWA e2e.
import { describe, expect, it } from 'vitest';

import { effectiveViewportHeight } from '../src/components/App.tsx';

describe('effectiveViewportHeight', () => {
  it('passes the visual viewport height through at scale 1', () => {
    expect(effectiveViewportHeight(844, 1)).toBe(844);
  });

  it('shrinks with the keyboard (scale stays 1)', () => {
    expect(effectiveViewportHeight(438, 1)).toBe(438);
  });

  it('is scale-corrected so pinch-zoom does not shrink the layout', () => {
    // Zoomed 2x: the visual viewport shows half the height; the layout keeps its size.
    expect(effectiveViewportHeight(422, 2)).toBe(844);
  });

  it('rounds fractional CSS px', () => {
    expect(effectiveViewportHeight(843.6, 1)).toBe(844);
  });

  it('rejects unusable readings, keeping the 100dvh fallback', () => {
    expect(effectiveViewportHeight(0, 1)).toBeNull();
    expect(effectiveViewportHeight(Number.NaN, 1)).toBeNull();
    expect(effectiveViewportHeight(844, Number.NaN)).toBe(844); // scale falls back to 1
    expect(effectiveViewportHeight(-100, 1)).toBeNull();
  });
});
