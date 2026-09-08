import { describe, expect, it } from 'vitest';
import { isAppURL, pushOpenURL, pushScope, roomFromPushHash, roomFromPushMessage, roomFromPushScope } from '../src/lib/push-routing.ts';
const ORIGIN = 'https://phone.example', ROOM = '0123456789abcdef';

describe('notification routing', () => {
  it('carries only an opaque room in an exact same-origin scope or fragment', () => {
    expect(roomFromPushScope(ORIGIN + pushScope(ROOM), ORIGIN)).toBe(ROOM);
    expect(roomFromPushHash(new URL(pushOpenURL(ROOM), ORIGIN).hash)).toBe(ROOM);
    expect(pushOpenURL(null)).toBe('/app/');
    for (const room of ['../secrets', ROOM.toUpperCase(), ROOM + '&code=secret', '']) {
      expect(() => pushScope(room)).toThrow();
      expect(roomFromPushHash('#wake=' + room)).toBeNull();
    }
  });
  it('rejects broader, nested, cross-origin, and query scopes', () => {
    for (const scope of [ORIGIN + '/app/', ORIGIN + pushScope(ROOM) + 'nested/', ORIGIN + pushScope(ROOM) + '?x=1', 'https://other.example' + pushScope(ROOM)]) {
      expect(roomFromPushScope(scope, ORIGIN)).toBeNull();
    }
    expect(isAppURL(ORIGIN + '/application', ORIGIN)).toBe(false);
    expect(isAppURL('https://other.example/app/', ORIGIN)).toBe(false);
    expect(isAppURL(ORIGIN + '/app/#wake=' + ROOM, ORIGIN)).toBe(true);
  });
  it('accepts only an application wake worker message from this origin', () => {
    const message = { origin: ORIGIN, data: { type: 'aah:push-open', room: ROOM }, source: { scriptURL: ORIGIN + '/sw.js?mode=push' } };
    const route = (value: unknown) => roomFromPushMessage(value as MessageEvent, ORIGIN);
    expect(route(message)).toBe(ROOM);
    expect(route({ ...message, origin: 'https://other.example' })).toBeNull();
    expect(route({ ...message, source: null })).toBeNull();
    expect(route({ ...message, source: { scriptURL: ORIGIN + '/other.js' } })).toBeNull();
    expect(route({ ...message, data: { ...message.data, room: ROOM + '#key=bad' } })).toBeNull();
  });
});
