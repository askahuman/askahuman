// Drift guard: the runtime <style>{KEYFRAMES}</style> React island can't be
// hashed by Astro at build time, so we pin its sha256 in astro.config.mjs
// (style-src). If KEYFRAMES changes and the config hash isn't recomputed, the
// browser blocks the <style> and every animation dies (blink/pulse/spin/…).
// This test recomputes the hash from the real KEYFRAMES source and asserts the
// config still carries it. ref. console CSP violation observed 2026-07-03.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { KEYFRAMES } from '../src/components/App.tsx';

describe('CSP keyframes hash (astro.config.mjs style-src)', () => {
  it('the pinned style hash matches the current KEYFRAMES', () => {
    // The browser hashes the raw text between the <style> tags — for
    // React <style>{KEYFRAMES}</style> that is exactly the KEYFRAMES string,
    // including its leading/trailing newline. Same input node:crypto sees here.
    const hash = 'sha256-' + createHash('sha256').update(KEYFRAMES, 'utf8').digest('base64');

    const config = readFileSync(new URL('../astro.config.mjs', import.meta.url), 'utf8');
    expect(config).toContain(hash);
  });
});
