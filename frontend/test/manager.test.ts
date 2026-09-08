// Unit tests for the SessionManager: composes N single-room Sessions over
// independent FakeWS sockets (one per room), mirroring session.test.ts. Drives
// the real handshake + secretbox so list()/status/unread/auto-foreground and the
// active-session passthrough are exercised end-to-end without a DOM.

import { afterEach, describe, expect, it } from "vitest";

import { open as boxOpen } from "../src/lib/crypto.ts";
import { b64Decode, b64Encode } from "../src/lib/b64.ts";
import { PROTOCOL, pushSigningMessage, verify } from "../src/lib/protocol.ts";
import {
  acknowledge,
  decisions,
  deviceKeyLoader,
  protocolLedgerLoader,
  pairAgent,
  sendReq,
  sendVapid,
  settle,
  until,
} from "./protocol-fixture.ts";
import { SessionManager } from "../src/lib/manager.ts";
import { type WSLike } from "../src/lib/relay.ts";
import { type PairPayload } from "../src/lib/payload.ts";
import { type Persistence, type StoredSession } from "../src/lib/store.ts";
import type { PushSubscriptionProvider } from "../src/lib/push-delivery.ts";
import { type PushSubscription, type PushSub, type Request, KindRequest } from "../src/lib/wire.ts";

