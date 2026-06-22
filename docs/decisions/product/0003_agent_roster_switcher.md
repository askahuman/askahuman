# 0003 — Agent roster / switcher + add-agent flow

**Status:** accepted · 2026-06-21

## Context
With multi-agent ([[0007]]), the phone holds several paired agents at once. The human needs to
(a) see all connected agents and their status at a glance, (b) switch which one is foregrounded,
and (c) add MORE agents without dropping the live ones.

## Decision
- **Roster strip:** a compact, always-available row of connected agents rendered above the active
  screen (a thin drawer/strip, not a separate route). Each chip shows:
  - a **status dot** — green `paired`, amber `connecting`/`waiting`, red `offline`;
  - a **request dot** — a SEPARATE red dot that gently pulses (its glow brightens then dims,
    like a phone notification) whenever the agent has a live request (`hasRequest`). It is distinct
    from the status dot, so red-offline is never ambiguous;
  - the **label** (`Request.agent` / the `--name` flag, else short room id);
  - an **unread badge** (count) when that agent has an unanswered request it isn't foregrounding.
  Tapping a chip `setActive`s it, foregrounding that agent's screen and clearing its unread.
- **Requests sort left:** agents with a live request are ordered to the **leftmost** of the strip
  (requests-first, then insertion order — a stable sort), so whatever needs the human sits at the
  start of the row next to its pulsing red dot. Resolving the request returns the chip to its slot.
- **Add-agent action:** a "+" chip at the end of the strip opens `PairScreen` (type the agent's code)
  to ADD a session via `manager.add(payload)` — it never replaces a live one. After a successful
  add the new agent becomes active.
- **Auto-foreground:** a request arriving on a NON-active agent bumps its badge; if the user isn't
  mid-card on the active agent, the phone auto-switches to the agent that just asked (so a single
  agent still "just works"). A card already open is never interrupted — the badge waits.
- **Single-agent unchanged:** with exactly one agent the strip is minimal/collapsible; the screen
  flow is identical to today. Multi-agent UI is additive, not a redesign of the nine screens.

## Scope / ladder
v1 is the strip + add + tap-to-switch over RAM-only sessions. No per-agent settings page, no
drag-reorder, no rename — insertion order + the agent-supplied label suffice. Reload re-pairs
(see [[0007]] upgrade path); the roster is rebuilt as agents are re-added.
Requests auto-sort to the front (priority ordering); this is not user drag-reorder — chips still have no manual order.

## Consequences
- "Multiple at once + switch effortlessly" is met with one new presentational component over the
  manager's `list()` — no new screen states, no router.
- Status semantics reuse the existing per-session `conn`/`paired` truth, so the dot can't drift
  from reality.
- Skipped for now: reorder, rename, mute-per-agent, a full agents screen. Add when a user runs
  enough agents that the strip overflows.
