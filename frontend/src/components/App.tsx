// App is the single React island: it owns the Session state machine and routes
// it to the nine screens. Pairing is code-only: the agent prints a 10-char code,
// the user opens /app and TYPES it. The phone canonicalizes the code, derives the
// relay room from it (Argon2id, codegen.roomFromCode), and runs SPAKE2 as role B.
// Pairing secrets never appear in a URL/hash. Notification navigation carries
// only an opaque room identifier that must already exist in the saved roster.

import { useEffect, useRef, useState } from 'react';

import { syncBadge } from '../lib/badge.ts';
import { canonicalizeCode, roomFromCode } from '../lib/codegen.ts';
import { SessionManager, type AgentSummary } from '../lib/manager.ts';
import { type PairPayload } from '../lib/payload.ts';
import { roomFromPushHash, roomFromPushMessage } from '../lib/push-routing.ts';
import { localStorePersistence } from '../lib/store.ts';
import { type SessionState } from '../lib/session.ts';
import { PairScreen } from './PairScreen.tsx';
import { PushNotifications } from './PushNotifications.tsx';
import { usePushNotifications } from './usePushNotifications.ts';
import {
  ConfirmedScreen,
  ChoiceScreen,
  HomeScreen,
  ListeningScreen,
  LockScreen,
  OfflineScreen,
  Roster,
  TextScreen,
  YesNoScreen,
} from './screens.tsx';
import { type Palette, dark, light } from './theme.ts';

// Keyframes used by the inline-styled screens (mirror the mockup <style>).
// Exported so test/csp-keyframes.test.ts can pin its sha256 against the CSP
// style-src hash in astro.config.mjs (the runtime <style>{KEYFRAMES}</style>
// island can't be hashed by Astro at build time). ref. csp-keyframes.test.ts.
export const KEYFRAMES = `
@keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0; } }
@keyframes pulse { 0% { transform: scale(0.7); opacity: 0.5; } 80%,100% { transform: scale(1.6); opacity: 0; } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes slideDown { from { transform: translateY(-18px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
@keyframes requestPulse { 0%,100% { opacity: 0.55; box-shadow: 0 0 0 0 currentColor; } 50% { opacity: 1; box-shadow: 0 0 6px 1px currentColor; } }
@keyframes bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }
@media (prefers-reduced-motion: reduce) { [data-testid^="roster-request-"], [data-testid="listening-pager"] { animation: none !important; opacity: 1 !important; } }
`;

/** PUBLIC_VAPID_KEY is a build-time placeholder; the agent may also send one. */
const VAPID_KEY =
  (import.meta as unknown as { env?: Record<string, string> }).env?.PUBLIC_VAPID_KEY ?? '';

/**
 * effectiveViewportHeight converts a visual viewport (height, scale) into the
 * CSS px the app shell should occupy. Scale-corrected so pinch-zoom does not
 * shrink the layout — only the on-screen keyboard (scale stays 1) does. Returns
 * null for unusable readings (0/NaN), meaning "keep the 100dvh fallback".
 * Exported for test.
 */
export function effectiveViewportHeight(height: number, scale: number): number | null {
  const h = Math.round(height * (scale || 1));
  return Number.isFinite(h) && h > 0 ? h : null;
}

/**
 * useVisualViewportLock keeps the app shell sized to the VISIBLE viewport. iOS
 * overlays the on-screen keyboard instead of resizing the layout viewport and
 * then scrolls/pans the page to reveal the focused input, which (a) shoves the
 * request card off-screen while typing a free-text reply and (b) can leave the
 * page misaligned afterwards. Publishing visualViewport.height as --app-vvh
 * lets every screen shrink to exactly the visible area (the reply input lands
 * right above the keyboard, the card stays on-screen), and resetting any window
 * scroll undoes the focus-scroll artifact — the shell is position:fixed
 * (global.css), so a non-zero scroll is never intended. ref. ADR 0024.
 */
function useVisualViewportLock(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      const h = effectiveViewportHeight(vv.height, vv.scale);
      if (h !== null) document.documentElement.style.setProperty('--app-vvh', `${h}px`);
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      document.documentElement.style.removeProperty('--app-vvh');
    };
  }, []);
}

function usePalette(): Palette {
  // Dark-only, to match the dark-only marketing site and the shared cosmic
  // background (SpaceBackground paints the starfield under html.dark). We do NOT
  // follow prefers-color-scheme: a light React palette over the fixed dark
  // starfield would put white cards on a dark-green sky. Light stays reachable
  // only via an explicit stored 'theme' (no UI sets it today).
  const [isDark, setIsDark] = useState(true);
  useEffect(() => {
    try {
      if (localStorage.getItem('theme') === 'light') setIsDark(false);
    } catch {
      /* default dark */
    }
  }, []);
  return isDark ? dark : light;
}

/** useExpiryCountdown ticks an active request's expires_in_s down to 0, then
 *  calls onExpire(id) so the session leaves the actionable card — the user must
 *  not be able to approve a request the agent has already timed out on. */
