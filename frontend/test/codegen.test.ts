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
    const canon = canonicalizeCode('abcd-2345');
    expect(canon).toBe('ABCD2345');
    expect(canon).toHaveLength(CODE_LEN);
    // Spaces, mixed case, and lowercase all fold to the same canonical string.
    expect(canonicalizeCode('AB CD 23 45')).toBe('ABCD2345');
    expect(canonicalizeCode(' abCD-2345 ')).toBe('ABCD2345');
  });

  it('every canonical symbol is in the shared alphabet', () => {
    for (const ch of canonicalizeCode('ABCD2345')) {
      expect(CODE_ALPHABET.includes(ch)).toBe(true);
    }
  });

  it('throws on a wrong-length or out-of-alphabet code (App rejects inline)', () => {
    expect(() => canonicalizeCode('')).toThrow();
    expect(() => canonicalizeCode('ABC')).toThrow(); // too short
    expect(() => canonicalizeCode('ABCD23456')).toThrow(); // too long
    // 0/O/1/I/L are deliberately not in the alphabet -> dropped -> short -> throws.
    expect(() => canonicalizeCode('OOOO1111')).toThrow();
  });
});

describe('formatCodeInput (auto-insert the XXXX-XXXX hyphen as you type)', () => {
  it('shows no hyphen until the first group is full, then auto-inserts it', () => {
    // The hyphen only appears once there is something on its right-hand side.
    expect(formatCodeInput('ABC')).toBe('ABC');
    expect(formatCodeInput('ABCD')).toBe('ABCD'); // boundary: group full, nothing after
    expect(formatCodeInput('ABCD2')).toBe('ABCD-2'); // the 5th symbol pulls the dash in
    expect(formatCodeInput('ABCD2345')).toBe('ABCD-2345');
  });

  it('is idempotent and folds case/separators the user already typed', () => {
    // Re-running on already-formatted text is stable (controlled-input round-trip).
    expect(formatCodeInput('ABCD-2345')).toBe('ABCD-2345');
    expect(formatCodeInput('abcd-2345')).toBe('ABCD-2345');
    // A pasted code with spaces or stray dashes regroups to the canonical display.
    expect(formatCodeInput('ab cd 23 45')).toBe('ABCD-2345');
    expect(formatCodeInput('A-B-C-D-2-3-4-5')).toBe('ABCD-2345');
  });

  it('drops look-alikes and excess, capping at CODE_LEN symbols', () => {
    // 0/O/1/I/L are not in the alphabet -> silently dropped, never displayed.
    expect(formatCodeInput('O0O0')).toBe('');
    expect(formatCodeInput('ABCD2345EXTRA')).toBe('ABCD-2345'); // capped, surplus ignored
  });

  it('the display always canonicalizes back to the same password (dash is cosmetic)', () => {
    const display = formatCodeInput('abcd2345');
    expect(display).toBe('ABCD-2345');
    expect(canonicalizeCode(display)).toBe('ABCD2345');
    expect(canonicalizeCode(display)).toBe(canonicalizeCode('abcd2345'));
  });
});

describe('codeSymbolsBefore (caret math for the formatted field)', () => {
  it('counts in-alphabet symbols left of a caret, capped at CODE_LEN', () => {
    expect(codeSymbolsBefore('ABCD-2345', 0)).toBe('');
    expect(codeSymbolsBefore('ABCD-2345', 4)).toBe('ABCD'); // caret before the dash
    expect(codeSymbolsBefore('ABCD-2345', 5)).toBe('ABCD'); // caret after the dash, same symbols
    expect(codeSymbolsBefore('ABCD-2345', 6)).toBe('ABCD2');
    expect(codeSymbolsBefore('ABCD-2345', 9)).toBe('ABCD2345');
  });
});

describe('roomFromCode (derive the rendezvous room from the code alone)', () => {
  it('yields a 16-lowercase-hex room id that matches the room contract', () => {
    const room = roomFromCode(canonicalizeCode('ABCD-2345'));
    expect(room).toMatch(ROOM_RE);
  });

  it('is deterministic and code-specific', () => {
    const a = roomFromCode(canonicalizeCode('ABCD2345'));
    expect(roomFromCode(canonicalizeCode('abcd-2345'))).toBe(a); // case/sep agnostic
    expect(roomFromCode(canonicalizeCode('WXYZ2345'))).not.toBe(a); // different code
  });
});

describe('defaultRelayURL (same-origin /ws fallback)', () => {
  it('maps https origin -> wss://origin/ws and http -> ws://origin/ws', () => {
    expect(defaultRelayURL('https://app.example')).toBe('wss://app.example/ws');
    expect(defaultRelayURL('http://localhost:4321')).toBe('ws://localhost:4321/ws');
  });
});
