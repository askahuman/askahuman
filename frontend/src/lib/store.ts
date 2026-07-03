// store persists the phone's paired sessions across page loads. iOS routinely
// kills a backgrounded PWA page (memory pressure, user swipe, Safari reload);
// without persistence every kill silently lost the SPAKE2 session key, so the
// phone fell back to the pair screen while the agent — which keeps its session
// in RAM for its whole process lifetime — kept re-announcing into a room the
// phone could never rejoin. Persisting the derived session key (NEVER the
// pairing code) lets the phone rejoin the same room and pick the request up.
//
// SECURITY (see docs/decisions/architecture/0020_phone_session_persistence.md):
// the session key is stored per-origin in localStorage, the same trust class as
// an authenticated session cookie. The pairing CODE is never stored — the key
// cannot be turned back into it, and a stolen key works only until either side
// re-pairs. Removing an agent from the roster wipes its entry.

import type { Decision } from './wire.ts';
import { ROOM_RE, validRelayURL } from './payload.ts';
import { b64Decode } from './b64.ts';

/** StoredSession is one persisted paired agent. */
export interface StoredSession {
  /** r is the relay WebSocket URL the session dials. */
  r: string;
  /** room is the 16-hex room id. */
  room: string;
  /** key is the base64 32-byte SPAKE2 session key. */
  key: string;
  /** agent is the last-known agent label (for the roster before it reconnects). */
  agent: string;
  /** vapid is the agent-delivered VAPID PUBLIC key, if one arrived. */
  vapid?: string;
  /** seen is the bounded list of already-handled request ids (de-dupe). */
  seen?: string[];
  /** decisions maps answered request ids to the decision we sent, so a
   *  re-announce after a page kill can re-send it (see session.sentDecisions). */
  decisions?: Record<string, Decision>;
}

/** Persistence is the narrow storage interface the SessionManager depends on
 *  (localStorage in the app; an in-memory fake in tests). */
export interface Persistence {
  load(): StoredSession[];
  save(list: StoredSession[]): void;
}

const STORE_KEY = 'aah:sessions:v1';

/** validStored reports whether one parsed entry is usable: a WS relay URL, a
 *  well-formed room id, and a key that decodes to exactly 32 bytes. */
function validStored(s: StoredSession): boolean {
  if (typeof s.r !== 'string' || !validRelayURL(s.r)) return false;
  if (typeof s.room !== 'string' || !ROOM_RE.test(s.room)) return false;
  if (typeof s.key !== 'string') return false;
  try {
    return b64Decode(s.key).length === 32;
  } catch {
    return false;
  }
}

/** localStorePersistence is the real, localStorage-backed Persistence. Every
 *  call is best-effort: private mode / quota / disabled storage degrade to the
 *  old RAM-only behavior instead of throwing into the app. */
export const localStorePersistence: Persistence = {
  load(): StoredSession[] {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return (parsed as StoredSession[]).filter(validStored);
    } catch {
      return [];
    }
  },
  save(list: StoredSession[]): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(list));
    } catch {
      // best-effort: a failed save means restore-after-kill won't work this
      // time; the live session is unaffected.
    }
  },
};
