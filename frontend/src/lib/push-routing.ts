// Room identifiers route wake-ups locally; no pairing code, key, or request
// content is included in a worker script URL, notification, or navigation.
export const PUSH_WORKER_URL = '/sw.js?mode=push';
export const PUSH_SCOPE_PREFIX = '/app/_push/';
const ROOM = /^[0-9a-f]{16}$/;

export function validPushRoom(room: unknown): room is string {
  return typeof room === 'string' && ROOM.test(room);
}

export function pushScope(room: string): string {
  if (!validPushRoom(room)) throw new Error('invalid push room');
  return `${PUSH_SCOPE_PREFIX}${room}/`;
}

export function roomFromPushScope(scope: string, origin: string): string | null {
  try {
    const url = new URL(scope);
    if (url.origin !== origin || url.search || url.hash) return null;
    const room = url.pathname.slice(PUSH_SCOPE_PREFIX.length, -1);
    return validPushRoom(room) && url.pathname === pushScope(room) ? room : null;
  } catch { return null; }
}

export function isAppURL(value: string, origin: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === origin && (url.pathname === '/app' || url.pathname === '/app/');
  } catch { return false; }
}

export function pushOpenURL(room: string | null): string {
  return validPushRoom(room) ? `/app/#wake=${room}` : '/app/';
}

export function roomFromPushHash(hash: string): string | null {
  const room = hash.startsWith('#wake=') ? hash.slice(6) : null;
  return validPushRoom(room) ? room : null;
}

export function roomFromPushMessage(event: MessageEvent, origin: string): string | null {
  if (event.origin !== origin || event.data?.type !== 'aah:push-open' || !validPushRoom(event.data.room)) return null;
  const source = event.source as ServiceWorker | null;
  if (!source || typeof source.scriptURL !== 'string') return null;
  try {
    const url = new URL(source.scriptURL);
    return url.origin === origin && url.pathname === '/sw.js' && url.search === '?mode=push' ? event.data.room : null;
  } catch { return null; }
}
