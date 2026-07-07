// App is the single React island: it owns the Session state machine and routes
// it to the nine screens. Pairing is code-only: the agent prints a 10-char code,
// the user opens /app and TYPES it. The phone canonicalizes the code, derives the
// relay room from it (Argon2id, codegen.roomFromCode), and runs SPAKE2 as role B.
// NOTHING secret is ever placed in a URL/hash — there is no deep link.

import { useEffect, useRef, useState } from 'react';

import { syncBadge } from '../lib/badge.ts';
import { canonicalizeCode, roomFromCode } from '../lib/codegen.ts';
import { SessionManager, type AgentSummary } from '../lib/manager.ts';
import { type PairPayload } from '../lib/payload.ts';
import { subscribeForPush } from '../lib/push.ts';
import { localStorePersistence } from '../lib/store.ts';
import { type SessionState } from '../lib/session.ts';
import { type PushSubscription } from '../lib/wire.ts';
import { PairScreen } from './PairScreen.tsx';
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

// BUILD_VAPID_ROOM keys the single build-time-key subscription in the push-done
// set: it fans out to every agent that never sent its own key, so it has no
// owning room. The NUL prefix can never collide with a 16-hex relay room id.
const BUILD_VAPID_ROOM = '\0build';

/**
 * subscribeOnce subscribes for `key`, delivers the resulting subscription via
 * `deliver`, and records `room` in `done` ONLY on success (a subscription was
 * obtained AND delivered) — a single early failure never latches push off for
 * the page, and each agent is tracked independently so one denied agent never
 * blocks the others. A delivery that fails only because the room's socket is
 * not open yet is NOT retried here: the manager retains the sub per room
 * (sendPushSubscriptionTo) and re-delivers it when that connection (re)opens.
 * The undone mark matters for forget-then-re-pair (onRemove clears the room) and
 * keeps a permission-denied room retryable if a future trigger fires. Exported
 * for test.
 */
export async function subscribeOnce(
  done: Set<string>,
  room: string,
  key: string,
  subscribe: (k: string) => Promise<PushSubscription | null>,
  deliver: (sub: PushSubscription) => boolean,
): Promise<void> {
  if (done.has(room)) return;
  const sub = await subscribe(key);
  if (sub && deliver(sub)) done.add(room);
}

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
  // pushDoneRef holds the rooms that already have a delivered push subscription;
  // a room is added ONLY after subscribeOnce succeeds. Per-room + mark-on-success
  // so a denied/failed first attempt never permanently disables push, and every
  // agent subscribes under its own VAPID key (not just the first). The
  // BUILD_VAPID_ROOM sentinel stands in for the single build-time-key fanout sub.
  const pushDoneRef = useRef<Set<string>>(new Set());

  // Subscribe to the manager once; tear every session down on unmount.
  useEffect(() => {
    const unsub = manager.onChange(() => setTick((t) => t + 1));
    // Restore persisted sessions (iOS kills the PWA page routinely): each
    // rejoins its room already paired, and the agent's re-announce delivers any
    // pending request within seconds. Storage stays put on unmount.
    if (manager.restoreAll() > 0) {
      setPairing(false);
      // Re-subscribe each restored agent under ITS OWN persisted VAPID key: the
      // agent sends its key only once (right after pairing), so a restored session
      // never re-receives it and onVapidKey won't fire. Permission was granted at
      // original pairing, so this resolves silently; each sub routes back to its
      // own room. subscribeOnce marks per-room on success, so one agent's denial
      // never blocks another's, and a build-time-only agent falls to anyPaired.
      for (const { room, key } of manager.vapidKeys()) {
        void subscribeOnce(pushDoneRef.current, room, key, subscribeForPush, (sub) =>
          manager.sendPushSubscriptionTo(room, sub),
        );
      }
    }
    return () => {
      unsub();
      manager.closeAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Mirror the count of unanswered requests onto the OS app-icon badge (the red
  // number on the home-screen icon): two agents each waiting on a request show a
  // "2", and it clears as they are answered. The foreground page is the source of
  // truth here; the service worker keeps the badge counting up while the PWA is
  // closed (see badge.ts / sw.ts). Re-runs only when the count actually changes.
  const pending = manager.pendingCount();
  useEffect(() => {
    syncBadge(pending);
  }, [pending]);

  // The agent delivers its OWN VAPID public key sealed during pairing; the phone
  // MUST subscribe with exactly that key so the push signer == subscribe key
  // (one prebuilt PWA, many laptop agents — a build-time key can't match). When
  // an agent's key arrives, subscribe with it and route the subscription back to
  // THAT room (room A's key produces room A's subscription). subscribeOnce tracks
  // per-room done so each agent subscribes once, across this path, restore, and
  // the build-time fallback — and a denied attempt stays retryable.
  useEffect(() => {
    manager.onVapidKey((publicKey, room) => {
      void subscribeOnce(pushDoneRef.current, room, publicKey, subscribeForPush, (sub) =>
        manager.sendPushSubscriptionTo(room, sub),
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On first pairing success, dismiss the code-entry screen + best-effort
  // subscribe to push. The agent's OWN VAPID key (handled by the onVapidKey
  // path above, routed back to its own room) is the preferred source. Here we
  // only fall back to the build-time VAPID_KEY for an agent that never sends a
  // key (older agent); if there is no build key either, we wait for onVapidKey.
  // subscribeOnce keeps the build-time fanout to a single SUCCESSFUL fire.
  const anyPaired = roster.some((a) => a.status === 'paired' || a.status === 'offline');
  useEffect(() => {
    if (!anyPaired) return;
    setPairing(false);
    if (manager.firstVapidKey()) return; // an agent key arrived — onVapidKey/restore owns it
    if (!VAPID_KEY) return; // no build-time key: wait for the agent's sealed key
    void subscribeOnce(pushDoneRef.current, BUILD_VAPID_ROOM, VAPID_KEY, subscribeForPush, (sub) =>
      manager.sendPushSubscription(sub),
    );
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
            // Forget-this-agent must also forget its push-done mark: room ids
            // are deterministic from the pairing code, so re-pairing the same
            // code reuses the SAME id and must be able to subscribe again.
            pushDoneRef.current.delete(id);
            manager.remove(id);
          }}
        />
      )}
      {renderScreen(c, state, expiresIn, {
        onSubmitCode,
        pairError,
        onApprove: () => manager.approve(),
        onDecline: () => manager.decline(),
        onChoose: (l: string) => manager.choose(l),
        onSend: (t: string) => manager.reply(t),
        onRetry: () => manager.retry(),
      })}
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

function renderScreen(c: Palette, state: SessionState, expiresIn: number | null, h: Handlers) {
  switch (state.screen) {
    case 'pair':
      return <PairScreen c={c} onSubmitCode={h.onSubmitCode} error={h.pairError} />;
    case 'lock':
      return <LockScreen c={c} agent={state.agent} onOpen={() => {}} />;
    case 'home':
      return <HomeScreen c={c} unread={state.request ? 1 : 0} onOpen={() => {}} />;
    case 'listening':
      return <ListeningScreen c={c} agent={state.agent} roomID={state.roomID} />;
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
