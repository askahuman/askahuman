// PairScreen is the code-only pairing UI: the user types the 8-char code their
// agent printed into ONE field and submits. The phone derives the relay room
// from the code alone (App: canonicalizeCode -> roomFromCode); nothing secret is
// ever placed in a URL. There is no deep link.
//
// Optional "Advanced" relay URL (persisted in localStorage) lets self-hosters
// point at their own relay; it is validated by validRelayURL before use.

import { useEffect, useRef, useState } from 'react';

import { codeSymbolsBefore, defaultRelayURL, formatCodeInput } from '../lib/codegen.ts';
import { validRelayURL } from '../lib/payload.ts';
import type { Palette } from './theme.ts';

const MONO = "'JetBrains Mono', ui-monospace, monospace";
const SANS = "'IBM Plex Sans', sans-serif";

const RELAY_KEY = 'relay_url';
// After submitting, surface a hint if no agent has shown up on this code yet.
const WAIT_HINT_MS = 10_000;

export interface PairScreenProps {
  c: Palette;
  /** onSubmitCode pairs with a typed code + the chosen relay URL. */
  onSubmitCode: (code: string, relayURL: string) => void;
  /** error is an inline message for a bad code (set by the App on a throw). */
  error: string | null;
}

function originRelayURL(): string {
  return typeof window !== 'undefined' ? defaultRelayURL(window.location.origin) : '';
}

