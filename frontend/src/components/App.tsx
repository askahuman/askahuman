// App is the single React island: it owns the Session state machine and routes
// it to the nine screens. Pairing is code-only: the agent prints an 8-char code,
// the user opens /app and TYPES it. The phone canonicalizes the code, derives the
// relay room from it (HKDF, codegen.roomFromCode), and runs SPAKE2 as role B.
// NOTHING secret is ever placed in a URL/hash — there is no deep link.

import { useEffect, useRef, useState } from 'react';

import { canonicalizeCode, roomFromCode } from '../lib/codegen.ts';
import { SessionManager, type AgentSummary } from '../lib/manager.ts';
import { type PairPayload } from '../lib/payload.ts';
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

  // One SessionManager owns all live agents; the App re-renders off its single
  // onChange. tick forces a re-render when the manager (any session/roster) changes.
  const managerRef = useRef<SessionManager>(null as unknown as SessionManager);
  if (managerRef.current === null) managerRef.current = new SessionManager();
  const manager = managerRef.current;

  const [, setTick] = useState(0);
  // pairing flips to the code-entry PairScreen ("+ add agent") without dropping
  // live sessions; false = show the active agent. Starts true ONLY when empty.
  const [pairing, setPairing] = useState(true);
  // pairError surfaces a bad typed code inline; never opens a socket.
  const [pairError, setPairError] = useState<string | null>(null);
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

  // Bug 2 recovery: iOS silently kills the WebSocket when the PWA is
  // backgrounded and the frozen reconnect timer never fires, leaving a dead
  // socket believed-open. On resume (tab visible) or network restore, force a
  // reconnect of every session so the relay link comes back without a manual
  // Retry. relay.ts adds a heartbeat as defense-in-depth.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const recover = () => {
      if (document.visibilityState === 'visible') manager.retryAll();
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

  // The agent delivers its OWN VAPID public key sealed during pairing; the phone
  // MUST subscribe with exactly that key so the push signer == subscribe key
  // (one prebuilt PWA, many laptop agents — a build-time key can't match). When
  // an agent's key arrives, subscribe with it and route the subscription back to
  // THAT room (room A's key produces room A's subscription). pushDoneRef keeps it
  // to a single subscribe across both this path and the build-time fallback.
  useEffect(() => {
    manager.onVapidKey((publicKey, room) => {
      if (pushDoneRef.current) return;
      pushDoneRef.current = true;
      (async () => {
        const sub = await subscribeForPush(publicKey);
        if (sub) manager.sendPushSubscriptionTo(room, sub);
      })();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On first pairing success, dismiss the code-entry screen + best-effort
  // subscribe to push. The agent's OWN VAPID key (handled by the onVapidKey
  // path above, routed back to its own room) is the preferred source. Here we
  // only fall back to the build-time VAPID_KEY for an agent that never sends a
  // key (older agent); if there is no build key either, we wait for onVapidKey.
  // pushDoneRef keeps the subscribe to a single fire across both paths.
  const anyPaired = roster.some((a) => a.status === 'paired' || a.status === 'offline');
  useEffect(() => {
    if (!anyPaired) return;
    setPairing(false);
    if (pushDoneRef.current) return;
    if (manager.firstVapidKey()) return; // an agent key arrived — onVapidKey owns it
    if (!VAPID_KEY) return; // no build-time key: wait for the agent's sealed key
    pushDoneRef.current = true;
    (async () => {
      const sub = await subscribeForPush(VAPID_KEY);
      if (sub) manager.sendPushSubscription(sub);
    })();
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
      setPairError("that code doesn't look right — check the 8 characters");
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
      setPairError('could not connect — check the relay URL in Advanced settings');
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
          onRemove={(id) => manager.remove(id)}
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