function useExpiryCountdown(state: SessionState, onExpire?: (id: string) => void): number | null {
  const isCard = state.screen === 'yesno' || state.screen === 'choice' || state.screen === 'text';
  const total = state.request?.expires_in_s ?? null;
  const [remaining, setRemaining] = useState<number | null>(null);
  const startedAt = useRef<number>(0);
  const reqID = state.request?.id;

  useEffect(() => {
    if (!isCard || total == null) {
      setRemaining(null);
      return;
    }
    startedAt.current = Date.now();
    setRemaining(total);
    const t = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt.current) / 1000);
      const left = Math.max(0, total - elapsed);
      setRemaining(left);
      if (left <= 0) {
        clearInterval(t);
        if (reqID) onExpire?.(reqID);
      }
    }, 1000);
    return () => clearInterval(t);
  }, [isCard, total, reqID]);

  return remaining;
}

export default function App() {
  const c = usePalette();
  useVisualViewportLock();

  // One SessionManager owns all live agents; the App re-renders off its single
  // onChange. tick forces a re-render when the manager (any session/roster) changes.
  const managerRef = useRef<SessionManager>(null as unknown as SessionManager);
  if (managerRef.current === null) {
    managerRef.current = new SessionManager({}, localStorePersistence);
  }
  const manager = managerRef.current;

  const [, setTick] = useState(0);
  // pairing flips to the code-entry PairScreen ("+ add agent") without dropping
  // live sessions; false = show the active agent. Starts true ONLY when empty.
  const [pairing, setPairing] = useState(true);
  // pairError surfaces a bad typed code inline; never opens a socket.
  const [pairError, setPairError] = useState<string | null>(null);
  // Subscribe to the manager once; tear every session down on unmount.
  useEffect(() => {
    const unsub = manager.onChange(() => setTick((t) => t + 1));
    // Restore persisted sessions (iOS kills the PWA page routinely): each
    // rejoins its room already paired, and the agent's re-announce delivers any
    // pending request within seconds. Storage stays put on unmount.
    if (manager.restoreAll() > 0) {
      setPairing(false);
    }
    return () => {
      unsub();
      manager.closeAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A wake selects only an already-paired local room; it never imports a key,
  // code, request, or decision. A cold launch carries only that opaque room in
  // the fragment, which is cleared before any interaction with the session.
  useEffect(() => {
    const select = (room: string | null) => {
      if (!room || !manager.list().some((a) => a.id === room)) return;
      setPairing(false);
      manager.setActive(room);
      manager.retry();
    };
    const fromHash = () => {
      if (!window.location.hash.startsWith('#wake=')) return;
      const room = roomFromPushHash(window.location.hash);
      history.replaceState(history.state, '', window.location.pathname + window.location.search);
      select(room);
    };
    const fromMessage = (event: MessageEvent) => select(roomFromPushMessage(event, window.location.origin));
    fromHash();
    window.addEventListener('hashchange', fromHash);
    navigator.serviceWorker?.addEventListener('message', fromMessage);
    return () => {
      window.removeEventListener('hashchange', fromHash);
      navigator.serviceWorker?.removeEventListener('message', fromMessage);
    };
  }, [manager]);

  // Bug 2 recovery: iOS silently kills the WebSocket when the PWA is
  // backgrounded and the frozen reconnect timer never fires, leaving a dead
  // socket believed-open. On resume (tab visible) or network restore, force a
  // reconnect of every session so the relay link comes back without a manual
  // Retry. relay.ts adds a heartbeat as defense-in-depth.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const recover = () => {
      if (document.visibilityState !== 'visible') return;
      manager.retryAll();
      // Reconcile the app-icon badge to the live truth: while backgrounded the
      // service worker only ever incremented it (per wake-up push), so on resume
      // we re-assert the real pending count — clearing any over-count and any
      // requests resolved/expired elsewhere while we were away.
      syncBadge(manager.pendingCount());
    };
    const onOnline = () => manager.retryAll();
    document.addEventListener('visibilitychange', recover);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', recover);
      window.removeEventListener('online', onOnline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeState = manager.activeState();
  const roster: AgentSummary[] = manager.list();
  const push = usePushNotifications(manager, roster, VAPID_KEY);

  // Mirror the count of unanswered requests onto the OS app-icon badge (the red
  // number on the home-screen icon): two agents each waiting on a request show a
  // "2", and it clears as they are answered. The foreground page is the source of
  // truth here; the service worker keeps the badge counting up while the PWA is
  // closed (see badge.ts / sw.ts). Re-runs only when the count actually changes.
  const pending = manager.pendingCount();
  useEffect(() => {
    syncBadge(pending);
  }, [pending]);

  // On first pairing success, dismiss the code-entry screen. Notification
  // permission is requested only from the explicit control on ListeningScreen.
  const anyPaired = roster.some((a) => a.status === 'paired' || a.status === 'offline');
  useEffect(() => {
    if (!anyPaired) return;
    setPairing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyPaired]);

  // While pairing (or with no agents), pin the code-entry screen; otherwise
  // render the active session's live state.
  const showPair = pairing || roster.length === 0;
  const state: SessionState = showPair ? { ...activeState, screen: 'pair' } : activeState;

  const expiresIn = useExpiryCountdown(state, (id) => manager.expire(id));

  // onSubmitCode is the ONLY pairing entry point: canonicalize the typed code
  // (reject inline on a throw — never open a socket on a bad code), derive the
  // room, and add a Session. The phone runs SPAKE2 as role B with the canon code.
  const onSubmitCode = (raw: string, relayURL: string) => {
    let canon: string;
    try {
      canon = canonicalizeCode(raw);
    } catch {
      setPairError("that code doesn't look right, check the 10 characters");
      return;
    }
    try {
      const payload: PairPayload = { r: relayURL, room: roomFromCode(canon), code: canon };
      setPairError(null);
      // A fresh code replaces the failed attempt, not any successfully paired
      // agent. Reusing a failed room is also supported by manager.add.
      const previous = manager.activeState();
      if (!previous.paired && previous.pairError && previous.roomID !== payload.room) {
        manager.remove(previous.roomID);
      }
      manager.add(payload);
      manager.setActive(payload.room);
      setPairing(false);
    } catch {
      // Unreachable in practice (PairScreen validates the relay URL before
      // submit), but a non-WS relay scheme would throw out of roomURL here —
      // degrade to an inline error instead of an uncaught handler exception.
      setPairError('could not connect, check the relay URL in Advanced settings');
    }
  };

  return (
    <>
      <style>{KEYFRAMES}</style>
      {roster.length > 0 && (
        <Roster
          c={c}
          agents={roster}
          onSelect={(id) => {
            setPairing(false);
            manager.setActive(id);
          }}
          onAdd={() => {
            setPairError(null);
            setPairing(true);
          }}
          onRemove={(id) => {
            push.forget(id);
            manager.remove(id);
          }}
        />
      )}
      {renderScreen(c, state, expiresIn, {
        onSubmitCode,
        pairError: pairError ?? (!showPair && state.pairError
          ? 'Pairing failed. Get a new code from your agent and try again.'
          : null),
        onApprove: () => manager.approve(),
        onDecline: () => manager.decline(),
        onChoose: (l: string) => manager.choose(l),
        onSend: (t: string) => manager.reply(t),
        onRetry: () => manager.retry(),
      }, <PushNotifications c={c} push={push} />)}
    </>
  );
}

interface Handlers {
  onSubmitCode: (code: string, relayURL: string) => void;
  pairError: string | null;
  onApprove: () => void;
  onDecline: () => void;
  onChoose: (label: string) => void;
  onSend: (text: string) => void;
  onRetry: () => void;
}

function renderScreen(c: Palette, state: SessionState, expiresIn: number | null, h: Handlers, pushControl: React.ReactNode) {
  switch (state.screen) {
    case 'pair':
      return <PairScreen c={c} onSubmitCode={h.onSubmitCode} error={h.pairError} />;
    case 'lock':
      return <LockScreen c={c} agent={state.agent} onOpen={() => {}} />;
    case 'home':
      return <HomeScreen c={c} unread={state.request ? 1 : 0} onOpen={() => {}} />;
    case 'listening':
      return <ListeningScreen c={c} agent={state.agent} roomID={state.roomID}>{pushControl}</ListeningScreen>;
    // key={request.id}: a new request or an agent switch must mount a FRESH
    // card, not reuse the prior instance's swipe/commit state. Without it, a
    // deferred swipe commit could seal a decision against whatever request is
    // active when its timer fires (wrong-approval); the key also unmounts the
    // old card so its commit-timer cleanup runs.
    case 'yesno':
      return state.request ? (
        <YesNoScreen key={state.request.id} c={c} req={state.request} expiresIn={expiresIn} onApprove={h.onApprove} onDecline={h.onDecline} />
      ) : (
        <ListeningScreen c={c} agent={state.agent} roomID={state.roomID} />
      );
    case 'choice':
      return state.request ? (
        <ChoiceScreen key={state.request.id} c={c} req={state.request} expiresIn={expiresIn} onChoose={h.onChoose} />
      ) : (
        <ListeningScreen c={c} agent={state.agent} roomID={state.roomID} />
      );
    case 'text':
      return state.request ? (
        <TextScreen key={state.request.id} c={c} req={state.request} expiresIn={expiresIn} onSend={h.onSend} />
      ) : (
        <ListeningScreen c={c} agent={state.agent} roomID={state.roomID} />
      );
    case 'confirmed':
      return state.result ? (
        <ConfirmedScreen
          c={c}
          icon={state.result.icon}
          label={state.result.label}
          approved={state.result.approved}
          detail={state.result.detail}
          agent={state.agent}
        />
      ) : (
        <ListeningScreen c={c} agent={state.agent} roomID={state.roomID} />
      );
    case 'offline':
      return <OfflineScreen c={c} attempt={state.attempt} onRetry={h.onRetry} />;
    default:
      return <ListeningScreen c={c} agent={state.agent} roomID={state.roomID} />;
  }
}