export function PairScreen({ c, onSubmitCode, error }: PairScreenProps) {
  const [code, setCode] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [relay, setRelay] = useState('');
  const [relayError, setRelayError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [waitedTooLong, setWaitedTooLong] = useState(false);
  const waitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);

  // Load any self-hoster relay override once.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(RELAY_KEY);
      if (stored) setRelay(stored);
    } catch {
      /* ignore */
    }
  }, []);

  // A fresh inline error means the App rejected the code: stop "waiting".
  useEffect(() => {
    if (error) {
      setWaiting(false);
      setWaitedTooLong(false);
      if (waitTimer.current) clearTimeout(waitTimer.current);
    }
  }, [error]);

  useEffect(() => {
    return () => {
      if (waitTimer.current) clearTimeout(waitTimer.current);
    };
  }, []);

  // onCodeChange formats the typed code to XXXX-XXXX live (the hyphen appears on
  // its own — the user never types a dash or space) and restores the caret after
  // the controlled re-render, so the auto-inserted hyphen never bumps the cursor.
  const onCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    let raw = el.value;
    let caret = el.selectionStart ?? raw.length;

    // A Backspace that lands on the auto-inserted hyphen would just re-insert it
    // (a dead keystroke). Detect "only the hyphen was deleted" and eat the real
    // symbol before it instead, so one Backspace deletes a symbol at the boundary.
    const dashAt = code.indexOf('-');
    if (dashAt > 0 && caret === dashAt && raw === code.slice(0, dashAt) + code.slice(dashAt + 1)) {
      raw = raw.slice(0, dashAt - 1) + raw.slice(dashAt);
      caret = dashAt - 1;
    }

    // Caret lands after the same number of real symbols it preceded, skipping the
    // hyphen — so mid-string edits stay put too.
    const symbolsBefore = codeSymbolsBefore(raw, caret).length;
    const formatted = formatCodeInput(raw);
    let pos = formatted.length;
    for (let i = 0, seen = 0; i < formatted.length; i++) {
      if (seen >= symbolsBefore) {
        pos = i;
        break;
      }
      if (formatted[i] !== '-') seen++;
    }
    setCode(formatted);
    // rAF so the caret set wins even when the keystroke maps back to the SAME
    // formatted string (a dropped look-alike / over-cap symbol): React skips that
    // re-render and would otherwise leave the cursor stranded at the end.
    requestAnimationFrame(() => codeInput.current?.setSelectionRange(pos, pos));
  };

  const submit = () => {
    const relayURL = relay.trim() || originRelayURL();
    if (relay.trim() && !validRelayURL(relayURL)) {
      setRelayError('relay must be a wss:// URL (ws:// only for localhost)');
      return;
    }
    setRelayError(null);
    try {
      // Persist a custom relay only; clearing the field reverts to the default.
      if (relay.trim()) localStorage.setItem(RELAY_KEY, relay.trim());
      else localStorage.removeItem(RELAY_KEY);
    } catch {
      /* ignore */
    }
    // Start the waiting hint timer; the App swaps this screen out on a real pair.
    setWaiting(true);
    setWaitedTooLong(false);
    if (waitTimer.current) clearTimeout(waitTimer.current);
    waitTimer.current = setTimeout(() => setWaitedTooLong(true), WAIT_HINT_MS);
    onSubmitCode(code, relayURL);
  };

  return (
    <div
      style={{
        height: '100dvh',
        width: '100%',
        // Transparent so the shared starfield/aurora (SpaceBackground) shows
        // through behind the pairing UI, matching the marketing landing.
        background: 'transparent',
        color: c.text,
        fontFamily: MONO,
        // Safe-area inset so the title clears the iOS notch in standalone PWA.
        padding: 'calc(66px + env(safe-area-inset-top)) 22px 36px',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div>
        <div style={{ fontSize: 11, letterSpacing: 2, color: c.muted, textTransform: 'uppercase' }}>ask-a-human</div>
        <div style={{ fontSize: 25, fontWeight: 700, marginTop: 7, color: c.text }}>Pair a device</div>
        <div style={{ fontFamily: SANS, fontSize: 13.5, color: c.muted, marginTop: 10, lineHeight: 1.55 }}>
          Open this app and type the code your agent printed.
        </div>
      </div>

      <div style={{ marginTop: 30 }}>
        <label
          htmlFor="pair-code"
          style={{ fontSize: 11, letterSpacing: 2, color: c.muted, textTransform: 'uppercase' }}
        >
          pairing code
        </label>
        <input
          id="pair-code"
          data-testid="code-input"
          ref={codeInput}
          value={code}
          onChange={onCodeChange}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder="ABCD-2345"
          // Mobile-friendly: text keyboard, force caps, no auto-mangle.
          inputMode="text"
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          // No maxLength: the browser would clamp a PASTE (separators included)
          // before onChange runs, dropping real symbols. formatCodeInput already
          // caps the displayed value at 8 symbols + the one auto-inserted hyphen.
          style={{
            marginTop: 9,
            width: '100%',
            boxSizing: 'border-box',
            height: 60,
            background: c.surface,
            border: `1px solid ${error ? c.decline : c.border}`,
            borderRadius: 14,
            color: c.text,
            fontFamily: MONO,
            fontSize: 26,
            fontWeight: 700,
            letterSpacing: 6,
            textAlign: 'center',
            outline: 'none',
            textTransform: 'uppercase',
          }}
        />
        {error && (
          <div data-testid="code-error" style={{ marginTop: 9, fontSize: 12.5, color: c.decline }}>
            {error}
          </div>
        )}
        {waiting && !error && (
          <div
            data-testid="pair-waiting"
            style={{
              marginTop: 14,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12.5,
              color: c.muted,
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.approve, animation: 'blink 1.4s infinite' }} />
            {waitedTooLong
              ? 'no agent on this code yet, check the code or ask for a fresh one'
              : 'waiting for your agent…'}
          </div>
        )}

        <button
          data-testid="code-submit"
          onClick={submit}
          style={{
            marginTop: 18,
            width: '100%',
            height: 54,
            borderRadius: 16,
            background: c.approve,
            border: 'none',
            color: '#04140c',
            fontFamily: MONO,
            fontWeight: 700,
            fontSize: 15,
            cursor: 'pointer',
          }}
        >
          Connect
        </button>
      </div>

      <div style={{ flex: 1 }} />

      <button
        data-testid="advanced-toggle"
        onClick={() => setAdvancedOpen((v) => !v)}
        style={{
          alignSelf: 'flex-start',
          background: 'transparent',
          border: 'none',
          color: c.faint,
          fontFamily: MONO,
          fontSize: 12,
          cursor: 'pointer',
          padding: 0,
          marginBottom: advancedOpen ? 10 : 0,
        }}
      >
        {advancedOpen ? '▾ advanced' : '▸ advanced'}
      </button>
      {advancedOpen && (
        <div style={{ marginBottom: 12 }}>
          <label
            htmlFor="relay-url"
            style={{ fontSize: 11, letterSpacing: 1, color: c.muted }}
          >
            relay URL (self-hosters)
          </label>
          <input
            id="relay-url"
            data-testid="relay-input"
            value={relay}
            onChange={(e) => setRelay(e.target.value)}
            placeholder={originRelayURL()}
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            style={{
              marginTop: 7,
              width: '100%',
              boxSizing: 'border-box',
              height: 42,
              background: c.surface,
              border: `1px solid ${relayError ? c.decline : c.border}`,
              borderRadius: 10,
              color: c.text,
              fontFamily: MONO,
              fontSize: 13,
              padding: '0 12px',
              outline: 'none',
            }}
          />
          {relayError && (
            <div data-testid="relay-error" style={{ marginTop: 7, fontSize: 12, color: c.decline }}>
              {relayError}
            </div>
          )}
        </div>
      )}

      <div style={{ fontFamily: SANS, fontSize: 13, color: c.faint, textAlign: 'center', lineHeight: 1.55 }}>
        The code is the key. It derives the room and encrypts the channel, and the relay can't read it.
      </div>
    </div>
  );
}
