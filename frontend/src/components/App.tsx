// App is the single React island: it owns the Session state machine and routes
// it to the nine screens. On mount it reads the pairing payload from "#p=<payload>"
// (fragment) or "?p=<payload>" (query — survives QR scanning) and auto-starts
// pairing as the phone (role B). Absent a payload, it shows the pair screen with a
// self-minted code under "Show my code".
//
// Phase-3 (Playwright) entry point: visit "/#p=<base64url payload>" to inject a
// pairing; the App parses the hash and connects to the relay in the payload.

import { useEffect, useMemo, useRef, useState } from 'react';

import { newCode, newRoomID, defaultRelayURL } from '../lib/codegen.ts';
import { SessionManager, type AgentSummary } from '../lib/manager.ts';
import { type PairPayload, parseHash, parseQuery, scrubbedURL } from '../lib/payload.ts';
import { subscribeForPush } from '../lib/push.ts';
import { type SessionState } from '../lib/session.ts';
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
const KEYFRAMES = `
@keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0; } }
@keyframes pulse { 0% { transform: scale(0.7); opacity: 0.5; } 80%,100% { transform: scale(1.6); opacity: 0; } }
@keyframes scan { 0% { top: 22%; } 50% { top: 76%; } 100% { top: 22%; } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes slideDown { from { transform: translateY(-18px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
`;

/** PUBLIC_VAPID_KEY is a build-time placeholder; the agent may also send one. */
const VAPID_KEY =
  (import.meta as unknown as { env?: Record<string, string> }).env?.PUBLIC_VAPID_KEY ?? '';

