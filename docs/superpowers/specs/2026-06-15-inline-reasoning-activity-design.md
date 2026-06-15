# Inline reasoning + collapsible activity — design

**Date:** 2026-06-15
**Area:** `viewer/` chat surface (the sidebar chat thread)
**Status:** Approved design, ready for implementation plan

## Problem

An assistant turn's reasoning and tool activity are hidden behind a collapsed
pill in the turn header; clicking it opens a **modal `Dialog`** ("Thinking
trace"). This pulls the user out of the thread to see what the model did, and
nothing about the work is visible in the conversation itself.

We want the reasoning and the activity to live **inline in the chat thread**,
with the final answer always visible and the tool calls collapsed so the user
can choose to expand them per turn.

## Goals

1. Remove the modal entirely. Reasoning and activity render inside the thread.
2. The model's reasoning is visible inline (dimmed), not hidden.
3. Tool calls collapse into a single per-turn "Activity" disclosure the user
   can expand.
4. The final answer stays always-visible and reads as the primary content.
5. Long reasoning does not dominate the thread.

## Non-goals

- No change to the chat event protocol, the Rust driver, or the store's event
  reducer. This is a presentation-layer change plus one pure partition helper.
- No change to the plan → approve → build flow, the `panda-questions` /
  `QuestionCard` rendering, artifact badges, or the copy button.
- No change to `thinkingDurationMs` (the duration selector is reused as-is).

## Decisions (from brainstorming)

- **Grouping:** reasoning visible inline; tool calls collapsed into one
  "Activity (N steps)" disclosure per turn.
- **Default state:** the Activity disclosure auto-expands while the turn is
  live (so progress is watchable) and auto-collapses to a one-line summary once
  the turn finishes.
- **Long reasoning:** capped to ~6 lines with a fade + "show more / show less"
  toggle once the turn is done; shown in full while streaming.
- **Header pill:** removed. The phase badge keeps its live pulse; the duration
  moves onto the Activity disclosure header. No modal anywhere.
- **Narration** (plain text emitted *between* tool calls) groups with the
  visible reasoning block, rendered normal-weight (reasoning stays dim italic).

## Architecture

Three layers, smallest blast radius:

### 1. Data — three-way block partition (`store/chat.js`)

Replace `partitionTurnBlocks(blocks) -> { trace, body }` with a three-way split.
The existing "last activity index" rule (any `text` before the last
`thinking`/`tool_use` is narration; the trailing `text` is the real answer) is
preserved exactly — we only bucket the pre-answer trace into two lists instead
of one.

```
splitTurnBlocks(blocks) -> { reasoning, activity, body }
  reasoning: thinking blocks + pre-answer narration text   (visible, dimmed)
  activity:  tool_use blocks                                 (collapsed group)
  body:      trailing answer text + plan + artifact + error  (visible, unchanged)
```

`body` is byte-for-byte what `partitionTurnBlocks(...).body` returns today, so
`ChatTurn`'s existing body switch is untouched. `thinkingDurationMs` is
unchanged.

### 2. Components (`components/chat/`)

- **`TurnReasoning.jsx`** (new) — renders the `reasoning` list as markdown.
  - `thinking` blocks: dim italic. Narration `text`: dim, normal weight.
  - **Live** (`turn.status === "running"`): full, no cap (you watch it stream).
  - **Done:** capped to ~6 lines (`max-h` + fade overlay) with a
    "show more / show less" toggle. Toggle state is local component state.
  - When the turn has reasoning but **no tools**, this block carries the small
    "Thinking… / Thought for Ns" caption so the duration signal is never lost.

- **`TurnActivity.jsx`** (new) — the collapsible Activity disclosure. The tool
  **row** (verb · target · status glyph) is lifted out of the current
  `ThinkingSummary` `TraceItem` into a small `ActivityRow` used here.
  - **Live:** auto-expanded; header reads `Working… · <current step>` (e.g.
    "Rendering preview…") with the running spinner. Absorbs the old inline
    `runningTool` "…" line in `ChatTurn`, which is deleted.
  - **Done:** auto-collapsed; header reads `Worked for <duration> · N steps`
    with an aggregate status glyph (✓ all ok).
  - **Error:** if any tool ended `error`, the disclosure defaults **expanded**
    even when done, and the header glyph is red — failures never hide.
  - Open/closed is local state seeded from the live/error rule; the user can
    toggle it freely.

- **`ChatTurn.jsx`** — header drops `<ThinkingSummary>` (the phase badge keeps
  its live pulse). The body renders, in order:
  `TurnReasoning` → `TurnActivity` → existing body blocks. The `thinking` /
  `tool_use` cases in the body switch (currently returning `null`) are removed
  because those blocks no longer reach the body list.

- **Delete** `ThinkingSummary.jsx` and the unused `ToolUseBlock.jsx`. The
  `Dialog`/`Sparkles` imports go with them.

### 3. Tests

- Rename `__tests__/thinkingSummary.test.js` → `turnTrace.test.js`.
  - Keep all `thinkingDurationMs` cases verbatim.
  - Convert `partitionTurnBlocks` cases to `splitTurnBlocks`, asserting the
    three buckets (reasoning / activity / body) and the narration-vs-answer
    boundary.
  - Add: reasoning-only turn surfaces the duration caption; a turn with an
    errored tool reports the error-expanded condition (assert via the pure
    helper the component uses, e.g. an exported `activityDefaultsOpen(turn)` /
    status-aggregator, so the rule is unit-testable without a DOM).
- `npm --prefix viewer test` and `npm --prefix viewer run build` must pass.

## Behavior matrix (edge cases)

| Turn contents | Reasoning block | Activity disclosure | Body |
| --- | --- | --- | --- |
| Pure text answer | — | — | answer |
| Reasoning → answer | visible (+ "Thought for Ns") | — | answer |
| Tools → answer | — | collapsed, "Worked for Ns · N steps" | answer |
| Reasoning + tools → answer | visible | collapsed | answer |
| Just started (no blocks yet) | — | live "Working…" header | — |
| Tool errored | visible if any | **expanded**, red glyph | answer/error |
| Cancelled turn | as-is | rows show ban glyph | answer (maybe empty) |
| Hydrated history (flat text) | — | — | answer (no chrome) |
| Plan phase | reasoning + narration | collapsed (Read/ExitPlanMode) | PlanBlock / QuestionCard |

## Risks / footguns

- **Hydrated turns are flat.** Reloaded history is `{kind:"text"}` only, so old
  turns correctly render with no reasoning/activity chrome — verified against
  the `hydrate_session` reducer path. No migration needed.
- **Duration placement.** Exactly one component owns the duration per turn
  (Activity header when tools exist, else the reasoning caption) to avoid a
  double "Worked for / Thought for" readout.
- **No new event plumbing.** All inputs already exist on the turn
  (`blocks`, `status`, `startedAt`, `lastActivityAt`, …); nothing in the Rust
  IPC or the chat reducer changes.

## Verification

`npm --prefix viewer test` + `npm --prefix viewer run build`, results reported.
(No full-app run required for this change.)