/** FakeWS captures sent frames per-room; the test plays the agent + relay. */
class FakeWS implements WSLike {
  static byRoom = new Map<string, FakeWS>();
  closeCalls = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(public url: string) {
    const room = new URL(url).searchParams.get("room") ?? url;
    FakeWS.byRoom.set(room, this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closeCalls++;
    this.onclose?.({});
  }
  open(): void {
    this.onopen?.(undefined);
  }
  recv(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  lastSent(): Record<string, unknown> {
    return this.sent[this.sent.length - 1]!;
  }
}

function payload(room: string, code = "PAIR-1"): PairPayload {
  return { r: `wss://relay.example/ws?room=${room}`, room, code };
}

const managers = new Set<SessionManager>();
const nativeSubscriptions = new Map<string, PushSubscription>();
const nativeProvider: PushSubscriptionProvider = async (_key, room, use, current, valid) => {
  if (valid && !(await valid())) return false;
  const sub = nativeSubscriptions.get(room);
  return !!sub && current() && await use(sub);
};
function deliver(manager: SessionManager, room: string, sub: PushSubscription, key = "build-key") {
  nativeSubscriptions.set(room, sub);
  return manager.reconcilePushSubscription(room, key);
}
afterEach(() => {
  for (const manager of managers) manager.closeAll();
  managers.clear();
  nativeSubscriptions.clear();
});

function newManager(persist?: Persistence, provider = nativeProvider): SessionManager {
  FakeWS.byRoom.clear();
  const manager = new SessionManager(
    {
      deviceKeyLoader,
      protocolLedgerLoader,
      relayOptions: {
        wsFactory: (url) => new FakeWS(url),
        setTimer: () => 0,
        clearTimer: () => {},
      },
    },
    persist,
    provider,
  );
  managers.add(manager);
  return manager;
}

/** FakePersist is an in-memory Persistence capturing every save. */
class FakePersist implements Persistence {
  constructor(public stored: StoredSession[] = []) {}
  load(): StoredSession[] {
    return this.stored;
  }
  save(list: StoredSession[]): void {
    this.stored = list;
  }
}

/** Pair through the real v2 identity-bound PAKE and device signer. */
async function pair(room: string, code = "PAIR-1") {
  return pairAgent(() => FakeWS.byRoom.get(room), code, room);
}

/** Open and verify each actual push_sub instead of counting arbitrary boxes. */
async function pushSubscriptions(
  ws: FakeWS,
  key: Uint8Array,
): Promise<PushSub[]> {
  const messages = ws.sent
    .filter((f) => typeof f.box === "string")
    .map(
      (f) =>
        JSON.parse(
          new TextDecoder().decode(boxOpen(key, f.box as string)),
        ) as PushSub,
    )
    .filter((m) => m.kind === "push_sub");
  const device = await deviceKeyLoader();
  for (const message of messages) {
    expect(message.protocol).toBe(PROTOCOL);
    expect(
      await verify(device.publicKey, pushSigningMessage(message), message.sig),
    ).toBe(true);
  }
  return messages;
}

const yesno = (id: string, agent?: string): Request => ({
  kind: KindRequest,
  id,
  title: "T",
  summary: "S",
  ...(agent ? { agent } : {}),
  response: { kind: "yesno" },
});

describe("SessionManager", () => {
  it("add creates a live session that pairs; list reports status + label", async () => {
    const m = newManager();
    const room = "aaaa000000000000";
    expect(m.add(payload(room))).toBe(room);
    expect(m.getActive()).toBe(room); // first add becomes active

    // pre-pair: label falls back to short room id.
    expect(m.list()[0]!.label).toBe("aaaa");

    const { ws, agentKey } = await pair(room);
    expect(m.list()[0]!.status).toBe("paired");
    expect(m.activeState().paired).toBe(true);

    // a Request supplies the --name label.
    await sendReq(ws, agentKey, yesno("r1", "cursor @ box"));
    expect(m.list()[0]!.label).toBe("cursor @ box");
  });

  it("holds two agents simultaneously over independent sockets", async () => {
    const m = newManager();
    const a = "aaaa111111111111";
    const b = "bbbb222222222222";
    m.add(payload(a));
    m.add(payload(b));
    await pair(a);
    await pair(b);

    const list = m.list();
    expect(list).toHaveLength(2);
    expect(list.every((x) => x.status === "paired")).toBe(true);

    // A box on agent B does NOT touch agent A's state.
    const aState = m.activeState(); // active is still a (first added)
    expect(m.getActive()).toBe(a);
    expect(aState.request).toBeNull();
  });

  it("auto-foregrounds a request on the non-active agent (no card open)", async () => {
    const m = newManager();
    const a = "aaaa333333333333";
    const b = "bbbb444444444444";
    m.add(payload(a));
    m.add(payload(b));
    await pair(a);
    const { ws: wsB, agentKey: keyB } = await pair(b);
    expect(m.getActive()).toBe(a);

    await sendReq(wsB, keyB, yesno("rb"));
    // No card was open on a -> manager foregrounds b and clears its unread.
    expect(m.getActive()).toBe(b);
    expect(m.activeState().screen).toBe("yesno");
    expect(m.list().find((x) => x.id === b)!.unread).toBe(0);
  });

  it("only bumps unread when a card is already open on the active agent", async () => {
    const m = newManager();
    const a = "aaaa555555555555";
    const b = "bbbb666666666666";
    m.add(payload(a));
    m.add(payload(b));
    const { ws: wsA, agentKey: keyA } = await pair(a);
    const { ws: wsB, agentKey: keyB } = await pair(b);

    // Open a card on the active agent a.
    await sendReq(wsA, keyA, yesno("ra"));
    expect(m.getActive()).toBe(a);
    expect(m.activeState().screen).toBe("yesno");

    // Request on b must NOT steal the open card; only bump b's badge.
    await sendReq(wsB, keyB, yesno("rb"));
    expect(m.getActive()).toBe(a);
    expect(m.list().find((x) => x.id === b)!.unread).toBe(1);

    // A returning peer is still asking the SAME unanswered question, not a
    // second unread request. It must not steal the active agent's card.
    wsB.recv({ _relay: "peer_left" });
    wsB.recv({ _relay: "peer_joined" });
    await sendReq(wsB, keyB, yesno("rb"));
    expect(m.getActive()).toBe(a);
    expect(m.list().find((x) => x.id === b)!.unread).toBe(1);
  });

  it("setActive switches + clears unread; decisions route to the active session", async () => {
    const m = newManager();
    const a = "aaaa777777777777";
    const b = "bbbb888888888888";
    m.add(payload(a));
    m.add(payload(b));
    const { ws: wsA, agentKey: keyA } = await pair(a);
    const { ws: wsB, agentKey: keyB } = await pair(b);

    // Open card on a, then a queued request on b (a has a card open -> badge only).
    await sendReq(wsA, keyA, yesno("ra"));
    await sendReq(wsB, keyB, yesno("rb"));
    expect(m.list().find((x) => x.id === b)!.unread).toBe(1);

    m.setActive(b);
    expect(m.getActive()).toBe(b);
    expect(m.list().find((x) => x.id === b)!.unread).toBe(0);

    // approve() routes to b -> only b's key opens the sealed decision.
    m.approve();
    await until(() => decisions(wsB, keyB).length === 1);
    expect(decisions(wsA, keyA)).toEqual([]);
    expect(m.activeState().screen).toBe("pending");
    expect(m.activeState().request?.id).toBe("rb");
    const d = await acknowledge(wsB, keyB);
    expect(d).toMatchObject({
      kind: "decision",
      protocol: PROTOCOL,
      room: b,
      id: "rb",
      result: { approved: true },
    });
    expect(m.activeState().request).toBeNull();
    expect(m.activeState().result?.label).toBe("Answer received by agent");
  });

  it("re-sends the retained decision when the agent re-announces an answered id (lost decision)", async () => {
    const m = newManager();
    const room = "aaaa9999bbbb0000";
    m.add(payload(room));
    const { ws, agentKey } = await pair(room);

    await sendReq(ws, agentKey, yesno("r1"));
    expect(m.activeState().screen).toBe("yesno");
    m.approve();
    await until(() => decisions(ws, agentKey).length === 1);
    const original = decisions(ws, agentKey)[0]!;
    const sentBefore = decisions(ws, agentKey).length;

    // The decision was written into a half-open socket and lost; the agent is
    // still asking, so it re-announces the same id after the phone reconnects.
    await sendReq(ws, agentKey, yesno("r1"));

    // The answer remains pending and cannot be edited; the same signed intent
    // is retransmitted until an authenticated agent receipt arrives.
    expect(m.activeState().screen).toBe("pending");
    expect(m.activeState().request?.id).toBe("r1");
    expect(decisions(ws, agentKey)).toHaveLength(sentBefore + 1);
    expect(decisions(ws, agentKey).at(-1)).toEqual(original);
    await acknowledge(ws, agentKey);
    expect(m.activeState().request).toBeNull();
  });
  it("a delayed Done from another agent cannot dismiss the active receipt", async () => {
    const m = newManager();
    const a = "aaaa777777777777", b = "bbbb888888888888";
    m.add(payload(a));
    m.add(payload(b));
    const { ws: wsA, agentKey: keyA } = await pair(a);
    const { ws: wsB, agentKey: keyB } = await pair(b);
    await sendReq(wsA, keyA, yesno("same-id"));
    m.approve();
    await acknowledge(wsA, keyA);
    const resultA = m.activeState().result!;
    await sendReq(wsB, keyB, yesno("same-id"));
    expect(m.getActive()).toBe(b);
    m.approve();
    await acknowledge(wsB, keyB);
    const resultB = m.activeState().result!;
    expect(resultB).toEqual(resultA);
    m.dismissConfirmation(resultA);
    expect(m.activeState().screen).toBe("confirmed");
    expect(m.activeState().result).toBe(resultB);
    m.dismissConfirmation(resultB);
    expect(m.activeState().screen).toBe("listening");
    m.setActive(a);
    expect(m.activeState().result).toBe(resultA);
    m.dismissConfirmation(resultA);
    expect(m.activeState().screen).toBe("listening");
  });

  it("a re-announced id that expired locally (never answered) stays silent", async () => {
    const m = newManager();
    const room = "cccc9999dddd0000";
    m.add(payload(room));
    const { ws, agentKey } = await pair(room);

    await sendReq(ws, agentKey, yesno("r2"));
    m.expire("r2"); // countdown hit zero: card dismissed, nothing was sent
    const sentBefore = ws.sent.filter((f) => typeof f.box === "string").length;

    await sendReq(ws, agentKey, yesno("r2"));
    expect(m.activeState().request).toBeNull();
    expect(ws.sent.filter((f) => typeof f.box === "string")).toHaveLength(
      sentBefore,
    );
  });

  it("remove closes the active session and re-picks active", async () => {
    const m = newManager();
    const a = "aaaa999999999999";
    const b = "bbbbaaaaaaaaaaaa";
    m.add(payload(a));
    m.add(payload(b));
    await until(() => FakeWS.byRoom.has(a) && FakeWS.byRoom.has(b));
    const removedSocket = FakeWS.byRoom.get(a)!;
    const retainedSocket = FakeWS.byRoom.get(b)!;
    expect(m.getActive()).toBe(a);
    m.remove(a);
    expect(m.getActive()).toBe(b);
    expect(m.list()).toHaveLength(1);
    expect(removedSocket.closeCalls).toBe(1);
    expect(retainedSocket.closeCalls).toBe(0);
  });

  it("add is idempotent on a duplicate room (no second socket)", async () => {
    const m = newManager();
    const a = "cccc000000000000";
    m.add(payload(a));
    await until(() => FakeWS.byRoom.has(a));
    const first = FakeWS.byRoom.get(a);
    expect(m.add(payload(a))).toBe(a); // same id back
    expect(FakeWS.byRoom.get(a)).toBe(first); // same socket, not replaced
    expect(m.list()).toHaveLength(1);
  });

  it("replaces a failed same-room handshake when the human submits another attempt", async () => {
    const m = newManager();
    const p = payload("fa11ed00fa11ed00");
    m.add(p);
    await until(() => FakeWS.byRoom.has(p.room));
    const failed = FakeWS.byRoom.get(p.room)!;
    failed.open();
    failed.recv({ _relay: "peer_joined" });
    failed.recv({ pake: "invalid-pake" });
    await until(() => m.activeState().pairError);
    expect(m.activeState().pairError).toBeTruthy();
    m.add(p);
    await until(() => FakeWS.byRoom.get(p.room) !== failed);
    const fresh = FakeWS.byRoom.get(p.room)!;
    expect(fresh).not.toBe(failed);
    expect(m.list()).toHaveLength(1);
    expect(m.activeState().pairError).toBeNull();
    m.closeAll();
  });

  it("retryAll forces a reconnect of every session (iOS resume recovery)", async () => {
    const m = newManager();
    const a = "ffff000000000000";
    const b = "ffff111111111111";
    m.add(payload(a));
    m.add(payload(b));
    await pair(a);
    await pair(b);
    const beforeA = FakeWS.byRoom.get(a);
    const beforeB = FakeWS.byRoom.get(b);

    // retryNow closes the stale socket + reconnects: a fresh FakeWS replaces each.
    m.retryAll();
    expect(FakeWS.byRoom.get(a)).not.toBe(beforeA);
    expect(FakeWS.byRoom.get(b)).not.toBe(beforeB);
  });

  it("reconciles each room separately even with a shared fallback key", async () => {
    const m = newManager();
    const a = "dddd000000000000";
    const b = "eeee000000000000";
    m.add(payload(a));
    m.add(payload(b));
    const { ws: wsA, agentKey: keyA } = await pair(a);
    const { ws: wsB, agentKey: keyB } = await pair(b);

    const sub = {
      endpoint: "https://push.example/x",
      keys: { p256dh: "p", auth: "au" },
    };
    const otherSub = { ...sub, endpoint: "https://push.example/other-room" };
    expect(await deliver(m, a, sub)).toBe(true);
    expect(await deliver(m, b, otherSub)).toBe(true);
    expect(await pushSubscriptions(wsA, keyA)).toEqual([
      expect.objectContaining({ room: a, subscription: sub }),
    ]);
    expect(await pushSubscriptions(wsB, keyB)).toEqual([
      expect.objectContaining({ room: b, subscription: otherSub }),
    ]);
  });

  it("routes an agent vapid_key to onVapidKey tagged with its room", async () => {
    const m = newManager();
    const a = "a1a1a1a1a1a1a1a1";
    const b = "b2b2b2b2b2b2b2b2";
    m.add(payload(a));
    m.add(payload(b));
    const { ws: wsA, agentKey: keyA } = await pair(a);
    const { agentKey: keyB } = await pair(b);

    const got: Array<{ pub: string; room: string }> = [];
    m.onVapidKey((pub, room) => got.push({ pub, room }));

    // Only agent A delivers a key -> the handler fires with A's room id, and
    // firstVapidKey reflects A's key.
    await sendVapid(wsA, keyA, "Akey");
    expect(got).toEqual([{ pub: "Akey", room: a }]);
    expect(m.firstVapidKey()).toBe("Akey");
    void keyB; // B intentionally sends no key in this case
  });

  it("reconciliation delivers the agent-keyed sub back to ONLY that room", async () => {
    const m = newManager();
    const a = "c3c3c3c3c3c3c3c3";
    const b = "d4d4d4d4d4d4d4d4";
    m.add(payload(a));
    m.add(payload(b));
    const { ws: wsA, agentKey: keyA } = await pair(a);
    const { ws: wsB, agentKey: keyB } = await pair(b);

    // Drive the real App wiring: a vapid_key on A produces a subscription that is
    // routed back to A (room A's key must yield room A's subscription, never B's).
    const sub = {
      endpoint: "https://push/a",
      keys: { p256dh: "p", auth: "au" },
    };
    let delivery: Promise<boolean> | undefined;
    m.onVapidKey((_pub, room) => {
      delivery = deliver(m, room, sub, _pub);
    });
    await sendVapid(wsA, keyA, "Akey");

    expect(delivery).toBeDefined();
    expect(await delivery).toBe(true);
    expect(await pushSubscriptions(wsA, keyA)).toEqual([
      expect.objectContaining({ room: a, subscription: sub }),
    ]);
    expect(await pushSubscriptions(wsB, keyB)).toEqual([]); // B untouched
  });

  it("list() sorts an agent with a pending request to the leftmost slot", async () => {
    const m = newManager();
    const a = "aaaa0000aaaa0000";
    const b = "bbbb0000bbbb0000";
    const c = "cccc0000cccc0000";
    m.add(payload(a));
    m.add(payload(b));
    m.add(payload(c));
    await pair(a);
    const { ws: wsB, agentKey: keyB } = await pair(b);
    await pair(c);

    // No request yet -> pure insertion order.
    expect(m.list().map((x) => x.id)).toEqual([a, b, c]);

    // A request on the MIDDLE agent b moves it to the front (leftmost); the rest
    // keep their relative insertion order behind it (stable sort).
    await sendReq(wsB, keyB, yesno("rb"));
    const list = m.list();
    expect(list[0]!.id).toBe(b);
    expect(list[0]!.hasRequest).toBe(true);
    expect(list.map((x) => x.id)).toEqual([b, a, c]);
    // Only b carries a request -> only b's chip shows the red request dot.
    expect(list.filter((x) => x.hasRequest).map((x) => x.id)).toEqual([b]);
  });

  it("pendingCount counts agents with an unanswered request (drives the app badge)", async () => {
    const m = newManager();
    const a = "aaaa1111aaaa1111";
    const b = "bbbb1111bbbb1111";
    m.add(payload(a));
    m.add(payload(b));
    const { ws: wsA, agentKey: keyA } = await pair(a);
    const { ws: wsB, agentKey: keyB } = await pair(b);

    // No requests -> nothing to badge.
    expect(m.pendingCount()).toBe(0);

    // The user's case: two agents each with one request -> the badge reads 2.
    await sendReq(wsA, keyA, yesno("ra"));
    expect(m.pendingCount()).toBe(1);
    await sendReq(wsB, keyB, yesno("rb"));
    expect(m.pendingCount()).toBe(2);

    // The pending answer still needs a receipt. Only acknowledgement clears it.
    m.setActive(a);
    m.approve();
    expect(m.pendingCount()).toBe(2);
    await acknowledge(wsA, keyA);
    expect(m.pendingCount()).toBe(1);
  });

  it("reconciles the native subscription on every fresh connection", async () => {
    const m = newManager();
    const room = "f00d0000f00d0000";
    m.add(payload(room));
    await pair(room);

    const sub = {
      endpoint: "https://push.example/x",
      keys: { p256dh: "p", auth: "au" },
    };
    expect(await deliver(m, room, sub)).toBe(true);
    const ws1 = FakeWS.byRoom.get(room)!;
    expect(
      ws1.sent.filter((f) => typeof f.box === "string").length,
    ).toBeGreaterThanOrEqual(1);

    // iOS resume: retryAll drops + reopens the socket. A sub written into the now
    // half-open socket while the agent was away was counted "sent"; on the fresh
    // connection it must be reconciled and delivered again.
    m.retryAll();
    const ws2 = FakeWS.byRoom.get(room)!;
    expect(ws2).not.toBe(ws1);
    expect(ws2.sent.filter((f) => typeof f.box === "string").length).toBe(0); // nothing yet (connecting)
    ws2.open();
    await until(() => ws2.sent.some((f) => typeof f.box === "string"));
    expect(
      ws2.sent.filter((f) => typeof f.box === "string").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("retains only retry intent while CONNECTING and reads the current sub after open", async () => {
    const m = newManager();
    const room = "ab12ab12ab12ab12";
    m.add(payload(room));
    const { agentKey } = await pair(room);

    // iOS kill -> restore race: retryAll dropped the socket and the replacement
    // is still CONNECTING when reconciliation starts and the App attempts delivery.
    m.retryAll();
    const ws2 = FakeWS.byRoom.get(room)!;
    const sub = {
      endpoint: "https://push.example/agent",
      keys: { p256dh: "p", auth: "au" },
    };
    expect(await deliver(m, room, sub)).toBe(false); // write into a connecting socket
    expect(ws2.sent.filter((f) => typeof f.box === "string")).toHaveLength(0);

    // Native state can change while connecting. Retry must obtain the new value.
    const current = { ...sub, endpoint: "https://push.example/current" };
    nativeSubscriptions.set(room, current);
    ws2.open();
    await until(() => ws2.sent.some((f) => typeof f.box === "string"));
    expect((await pushSubscriptions(ws2, agentKey)).at(-1)!.subscription).toEqual(current);
  });

  it("reconciles the room's own key on reconnect", async () => {
    const m = newManager();
    const room = "cd34cd34cd34cd34";
    m.add(payload(room));
    await pair(room);

    const sub = {
      endpoint: "https://push.example/agent",
      keys: { p256dh: "p", auth: "au" },
    };
    expect(await deliver(m, room, sub)).toBe(true); // delivered on the live socket

    // Reconnect (iOS resume). The prod build bakes an EMPTY build key (ADR 0016),
    // so each room's native subscription must be reconciled on reconnect.
    m.retryAll();
    const ws2 = FakeWS.byRoom.get(room)!;
    ws2.open();
    await until(() => ws2.sent.some((f) => typeof f.box === "string"));
    expect(
      ws2.sent.filter((f) => typeof f.box === "string").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("rejects fallback or another agent's key when the room has its own signed key", async () => {
    const m = newManager();
    const room = "ef56ef56ef56ef56";
    m.add(payload(room));
    const { ws, agentKey } = await pair(room);
    await sendVapid(ws, agentKey, "own-key");
    const sub = { endpoint: "https://push.example/agent", keys: { p256dh: "p", auth: "au" } };
    expect(await deliver(m, room, sub, "build-key")).toBe(false);
    expect(await pushSubscriptions(ws, agentKey)).toHaveLength(0);
    expect(await deliver(m, room, sub, "own-key")).toBe(true);
    m.retryAll();
    const reconnected = FakeWS.byRoom.get(room)!;
    reconnected.open();
    await until(() => reconnected.sent.some((f) => typeof f.box === "string"));
    expect((await pushSubscriptions(reconnected, agentKey)).at(-1)!.subscription).toEqual(sub);
  });

  it("stale tab reconnect signs native E2 after another tab has delivered E2, never cached E1", async () => {
    const persist = new FakePersist();
    const a = newManager(persist);
    const room = "feedfeedfeedfeed";
    a.add(payload(room));
    const { ws: first, agentKey } = await pair(room);
    const e1 = { endpoint: "https://push.example/e1", keys: { p256dh: "p", auth: "a" } };
    const e2 = { ...e1, endpoint: "https://push.example/e2" };
    expect(await deliver(a, room, e1)).toBe(true);
    const b = newManager(persist);
    expect(b.restoreAll()).toBe(1);
    await until(() => FakeWS.byRoom.get(room));
    const second = FakeWS.byRoom.get(room)!;
    second.open();
    expect(await deliver(b, room, e2)).toBe(true);
    const newer = (await pushSubscriptions(second, agentKey)).at(-1)!;
    a.retryAll();
    const reconnected = FakeWS.byRoom.get(room)!;
    reconnected.open();
    await until(() => reconnected.sent.some((f) => typeof f.box === "string"));
    const reconciled = (await pushSubscriptions(reconnected, agentKey)).at(-1)!;
    expect(reconciled.subscription).toEqual(e2);
    expect(reconciled.push_seq).toBeGreaterThan(newer.push_seq!);
    expect((await pushSubscriptions(first, agentKey))[0]!.subscription).toEqual(e1);
  });

  it("never sends cached data or reports ready after native reconciliation fails on reconnect", async () => {
    const m = newManager();
    const room = "deadfeeddeadfeed";
    m.add(payload(room));
    const { agentKey } = await pair(room);
    expect(await deliver(m, room, { endpoint: "https://push.example/old", keys: { p256dh: "p", auth: "a" } })).toBe(true);
    nativeSubscriptions.delete(room);
    m.retryAll();
    const reconnected = FakeWS.byRoom.get(room)!;
    reconnected.open();
    await until(() => m.pushStatus(room, "build-key") === "failed");
    expect(await pushSubscriptions(reconnected, agentKey)).toHaveLength(0);
  });

  it("does not sign a delayed superseded reconciliation or one whose room was forgotten", async () => {
    let finish!: () => Promise<boolean>;
    let slow = true;
    const e1 = { endpoint: "https://push.example/e1", keys: { p256dh: "p", auth: "a" } };
    const e2 = { ...e1, endpoint: "https://push.example/e2" };
    const m = newManager(undefined, async (_key, _room, use) => slow
      ? new Promise<boolean>((resolve) => { finish = async () => { const sent = await use(e1); resolve(sent); return sent; }; })
      : use(e2));
    const room = "decafdecafdecaff";
    m.add(payload(room));
    const { ws, agentKey } = await pair(room);
    const old = m.reconcilePushSubscription(room, "key");
    slow = false;
    expect(await m.reconcilePushSubscription(room, "key")).toBe(true);
    expect(await finish()).toBe(false);
    expect(await old).toBe(false);
    expect((await pushSubscriptions(ws, agentKey)).map((p) => p.subscription)).toEqual([e2]);
    expect(m.pushStatus(room, "key")).toBe("ready");
    slow = true;
    const removed = m.reconcilePushSubscription(room, "key");
    m.remove(room);
    expect(await finish()).toBe(false);
    expect(await removed).toBe(false);
    expect((await pushSubscriptions(ws, agentKey)).map((p) => p.subscription)).toEqual([e2]);
  });

  it("vapidKeys returns each agent VAPID key tagged with its room (restore re-subscribe)", async () => {
    const m = newManager();
    const a = "aa11aa11aa11aa11";
    const b = "bb22bb22bb22bb22";
    m.add(payload(a));
    m.add(payload(b));
    const { ws: wsA, agentKey: keyA } = await pair(a);
    const { ws: wsB, agentKey: keyB } = await pair(b);

    expect(m.vapidKeys()).toEqual([]); // no agent has sent a key yet

    // Each agent delivers its OWN sealed VAPID key.
    await sendVapid(wsA, keyA, "Akey");
    await sendVapid(wsB, keyB, "Bkey");

    // Both returned, tagged with their room in insertion order — the App uses this
    // after a page kill to re-subscribe each agent under ITS OWN key.
    expect(m.vapidKeys()).toEqual([
      { room: a, key: "Akey" },
      { room: b, key: "Bkey" },
    ]);
  });
});

describe("SessionManager persistence (ADR 0020)", () => {
  it("persists signed VAPID keys when pairing is followed by no request", async () => {
    const persist = new FakePersist();
    const m = newManager(persist);
    const rooms = ["aa00aa00aa00aa00", "bb00bb00bb00bb00"];
    for (const room of rooms) {
      m.add(payload(room));
      const { ws, agentKey } = await pair(room);
      await sendVapid(ws, agentKey, `key-${room}`);
    }
    expect(persist.stored.map(({ room, vapid }) => ({ room, vapid }))).toEqual(
      rooms.map((room) => ({ room, vapid: `key-${room}` })),
    );
    m.closeAll();
    const restored = newManager(persist);
    expect(restored.restoreAll()).toBe(2);
    await until(() =>
      restored
        .list()
        .every((a) => a.status === "offline" || a.status === "paired"),
    );
    expect(restored.vapidKeys()).toEqual(
      rooms.map((room) => ({ room, key: `key-${room}` })),
    );
  });

  it("persists a paired session and restores it: rejoin paired, requests deliverable", async () => {
    const persist = new FakePersist();
    const m1 = newManager(persist);
    const room = "abcd1234abcd1234";
    m1.add(payload(room));
    const { ws: ws1, agentKey, peer } = await pair(room);
    // The agent label arrives with a first request; it must be persisted too.
    await sendReq(ws1, agentKey, yesno("r0", "codex @ laptop"));
    m1.approve();
    await acknowledge(ws1, agentKey);

    const saved = persist.stored;
    expect(saved).toHaveLength(1);
    expect(saved[0]!.room).toBe(room);
    expect(saved[0]!.agent).toBe("codex @ laptop");
    expect(b64Decode(saved[0]!.key)).toHaveLength(32);
    expect(saved[0]!.seen).toContain("r0");
    expect(saved[0]!.protocol).toBe(PROTOCOL);
    expect(saved[0]!.agentSigner).toBe(peer.signer.spkiB64);
    expect(saved[0]!.deviceSigner).toBe((await deviceKeyLoader()).spkiB64);
    expect(saved[0]!.receipts?.r0?.status).toBe("accepted");
    expect(saved[0]!.request).toBeUndefined();

    // "iOS killed the page": a brand-new manager restores from storage.
    m1.closeAll();
    const m2 = newManager(persist);
    expect(m2.restoreAll()).toBe(1);
    await until(() => m2.activeState().paired && FakeWS.byRoom.has(room));
    const s = m2.activeState();
    expect(s.paired).toBe(true);
    expect(s.screen).toBe("listening");
    expect(s.agent).toBe("codex @ laptop");

    // The relay socket reopens; the agent re-announces a NEW request and the
    // restored key opens it -> the card renders without any re-pairing.
    const ws2 = FakeWS.byRoom.get(room)!;
    ws2.open();
    await sendReq(ws2, agentKey, yesno("r1", "codex @ laptop"));
    expect(m2.activeState().screen).toBe("yesno");

    // And the decision seals back under the SAME key the agent holds.
    m2.approve();
    const d = await acknowledge(ws2, agentKey);
    expect(d).toMatchObject({
      kind: "decision",
      protocol: PROTOCOL,
      room,
      id: "r1",
      result: { approved: true },
    });
    expect(m2.activeState().result?.label).toBe("Answer received by agent");
  });

  it("restores seen ids and sent decisions: an answered re-announce is re-sent, not reopened", async () => {
    const persist = new FakePersist();
    const m1 = newManager(persist);
    const room = "beef5678beef5678";
    m1.add(payload(room));
    const { ws: ws1, agentKey } = await pair(room);
    await sendReq(ws1, agentKey, yesno("r1"));
    m1.approve();
    await until(() => decisions(ws1, agentKey).length === 1);
    const original = decisions(ws1, agentKey)[0]!;
    expect(persist.stored[0]!.decisions?.r1).toEqual(original);
    expect(persist.stored[0]!.request?.id).toBe("r1");
    expect(persist.stored[0]!.receipts?.r1).toBeUndefined();

    // Reload. The agent never got the decision (half-open socket before the
    // kill) and re-announces r1: the restored session must re-send the
    // persisted decision instead of reopening the card or dropping the frame.
    m1.closeAll();
    const m2 = newManager(persist);
    m2.restoreAll();
    await until(() => m2.activeState().paired && FakeWS.byRoom.has(room));
    expect(m2.activeState().screen).toBe("pending");
    expect(m2.activeState().delivery).toBe("uncertain");
    const ws2 = FakeWS.byRoom.get(room)!;
    ws2.open();
    await sendReq(ws2, agentKey, yesno("r1"));
    expect(m2.activeState().screen).toBe("pending"); // not an editable card
    expect(m2.activeState().request?.id).toBe("r1");
    expect(decisions(ws2, agentKey).length).toBeGreaterThanOrEqual(1);
    for (const resent of decisions(ws2, agentKey))
      expect(resent).toEqual(original);
    await acknowledge(ws2, agentKey);
    expect(m2.activeState().request).toBeNull();
    expect(m2.activeState().result?.label).toBe("Answer received by agent");
  });

  it("a PENDING (unanswered) request re-opens after restore via the re-announce", async () => {
    const persist = new FakePersist();
    const m1 = newManager(persist);
    const room = "feed1111feed1111";
    m1.add(payload(room));
    const { ws: ws1, agentKey } = await pair(room);
    await sendReq(ws1, agentKey, yesno("r7"));
    expect(m1.activeState().screen).toBe("yesno"); // card open, NOT answered

    // Page kill mid-card. v2 persists the signed request as well as de-dupe
    // state, so restore must keep it answerable with its original metadata.
    expect(persist.stored[0]!.request).toEqual(m1.activeState().request);
    expect(persist.stored[0]!.request?.sig).toBeTruthy();
    const originalRequest = persist.stored[0]!.request;

    m1.closeAll();
    const m2 = newManager(persist);
    m2.restoreAll();
    await until(() => m2.activeState().paired && FakeWS.byRoom.has(room));
    expect(m2.activeState().request).toEqual(originalRequest);
    const ws2 = FakeWS.byRoom.get(room)!;
    ws2.open();
    await sendReq(ws2, agentKey, yesno("r7")); // the agent's re-announce
    expect(m2.activeState().screen).toBe("yesno"); // card re-opened
    m2.approve();
    const d = await acknowledge(ws2, agentKey);
    expect(d).toMatchObject({
      kind: "decision",
      protocol: PROTOCOL,
      room,
      id: "r7",
      result: { approved: true },
    });
  });

  it("remove wipes the persisted entry (forget this agent)", async () => {
    const persist = new FakePersist();
    const m = newManager(persist);
    const room = "cafe9999cafe9999";
    m.add(payload(room));
    await pair(room);
    expect(persist.stored).toHaveLength(1);
    m.remove(room);
    expect(persist.stored).toHaveLength(0);
  });

  it("a pre-pair session is never persisted (no key yet)", async () => {
    const persist = new FakePersist();
    const m = newManager(persist);
    m.add(payload("dddd0000dddd0000"));
    await until(() => FakeWS.byRoom.has("dddd0000dddd0000"));
    const ws = FakeWS.byRoom.get("dddd0000dddd0000")!;
    ws.open(); // connected but not paired
    expect(persist.stored).toHaveLength(0);
  });

  it("retains a legacy pairing with upgrade guidance and opens no socket", async () => {
    const legacy = {
      r: "wss://relay.example/ws",
      room: "1234abcd1234abcd",
      key: b64Encode(new Uint8Array(32).fill(7)),
      agent: "legacy laptop",
    };
    const persist = new FakePersist([legacy]);
    const m = newManager(persist);
    expect(m.restoreAll()).toBe(1);
    await settle();
    expect(m.activeState().paired).toBe(false);
    expect(m.activeState().screen).toBe("pair");
    expect(m.activeState().pairError).toMatch(/upgrade/i);
    expect(m.list()).toEqual([
      expect.objectContaining({ id: legacy.room, label: legacy.agent }),
    ]);
    expect(persist.stored).toEqual([legacy]);
    expect(FakeWS.byRoom.size).toBe(0);
    m.retryAll();
    await settle();
    expect(FakeWS.byRoom.size).toBe(0);
    m.remove(legacy.room);
    expect(persist.stored).toEqual([]);
  });
});
