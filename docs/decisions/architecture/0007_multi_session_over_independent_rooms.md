# 0007 — Multi-agent: N live Sessions over independent relay rooms

**Status:** accepted · 2026-06-21

## Context
A user runs several agents at once (one Cursor, one codex, one claude MCP server). Today the
PWA holds exactly one `Session` (`App.tsx` `sessionRef`), so a new pairing replaces the live
one. We want the phone to hold MULTIPLE agent connections SIMULTANEOUSLY and switch among them
effortlessly.

## Key fact (confirmed in `backend/internal/relay/relay.go`)
The relay needs ZERO change. Rooms are independent, keyed only by the `?room=<id>` query param
(`Handler`/`join`/`leave`), hold at most two peers, and are content-blind RAM-only. Each agent
process mints its OWN room id (`newRoomID`) and is peer-1; the phone joins that room as peer-2
over its OWN WebSocket. N agents ⇒ N rooms ⇒ N independent `WebSocket` connections from the one
phone. The relay never correlates rooms, so it cannot tell one phone holds many — and does not
need to. Each room still enforces "exactly two peers" (`len(rm.peers) >= 2` ⇒ `StatusRoomFull`).

## Decision
- Introduce a **`SessionManager`** (`frontend/src/lib/manager.ts`) owning a
  `Map<roomID, Session>` of all live agents. It is the single owner of session lifecycle and the
  aggregate state the React island renders.
  - `add(payload): roomID` — constructs a `Session`, subscribes to its `onChange`, `start()`s it,
    stores it under `payload.room`; first add becomes active. Idempotent on a duplicate room id
    (returns the existing id, no second socket).
  - `remove(roomID)` — `close()`s the Session and drops it; re-picks `active` if it was active.
  - `list(): AgentSummary[]` — `{ id, label, status, unread, hasRequest }` per agent, stable order
    (insertion order). `label = Request.agent` (the `--name` flag) else a short room id
    (`roomID.slice(0,4)`). `status` derives from each `SessionState`:
    `paired && conn==='open'` ⇒ `paired`; `paired && conn!=='open'` ⇒ `offline`;
    `conn==='connecting'||'open'` pre-pair ⇒ `connecting`; else `waiting`.
  - `setActive(roomID)` / `getActive()` — which agent is foregrounded; clears that agent's `unread`.
  - `activeState(): SessionState` — the foreground Session's snapshot (drives `renderScreen`).
  - `onChange(cb)` — fires whenever any Session changes or the roster/active changes; cb receives
    the manager. The App re-renders off this single subscription.
  - Decision/transport passthrough to the ACTIVE session: `approve/decline/choose/reply/retry`,
    plus `sendPushSubscription` fan-out to every paired session.
- **Unread / auto-foreground rule:** an incoming request on ANY session sets that agent's `unread`.
  If no card is currently open on the active agent (active screen ∉ {yesno,choice,text}), the
  manager auto-foregrounds the agent that just got the request. If a card IS open, the new request
  only bumps the badge — never steals a card mid-decision. This logic lives in the manager
  (per-session `unread` counter + a guarded `setActive`), NOT in `Session` (Sessions stay
  single-room and unaware of siblings — minimum divergence).

## Scope / ladder (v1 = RAM-only)
v1 holds N live Sessions for the page lifetime. That already delivers "multiple at once + switch
effortlessly." No router, no global-store dep, no backend change — a `Map` + one `onChange` is the
first rung that holds.

## Upgrade path (NOT built in v1) — reload persistence
A page reload drops all sockets and keys (Sessions are RAM-only, matching [[0005]]). Re-pairing is
manual today. Two ways to survive reload, both rejected for v1:
1. Persist each `sessionKey` + room in `localStorage` — WEAKENS E2E (key at rest on the device);
   would need at-rest encryption tied to a device secret. Off-limits without that guard.
2. Backend agent **re-pair-on-rejoin**: the agent re-announces its room and the phone re-runs
   SPAKE2 on reload. Keeps keys ephemeral but needs an agent-side change (out of scope here).
When reload-persistence is needed, take path 2 (no key at rest) and add an ADR. Until then a
reload re-pairs, identical to single-session today.

## Consequences
- Relay, crypto, pairing, wire, and `Session` are untouched — multi-agent is purely a
  client-side composition over the existing one-room primitive.
- Each agent keeps its own independent reconnect/backoff and `seenIDs` de-dupe; one agent going
  offline never disturbs another (separate `RelayClient`s).
- N sockets fan out from one phone; bounded by how many agents a human runs (single digits) — no
  pooling needed.
