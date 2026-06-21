// Unit tests for the swipe commit decision (YesNoScreen). Pure function so the
// commit math + iOS cancel-rescue are covered without a DOM env (no jsdom here).

import { describe, expect, it } from 'vitest';

import { swipeOutcome } from '../src/components/screens.tsx';

const COMMIT_PX = 110;

describe('swipeOutcome', () => {
  it('past +commitPx -> approve', () => {
    expect(swipeOutcome(130, COMMIT_PX)).toBe('approve');
  });
  it('past -commitPx -> decline', () => {
    expect(swipeOutcome(-130, COMMIT_PX)).toBe('decline');
  });
  it('within +commitPx -> reset', () => {
    expect(swipeOutcome(50, COMMIT_PX)).toBe('reset');
  });
  it('within -commitPx -> reset', () => {
    expect(swipeOutcome(-50, COMMIT_PX)).toBe('reset');
  });
  it('exactly at commitPx -> reset (strictly greater commits)', () => {
    expect(swipeOutcome(COMMIT_PX, COMMIT_PX)).toBe('reset');
    expect(swipeOutcome(-COMMIT_PX, COMMIT_PX)).toBe('reset');
  });
  // Cancel-rescue: pointercancel and pointerup share this same path, so a real
  // past-threshold drag still commits when iOS cancels at release.
  it('past-threshold commits regardless of how the gesture ended', () => {
    expect(swipeOutcome(130, COMMIT_PX)).toBe('approve');
    expect(swipeOutcome(50, COMMIT_PX)).toBe('reset');
  });
});
