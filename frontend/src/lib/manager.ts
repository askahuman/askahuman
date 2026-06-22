// manager composes N single-room Sessions into one foreground-able roster, so
// the phone can hold several paired agents at once and switch among them. It is
// the single owner of session lifecycle and the aggregate state the React
// island renders.
//
//   add(payload) -> new Session(...).start(), stored under payload.room
//   a request on ANY session bumps that agent's unread; if no card is open on
//   the active agent it also auto-foregrounds the asking agent (a card already
//   open is never stolen).
//
// Sessions stay single-room and sibling-unaware (minimum divergence per
// ADR 0007); all multi-agent logic lives here. No relay/crypto/wire change.

import type { PairPayload } from './payload.ts';
import type { PushSubscription } from './wire.ts';
import { Session, type SessionOptions, type SessionState, initialState } from './session.ts';

/** AgentStatus is the roster dot color source. */
export type AgentStatus = 'paired' | 'connecting' | 'offline' | 'waiting';

/** AgentSummary is one roster chip's data (insertion order). */
export interface AgentSummary {
  id: string; // roomID
  label: string; // Request.agent (the --name flag) else short room id
  status: AgentStatus;
  unread: number;
  hasRequest: boolean;
  active: boolean;
}

const CARD_SCREENS: ReadonlySet<string> = new Set(['yesno', 'choice', 'text']);

interface Entry {
  session: Session;
  unsub: () => void;
  unread: number;
  /** id of the last request we counted, so a re-render doesn't re-bump unread. */
  lastReqID: string | null;
  /** whether the retained push subscription has been delivered to this session. */
  pushSent: boolean;
}

/**
 * SessionManager owns a Map<roomID, Session> and one aggregate onChange. The App
 * re-renders off the single subscription; all decision/transport calls route to
 * the active session (sendPushSubscription fans out to every paired session).
 */
export class SessionManager {
  private readonly entries = new Map<string, Entry>();
  private readonly order: string[] = []; // insertion order for list()
  private active = '';
  private readonly listeners = new Set<(m: SessionManager) => void>();
  // lastSub is the phone's most recent Web Push subscription, retained so an
  // agent added AFTER the phone subscribed still receives it (fanout on add).
  private lastSub: PushSubscription | null = null;

  constructor(private readonly opts: SessionOptions = {}) {}

  /**
   * add constructs a Session for the payload, starts it, and stores it under the
   * room id. A duplicate room id returns the existing id without a second socket.
   * The first agent added becomes active.
   */
  add(payload: PairPayload): string {
    const room = payload.room;
    if (this.entries.has(room)) return room; // idempotent: no second socket

    const session = new Session(payload, this.opts);
    const entry: Entry = { session, unsub: () => {}, unread: 0, lastReqID: null, pushSent: false };
    entry.unsub = session.onChange(() => this.onSessionChange(room));
    this.entries.set(room, entry);
    this.order.push(room);
    if (!this.active) this.active = room;
    session.start();
    // A retained push subscription is delivered to this agent once it PAIRS
    // (it has no session key yet here); see onSessionChange.
    this.emit();
    return room;
  }

  /**
   * remove closes the session and drops it; if it was active, re-picks the first
   * remaining agent (or '' when none remain).
   */
  remove(room: string): void {
    const entry = this.entries.get(room);
    if (!entry) return;
    entry.unsub();
    entry.session.close();
    this.entries.delete(room);
    const i = this.order.indexOf(room);
    if (i >= 0) this.order.splice(i, 1);
    if (this.active === room) this.active = this.order[0] ?? '';
    this.emit();
  }

  /** list returns the roster in insertion order. */
  list(): AgentSummary[] {
    return this.order.map((room) => {
      const entry = this.entries.get(room)!;
      const s = entry.session.getState();
      return {
        id: room,
        label: s.agent && s.agent !== 'your agent' ? s.agent : room.slice(0, 4),
        status: statusOf(s),
        unread: entry.unread,
        hasRequest: s.request != null,
        active: room === this.active,
      };
    });
  }

  /** setActive foregrounds a room and clears its unread. */
  setActive(room: string): void {
    if (!this.entries.has(room) || this.active === room) {
      this.clearUnread(room);
      return;
    }
    this.active = room;
    this.clearUnread(room);
    this.emit();
  }

  /** getActive returns the foreground room id ('' when empty). */
  getActive(): string {
    return this.active;
  }

