import { useEffect, useState } from 'react';
import type { AgentSummary, SessionManager } from '../lib/manager.ts';
import { pushPermission, removePushForRoom, requestPushPermission, type PushPermission } from '../lib/push.ts';

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
  const agentKeys = new Map(manager.vapidKeys().map(({ room, key }) => [room, key]));
  const targets = roster.filter((a) => a.status === 'paired' || a.status === 'offline')
    .map((a) => ({ room: a.id, key: agentKeys.get(a.id) || fallbackKey, status: a.status }))
    .sort((a, b) => a.room.localeCompare(b.room));
  const signature = JSON.stringify(targets);

  const retry = () => {
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
    if (permission !== 'granted') return;
    for (const { room, key } of targets) {
      if (!key) continue;
      const current = () => !canceled && pushPermission() === 'granted'
        && manager.list().some((a) => a.id === room)
        && (manager.vapidKeys().find((a) => a.room === room)?.key || fallbackKey) === key;
      void manager.reconcilePushSubscription(room, key, current);
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
    ready: targets.filter(({ room, key }) => manager.pushStatus(room, key) === 'ready').length,
    working: targets.some(({ room, key }) => manager.pushStatus(room, key) === 'working'),
    failed: targets.some(({ room, key }) => manager.pushStatus(room, key) === 'failed'),
    enable,
    retry,
    forget: (room) => { void removePushForRoom(room); },
  };
}