function usePalette(): Palette {
  const [isDark, setIsDark] = useState(true);
  useEffect(() => {
    try {
      const stored = localStorage.getItem('theme');
      if (stored === 'light') setIsDark(false);
      else if (stored === 'dark') setIsDark(true);
      else if (window.matchMedia?.('(prefers-color-scheme: light)').matches) setIsDark(false);
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

  // Parse the deep-link payload once; this fixes the pairing role (phone = B).
  // Accept both "#p=" (fragment; private, used by clicked links) and "?p=" (query;
  // survives QR scanning where iOS Camera drops the fragment).
  const initialPayload = useMemo<PairPayload | null>(() => {
    if (typeof window === 'undefined') return null;
    return parseHash(window.location.hash) ?? parseQuery(window.location.search);
  }, []);

  // Scrub the pairing code out of the address bar/history the instant it is
  // parsed: ?p= / #p= carry the SPAKE2 password and must not leak via history,
  // screenshots, referrers, or a shared/copied URL. replaceState (not pushState)
  // so Back does not restore it. Runs once on mount when a payload was present.
  useEffect(() => {
    if (typeof window === 'undefined' || !initialPayload) return;
    if (!window.location.search && !window.location.hash) return;
    window.history.replaceState(null, '', scrubbedURL(window.location.href));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A self-minted payload for the "Show my code" path when no #p= was provided.
  const shownPayload = useMemo<PairPayload | null>(() => {
    if (typeof window === 'undefined') return null;
    if (initialPayload) return null; // scanned/deep-linked: nothing to show
    return { r: defaultRelayURL(window.location.origin), room: newRoomID(), code: newCode() };
  }, [initialPayload]);

  // mintPayload makes a fresh self-shown payload for the add-agent flow (so the
  // "+" chip can pair a NEW agent even when the first arrived via a deep link).
  const mintPayload = (): PairPayload | null => {
    if (typeof window === 'undefined') return null;
    return { r: defaultRelayURL(window.location.origin), room: newRoomID(), code: newCode() };
  };

  // One SessionManager owns all live agents; the App re-renders off its single
  // onChange. tick forces a re-render when the manager (any session/roster) changes.
  const managerRef = useRef<SessionManager>(null as unknown as SessionManager);
  if (managerRef.current === null) managerRef.current = new SessionManager();
  const manager = managerRef.current;

  const [, setTick] = useState(0);
  // addPayload, when set, flips to the add-agent PairScreen ("Show my code" for a
  // fresh room) without dropping live sessions; null = show the active agent.
  const [addPayload, setAddPayload] = useState<PairPayload | null>(null);
  const pushDoneRef = useRef(false);

  // Subscribe to the manager once; tear every session down on unmount.
  useEffect(() => {
    const unsub = manager.onChange(() => setTick((t) => t + 1));
    return () => {
      unsub();
      manager.closeAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Seed the FIRST agent from a deep-link OR self-shown payload (ADD, not replace).
  useEffect(() => {
    const payload = initialPayload ?? shownPayload;
    if (!payload) return;
    manager.add(payload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPayload, shownPayload]);

  // Add-agent "Show my code": start a live Session on the minted room so the
  // phone can receive the agent's pake when it scans (add is idempotent).
  useEffect(() => {
    if (addPayload) manager.add(addPayload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addPayload]);

  const activeState = manager.activeState();
  const roster: AgentSummary[] = manager.list();
  // While adding, pin the pair screen for the minted room (its Session is active,
  // so activeState supplies live paired/conn truth for the "Show my code" badge);
  // auto-dismiss once that agent pairs.
  useEffect(() => {
    if (addPayload && manager.getActive() === addPayload.room && activeState.paired) {
      setAddPayload(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addPayload, activeState.paired]);

  const state: SessionState = addPayload ? { ...activeState, screen: 'pair' } : activeState;
  // The add-agent screen shows its own minted code; otherwise the seed payload.
  const screenShown = addPayload ?? shownPayload;

  // On first pairing success, best-effort subscribe + fan the push sub to all.
  useEffect(() => {
    const anyPaired = roster.some((a) => a.status === 'paired' || a.status === 'offline');
    if (!anyPaired || pushDoneRef.current) return;
    pushDoneRef.current = true;
    (async () => {
      const sub = await subscribeForPush(VAPID_KEY);
      if (sub) manager.sendPushSubscription(sub);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roster.some((a) => a.status === 'paired' || a.status === 'offline')]);

  const expiresIn = useExpiryCountdown(state, (id) => manager.expire(id));

  // onScanned/shownPayload ADD an agent; a successful add foregrounds it.
  const onScanned = (payload: PairPayload) => {
    manager.add(payload);
    setAddPayload(null);
  };

  return (
    <>
      <style>{KEYFRAMES}</style>
      {roster.length > 0 && (
        <Roster
          c={c}
          agents={roster}
          onSelect={(id) => {
            setAddPayload(null);
            manager.setActive(id);
          }}
          onAdd={() => setAddPayload(mintPayload())}
          onRemove={(id) => {
            // Closing the in-progress add-agent also dismisses its pinned pair screen.
            if (addPayload?.room === id) setAddPayload(null);
            manager.remove(id);
          }}
        />
      )}
      {renderScreen(c, state, expiresIn, {
        onScanned,
        shownPayload: screenShown,
        webOrigin: typeof window !== 'undefined' ? window.location.origin : '',
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
  onScanned: (p: PairPayload) => void;
  shownPayload: PairPayload | null;
  webOrigin: string;
  onApprove: () => void;
  onDecline: () => void;
  onChoose: (label: string) => void;
  onSend: (text: string) => void;
  onRetry: () => void;
}

function renderScreen(c: Palette, state: SessionState, expiresIn: number | null, h: Handlers) {
  switch (state.screen) {
    case 'pair':
      return (
        <PairScreen
          c={c}
          onScanned={h.onScanned}
          showPayload={h.shownPayload}
          paired={state.paired}
          webOrigin={h.webOrigin}
        />
      );
    case 'lock':
      return <LockScreen c={c} agent={state.agent} onOpen={() => {}} />;
    case 'home':
      return <HomeScreen c={c} unread={state.request ? 1 : 0} onOpen={() => {}} />;
    case 'listening':
      return <ListeningScreen c={c} agent={state.agent} roomID={state.roomID} />;
    case 'yesno':
      return state.request ? (
        <YesNoScreen c={c} req={state.request} expiresIn={expiresIn} onApprove={h.onApprove} onDecline={h.onDecline} />
      ) : (
        <ListeningScreen c={c} agent={state.agent} roomID={state.roomID} />
      );
    case 'choice':
      return state.request ? (
        <ChoiceScreen c={c} req={state.request} expiresIn={expiresIn} onChoose={h.onChoose} />
      ) : (
        <ListeningScreen c={c} agent={state.agent} roomID={state.roomID} />
      );
    case 'text':
      return state.request ? (
        <TextScreen c={c} req={state.request} expiresIn={expiresIn} onSend={h.onSend} />
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