  /** activeState returns the active session's snapshot, or the pre-pair state. */
  activeState(): SessionState {
    const entry = this.active ? this.entries.get(this.active) : undefined;
    if (!entry) return { ...initialState(), screen: 'pair' };
    return entry.session.getState();
  }

  /** onChange subscribes to any session/roster/active change; returns unsub. */
  onChange(cb: (m: SessionManager) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // --- passthrough to the ACTIVE session ----------------------------------

  approve(): void {
    this.activeSession()?.approve();
  }
  decline(): void {
    this.activeSession()?.decline();
  }
  choose(label: string): void {
    this.activeSession()?.choose(label);
  }
  reply(text: string): void {
    this.activeSession()?.reply(text);
  }
  retry(): void {
    this.activeSession()?.retry();
  }
  /**
   * retryAll forces an immediate, clean reconnect of EVERY session. The App calls
   * this on visibilitychange→visible / window 'online': iOS silently kills the
   * WebSocket when the PWA is backgrounded and the frozen reconnect timer never
   * fires, so on resume we proactively drop + reopen each socket. retryNow
   * detaches the old socket first, so this is a single clean reconnect per
   * session (no orphaned socket, no reconnect storm) even on a healthy one.
   */
  retryAll(): void {
    for (const entry of this.entries.values()) entry.session.retry();
  }
  /** expire drives the active session's open card out of the actionable state
   *  once its request has timed out (mirrors the agent's own deadline). */
  expire(id: string): void {
    this.activeSession()?.expire(id);
  }

  /** sendPushSubscription fans out the phone's push sub to every paired session
   *  and retains it so agents added later also receive it (see add). */
  sendPushSubscription(sub: PushSubscription): boolean {
    this.lastSub = sub;
    let any = false;
    for (const entry of this.entries.values()) {
      if (entry.session.sendPushSubscription(sub)) {
        entry.pushSent = true;
        any = true;
      }
    }
    return any;
  }

  /** closeAll tears down every session (unmount). */
  closeAll(): void {
    for (const entry of this.entries.values()) {
      entry.unsub();
      entry.session.close();
    }
    this.entries.clear();
    this.order.length = 0;
    this.active = '';
  }

  // --- internals -----------------------------------------------------------

  private activeSession(): Session | undefined {
    return this.active ? this.entries.get(this.active)?.session : undefined;
  }

  private clearUnread(room: string): void {
    const entry = this.entries.get(room);
    if (entry) entry.unread = 0;
  }

  /**
   * onSessionChange runs the unread + auto-foreground rule, then re-emits.
   * A NEW request (a request id we haven't counted) on a non-active agent bumps
   * its unread; then if the active agent has no card open, foreground the asker.
   * A card already open on the active agent is never stolen — the badge waits.
   */
  private onSessionChange(room: string): void {
    const entry = this.entries.get(room);
    if (entry) {
      // Deliver the retained push subscription once this agent is paired — an
      // agent added after the phone subscribed has no session key until then.
      if (this.lastSub && !entry.pushSent && entry.session.sendPushSubscription(this.lastSub)) {
        entry.pushSent = true;
      }
      const s = entry.session.getState();
      const reqID = s.request?.id ?? null;
      const isCard = s.request != null && CARD_SCREENS.has(s.screen);
      const isNewRequest = isCard && reqID !== entry.lastReqID;
      if (isNewRequest) {
        entry.lastReqID = reqID;
        if (room !== this.active) entry.unread += 1;
        if (!this.activeHasCardOpen()) {
          this.active = room;
          this.clearUnread(room);
        }
      }
      // Forget a resolved request id so the next one (even same id reused) counts.
      if (!isCard) entry.lastReqID = null;
    }
    this.emit();
  }

  private activeHasCardOpen(): boolean {
    const entry = this.active ? this.entries.get(this.active) : undefined;
    if (!entry) return false;
    return CARD_SCREENS.has(entry.session.getState().screen);
  }

  private emit(): void {
    for (const cb of this.listeners) cb(this);
  }
}

/** statusOf maps a SessionState to a roster status (reuses conn/paired truth). */
function statusOf(s: SessionState): AgentStatus {
  if (s.paired) return s.conn === 'open' ? 'paired' : 'offline';
  if (s.conn === 'connecting' || s.conn === 'open') return 'connecting';
  return 'waiting';
}
