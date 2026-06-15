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

- **Grouping (interleaved segments):** a turn reads as an ordered sequence of
  reasoning→tools *segments* — each a visible reasoning block followed by its
  own collapsible "Activity" group (the tools that ran after it). Reasoning that
  appears *after* a tool group starts a new segment. This preserves the real
  narrative ("check the workspace" → 2 reads · "write the parts" → 17 writes)
  instead of hoisting all reasoning to the top and lumping every tool into one
  blob. (Superseded the earlier single-Activity-group decision after it proved
  to flatten a 19-step turn into one opaque group.)
- **Default state:** each segment's Activity group auto-collapses once finished
  (unless a tool errored → stays open); the live/active group (the last one
  while the turn runs) stays expanded so progress is watchable.
- **Elapsed time (per segment):** each group shows **its own** segment
  duration, derived from per-block timestamps (`at` on every block, `endedAt` on
  tools): start = first block's `at`, end = last tool's `endedAt`. Only the
  **live** group ticks to `now` (the heartbeat that proves a long step isn't
  stuck) and reads "Working… 41s · «step»"; finished groups read
  "Worked for 9s · N steps" with their own static span. Before any block
  streams, a bare "Thinking… Ns" (whole-turn) stands in. (Superseded the earlier
  "total on every group" choice — repeating the same turn-total on 9 groups read
  like a session counter.)
- **No file badges:** generated files are **not** shown as chat artifact badges
  — the cadcode source (`.py`), metadata (`.json`), and even the model itself
  are noise inline; the result lives in the 3D viewer / Models rail. Artifact
  blocks stay in state (slice-target selection still reads them); they just
  don't render in the thread.
- **Long reasoning:** capped to ~6 lines with a fade + "show more / show less"
  toggle once the turn is done; shown in full while streaming.
- **Header pill / modal:** removed. The phase badge keeps its live pulse. No
  modal anywhere.
- **Narration** (plain text emitted *between* tool calls) groups with the
  visible reasoning block, rendered normal-weight (reasoning stays dim italic).

## Architecture

Three layers, smallest blast radius:

### 1. Data — chronological segmentation (`store/chat.js`)

Replace `partitionTurnBlocks(blocks) -> { trace, body }` with a segmenter. The
"last activity index" rule (any `text` before the last `thinking`/`tool_use` is
narration; the trailing `text` is the real answer) is preserved; the new work is
walking the pre-answer trace in order and cutting a new segment whenever
reasoning follows a tool group.

```text
segmentTurnBlocks(blocks) -> { segments, body }
  segments: ordered [{ reasoning, activity }]
              reasoning: thinking + pre-answer narration  (visible, dimmed)
              activity:  the tool_use blocks that ran after that reasoning
  body:      trailing answer text + plan + artifact + error  (visible, unchanged)
```

Segmenting rule: a `tool_use` appends to the current segment's `activity`;
reasoning appends to `reasoning`, but reasoning arriving *after* the current
segment already has tools flushes that segment and starts a fresh one
(consecutive reasoning accumulates). `body` is byte-for-byte the old
`.body`, so `ChatTurn`'s body switch is untouched. `thinkingDurationMs` is
unchanged.

### 2. Components (`components/chat/`)

- **`TurnReasoning.jsx`** (new) — renders the `reasoning` list as markdown.
  - `thinking` blocks: dim italic. Narration `text`: dim, normal weight.
  - **Live** (`turn.status === "running"`): full, no cap (you watch it stream).
  - **Done:** capped to ~6 lines (`max-h` + fade overlay) with a
    "show more / show less" toggle. Toggle state is local component state.
  - When the turn has reasoning but **no tools**, this block carries the small
    "Thinking… / Thought for Ns" caption so the duration signal is never lost.

- **`TurnActivity.jsx`** (new) — one collapsible Activity group **per segment**.
  Takes `{ turn, activity, active }`. The tool **row** (verb · target · status
  glyph) is an `ActivityRow` lifted from the old `ThinkingSummary` `TraceItem`.
  - **Active group** (last segment while the turn runs): auto-expanded; header
    reads `Working… <ticking total> · «current step»` with the running spinner.
  - **Finished group:** auto-collapsed; header reads
    `Worked for <total> · N steps` with the aggregate status glyph.
  - **Error:** a finished group whose tools include an `error` defaults
    **expanded**, glyph red — failures never hide.
  - Open/closed is local state seeded from `activityDefaultsOpen(activity,
    active)`; the user can toggle it freely.

- **`liveDuration.js`** (new) — `useLiveDuration(turn)` (formats
  `thinkingDurationMs`, re-renders every 1s while the turn runs) + a
  `<LiveDuration turn />` leaf so only the duration text re-renders per tick,
  not the whole group.

- **`ChatTurn.jsx`** — header drops `<ThinkingSummary>` (phase badge keeps its
  pulse). For an assistant turn it maps `segments` to
  `<TurnReasoning> + <TurnActivity active={isLast && running}>` pairs, then the
  body blocks. A `showStartupHeartbeat` renders a bare `Thinking… Ns` when the
  turn is running but no segment has formed yet, so it never looks stuck.

- **Delete** `ThinkingSummary.jsx` and the unused `ToolUseBlock.jsx`.

### 3. Tests

- `__tests__/turnTrace.test.js` (renamed from `thinkingSummary.test.js`):
  - Keep all `thinkingDurationMs` cases verbatim.
  - `segmentTurnBlocks` cases: interleaved reasoning→tools cuts two segments;
    consecutive reasoning accumulates; reasoning-only and tools-only segments;
    plan/artifact/error stay in body; non-array tolerated.
- `__tests__/activityLabels.test.js`: `formatDuration`, `aggregateActivityStatus`
  (running > error > cancelled > ok), and `activityDefaultsOpen(activity,
  active)` (active or any error → open).
- `__tests__/chatReducer.test.js`: a nameless orphan `tool_use_end` is dropped
  (no phantom row).
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
| Reloaded history | reconstructed | reconstructed (per-segment timers) | answer |
| Plan phase | reasoning + narration | collapsed (Read/ExitPlanMode) | PlanBlock / QuestionCard |

## Reload persistence

Reloaded turns are rebuilt from Claude Code's saved transcript. `parse_session_history`
(Rust) now **groups** all assistant messages + tool-result turns between two user
prompts into one assistant entry and emits structured `blocks` (thinking / text /
tool_use, with `tool_result`-resolved status + summary + start/end timings); the
intercepted `ExitPlanMode` / `AskUserQuestion` tool calls are dropped (not chips
live either). `ChatSessionState.history[].blocks` is additive/optional on the IPC
(mirrored in `transport.ts` + `panda-interfaces.md`). The `hydrate_session`
reducer builds turns from those blocks (deriving `startedAt`/`endedAt` from block
timings), so `segmentTurnBlocks` / `segmentDurationMs` render a reloaded turn
identically to the live one. Turns predating this change (no `blocks`) fall back
to a single text block.

## Risks / footguns

- **Duration placement.** A finished segment's group owns its own duration; only
  the live segment ticks — no double readout, no repeated turn-total.
- **Reload fidelity.** Per-segment timers on reload use transcript timestamps
  (assistant message time → tool_result time); they approximate the live wall
  clock but are stable and per-segment, not a repeated turn-total.

## Verification

`npm --prefix viewer test` + `npm --prefix viewer run build`, results reported.
(No full-app run required for this change.)
