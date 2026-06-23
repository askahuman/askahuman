// Unit tests for the code-only pairing derivation: the typed-code happy path
// (canonicalize -> 16-hex room) and invalid-code rejection. The byte-exact
// Go<->JS agreement is pinned separately by test/spake2-interop.mjs.

import { describe, expect, it } from 'vitest';

import {
  CODE_ALPHABET,
  CODE_LEN,
  canonicalizeCode,
  codeSymbolsBefore,
  defaultRelayURL,
  formatCodeInput,
  roomFromCode,
} from '../src/lib/codegen.ts';
import { ROOM_RE } from '../src/lib/payload.ts';

describe('canonicalizeCode (typed code -> SPAKE2 password)', () => {
  it('folds case + strips hyphen/space to CODE_LEN in-alphabet symbols', () => {
    // The canonical form is uppercase, separator-free, exactly CODE_LEN long.
    const canon = canonicalizeCode('abcde-23456');
    expect(canon).toBe('ABCDE23456');
    expect(canon).toHaveLength(CODE_LEN);
    // Spaces, mixed case, and lowercase all fold to the same canonical string.
    expect(canonicalizeCode('AB CDE 234 56')).toBe('ABCDE23456');
    expect(canonicalizeCode(' abCDE-23456 ')).toBe('ABCDE23456');
  });

  it('every canonical symbol is in the shared alphabet', () => {
    for (const ch of canonicalizeCode('ABCDE23456')) {
      expect(CODE_ALPHABET.includes(ch)).toBe(true);
    }
  });

  it('throws on a wrong-length or out-of-alphabet code (App rejects inline)', () => {
    expect(() => canonicalizeCode('')).toThrow();
    expect(() => canonicalizeCode('ABC')).toThrow(); // too short
    expect(() => canonicalizeCode('ABCDE234567')).toThrow(); // too long (11)
    // 0/O/1/I/L are deliberately not in the alphabet -> dropped -> short -> throws.
    expect(() => canonicalizeCode('OOOOO11111')).toThrow();
  });
});

describe('formatCodeInput (auto-insert the XXXX-XXXX hyphen as you type)', () => {
  it('shows no hyphen until the first group is full, then auto-inserts it', () => {
    // The hyphen only appears once there is something on its right-hand side.
    expect(formatCodeInput('ABCD')).toBe('ABCD');
    expect(formatCodeInput('ABCDE')).toBe('ABCDE'); // boundary: group full, nothing after
    expect(formatCodeInput('ABCDE2')).toBe('ABCDE-2'); // the 6th symbol pulls the dash in
    expect(formatCodeInput('ABCDE23456')).toBe('ABCDE-23456');
  });

  it('is idempotent and folds case/separators the user already typed', () => {
    // Re-running on already-formatted text is stable (controlled-input round-trip).
    expect(formatCodeInput('ABCDE-23456')).toBe('ABCDE-23456');
    expect(formatCodeInput('abcde-23456')).toBe('ABCDE-23456');
    // A pasted code with spaces or stray dashes regroups to the canonical display.
    expect(formatCodeInput('ab cde 234 56')).toBe('ABCDE-23456');
    expect(formatCodeInput('A-B-C-D-E-2-3-4-5-6')).toBe('ABCDE-23456');
  });

  it('drops look-alikes and excess, capping at CODE_LEN symbols', () => {
    // 0/O/1/I/L are not in the alphabet -> silently dropped, never displayed.
    expect(formatCodeInput('O0O0')).toBe('');
    expect(formatCodeInput('ABCDE23456EXTRA')).toBe('ABCDE-23456'); // capped, surplus ignored
  });

  it('the display always canonicalizes back to the same password (dash is cosmetic)', () => {
    const display = formatCodeInput('abcde23456');
    expect(display).toBe('ABCDE-23456');
    expect(canonicalizeCode(display)).toBe('ABCDE23456');
    expect(canonicalizeCode(display)).toBe(canonicalizeCode('abcde23456'));
  });
});

describe('codeSymbolsBefore (caret math for the formatted field)', () => {
  it('counts in-alphabet symbols left of a caret, capped at CODE_LEN', () => {
    expect(codeSymbolsBefore('ABCDE-23456', 0)).toBe('');
    expect(codeSymbolsBefore('ABCDE-23456', 5)).toBe('ABCDE'); // caret before the dash
    expect(codeSymbolsBefore('ABCDE-23456', 6)).toBe('ABCDE'); // caret after the dash, same symbols
    expect(codeSymbolsBefore('ABCDE-23456', 7)).toBe('ABCDE2');
    expect(codeSymbolsBefore('ABCDE-23456', 11)).toBe('ABCDE23456');
  });
});

describe('roomFromCode (derive the rendezvous room from the code alone)', () => {
  it('yields a 16-lowercase-hex room id that matches the room contract', () => {
    const room = roomFromCode(canonicalizeCode('ABCDE-23456'));
    expect(room).toMatch(ROOM_RE);
  });

  it('is deterministic and code-specific', () => {
    const a = roomFromCode(canonicalizeCode('ABCDE23456'));
    expect(roomFromCode(canonicalizeCode('abcde-23456'))).toBe(a); // case/sep agnostic
    expect(roomFromCode(canonicalizeCode('VWXYZ23456'))).not.toBe(a); // different code
  });
});

describe('defaultRelayURL (same-origin /ws fallback)', () => {
  it('maps https origin -> wss://origin/ws and http -> ws://origin/ws', () => {
    expect(defaultRelayURL('https://app.example')).toBe('wss://app.example/ws');
    expect(defaultRelayURL('http://localhost:4321')).toBe('ws://localhost:4321/ws');
  });
});
