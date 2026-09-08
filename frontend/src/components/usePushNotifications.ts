import { useEffect, useRef, useState } from 'react';
import type { AgentSummary, SessionManager } from '../lib/manager.ts';
import { pushPermission, removePushForRoom, requestPushPermission, subscribeForPush, type PushPermission } from '../lib/push.ts';
import { subscribeAndDeliver } from '../lib/push-delivery.ts';

export type RoomPushStatus = 'working' | 'ready' | 'failed' | 'waiting';
export interface PushStatus {
  permission: PushPermission;
  total: number;
  ready: number;
  working: boolean;
  failed: boolean;
  enable: () => void;
  retry: () => void;
  forget: (room: string) => void;
}

/** The native prompt is only called by enable(), directly from a button.
 * Restored/new rooms subscribe silently only after permission is granted. */
export function usePushNotifications(manager: SessionManager, roster: AgentSummary[], fallbackKey: string): PushStatus {
  const [permission, setPermission] = useState<PushPermission>(pushPermission);
  const [generation, setGeneration] = useState(0);
  const [, setKeyVersion] = useState(0);
  const [states, setStates] = useState<Record<string, RoomPushStatus>>({});
  const done = useRef(new Map<string, string>());
  const agentKeys = new Map(manager.vapidKeys().map(({ room, key }) => [room, key]));
  const targets = roster.filter((a) => a.status === 'paired' || a.status === 'offline')
    .map((a) => ({ room: a.id, key: agentKeys.get(a.id) || fallbackKey, status: a.status }))
    .sort((a, b) => a.room.localeCompare(b.room));
  const signature = JSON.stringify(targets);

  const retry = () => {
    done.current.clear();
    setPermission(pushPermission());
    setGeneration((v) => v + 1);
  };

  useEffect(() => {
    manager.onVapidKey(() => setKeyVersion((v) => v + 1));
    const resume = () => { if (document.visibilityState === 'visible') retry(); };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', retry);
    return () => {
      manager.onVapidKey(() => {});
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', retry);
    };
  }, [manager]);

  useEffect(() => {
    let canceled = false;
    if (permission !== 'granted') {
      done.current.clear();
      setStates({});
      return;
    }
    const next: Record<string, RoomPushStatus> = {};
    for (const { room, key } of targets) {
      next[room] = !key ? 'waiting' : done.current.get(room) === key ? 'ready' : 'working';
    }
    setStates(next);
    for (const { room, key } of targets) {
      if (next[room] !== 'working') continue;
      const current = () => !canceled && pushPermission() === 'granted'
        && manager.list().some((a) => a.id === room)
        && (manager.vapidKeys().find((a) => a.room === room)?.key || fallbackKey) === key;
      void subscribeAndDeliver(room, key, subscribeForPush, (sub) => manager.sendPushSubscriptionTo(room, sub), current)
        .then((sent) => {
          if (!current()) return;
          if (sent) done.current.set(room, key);
          setStates((old) => ({ ...old, [room]: sent ? 'ready' : 'failed' }));
        });
    }
    return () => { canceled = true; };
    // signature includes the room, key, and connection status. A reconnect
    // retries a previously failed sealed delivery; unrelated renders do not.
  }, [manager, signature, permission, generation]);

  const enable = () => {
    const requested = requestPushPermission(); // Keep the native call inside the click gesture.
    void requested.then((value) => {
      setPermission(value);
      setGeneration((v) => v + 1);
    });
  };
  return {
    permission,
    total: targets.length,
    ready: targets.filter(({ room, key }) => states[room] === 'ready' && done.current.get(room) === key).length,
    working: targets.some(({ room }) => states[room] === 'working'),
    failed: targets.some(({ room }) => states[room] === 'failed'),
    enable,
    retry,
    forget: (room) => { done.current.delete(room); void removePushForRoom(room); },
  };
}
