# Awaiting-Answer Indicator — Design

**Date:** 2026-06-12
**Status:** Approved (design phase)
**Branch:** feature/live-build-stage

## Problem

The project sidebar (`FileViewerSidebar`) shows a spinning `LoaderCircle` on a
project row while that project has an in-flight chat turn (driven by
`generatingProjectIds`, derived from `turnOwners` in `CadWorkspace`). When a turn
**pauses for user input** — the model proposes a plan or asks preference
questions — the driver ends the turn (`turn_end` fires), `turnOwners` is pruned,
and the spinner stops. There is then **no indicator** that the project is blocked
waiting for the user. Across many projects, a user cannot tell which one needs
their answer.

## Goal

Add a distinct per-project visual indicator — an **amber pulsing dot** — on the
sidebar project row whenever that project's session is paused waiting for a user
answer. Covers both pause reasons:

1. **Plan approval** — `ExitPlanMode` → `PlanProposed` event → store sets
   `awaitingApproval` + `activePlanTurnId`.
2. **Preference questions** — `AskUserQuestion` / a model-authored
   `panda-questions` fence → arrives as a `TextDelta` containing a
   ```` ```panda-questions ```` fence, followed by `turn_end`. Not currently
   tracked as a flag — only rendered as a `QuestionCard`.

## Non-goals

- Surviving a full app reload. History hydration (`hydrate_session`) flattens
  block structure to plain text and can't recover the driver-synthesized
  `panda-questions` fence, so awaiting state is not reconstructed after a process
  restart. Backend persistence can be layered on later if needed.

  (Switching projects *within a session* and returning IS handled — see "Slice
  retention for paused projects" below. The original spec listed this as a
  non-goal; it was promoted to a fix after the QuestionCard was observed
  vanishing on return, which made the amber dot a dead end.)
- Any indicator outside the project row (no chat-header marker this iteration).
- IPC / contract changes. `docs/panda-interfaces.md` is frozen for v1; this is
  frontend-only.

## Approach (frontend-only, mirrors `generatingProjectIds`)

Add a top-level `awaitingAnswerProjectIds` map to the chat store, keyed by
`projectId` — like `turnOwners`, and crucially **not** tied to the retained
`sessions` slice, so it survives project switches within a session. (A project
that proposes a plan then is navigated away from would otherwise lose its
retained slice, because the retain condition is "turn in flight"; this map is
independent of that.)

### State shape

In `INITIAL_CHAT_STATE`:

```js
// Project IDs whose session is paused waiting for a user answer (a proposed
// plan awaiting approval, or unanswered preference questions). Keyed by
// projectId and kept at the top level (like turnOwners) so it survives project
// switches. Drives the sidebar "needs your answer" dot. Set when a turn ends in
// a paused state; cleared when the user responds.
awaitingAnswerProjectIds: {},
```

A plain object used as a set (`{ [projectId]: true }`) for value-stable updates,
consistent with `turnOwners`.

### Reducer transitions (`chatReducer` / `applyChatEventToSession` caller)

The map is owned by the top-level `chat_event` handler in `chatReducer` (which
already knows `ownerProject` for the event), not by `applyChatEventToSession`
(which is per-slice and has no project identity). This keeps the existing
slice-vs-top-level split intact.

**Set** `awaitingAnswerProjectIds[ownerProject] = true` when, for a resolved
`ownerProject`:

- `event.kind === "plan_proposed"`, OR
- `event.kind === "turn_end"` AND the turn's assistant blocks contain a
  ```` ```panda-questions ```` fence. Detection helper:
  `turnHasPendingQuestions(turn)` scans the turn's `text` blocks for the literal
  substring `` ```panda-questions ``. (Both the `AskUserQuestion`→fence path and
  a model-authored fence land as text, so one substring check covers both.)

**Clear** the entry (`delete awaitingAnswerProjectIds[projectId]`) when the user
responds for that project:

- `queue_user_message` (user sent a message / answered questions / requested plan
  changes) — clear `state.currentProjectId`.
- `turn_start` for the project (a fresh turn began) — clear `ownerProject`.
- `error` / `auth_expired` for the project — clear `ownerProject` (the pause is
  over; the turn failed).
- `mark_plan` with a non-`proposed` status (plan approved/superseded) — clear the
  turn's project. `mark_plan` carries `turnId`; resolve its project via
  `turnOwners` is not reliable (the turn already ended). Instead clear
  `state.currentProjectId` (plan actions only ever apply to the active project —
  see `approvePlan`/`requestPlanChanges`, which gate on `state.currentProjectId`).
- `reset` — cleared via `INITIAL_CHAT_STATE`.

Ordering note: a `turn_start` both clears (user responded) and is followed later
by a possible new pause; clearing on `turn_start` is correct because any new
pause arrives as a later `plan_proposed` / `turn_end`.

### Selector

```js
export function selectAwaitingAnswerProjectIds(state) {
  return state?.awaitingAnswerProjectIds || EMPTY;
}
```

### Wiring (`CadWorkspace` → `FileViewerSidebar` → `ProjectNode`)

`CadWorkspace` derives a `Set` (memoized on the map) exactly like
`generatingProjectIds`:

```js
const awaitingAnswerMap = useChatStore((s) => s.awaitingAnswerProjectIds);
const awaitingAnswerProjectIds = useMemo(
  () => new Set(Object.keys(awaitingAnswerMap || {})),
  [awaitingAnswerMap],
);
```

Passed as a new prop `awaitingAnswerProjectIds` through `FileViewerSidebar` →
`FileViewerContents` → `ProjectNode` (alongside the existing
`generatingProjectIds`). `ProjectNode` gets a derived
`isAwaitingAnswer={Boolean(awaitingAnswerProjectIds?.has(node.id))}`.

### Render (`ProjectNode`)

The row's trailing slot currently renders `{isGenerating ? <LoaderCircle…/> :
null}`. The two states are mutually exclusive (generating = turn in flight;
awaiting = turn ended). Render precedence: spinner first, then the dot.

```jsx
{isGenerating ? (
  <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground"
    aria-label="Generating" title="Working…" />
) : isAwaitingAnswer ? (
  <span
    className="size-2 shrink-0 rounded-full bg-amber-500 animate-pulse"
    role="status"
    aria-label="Waiting for your answer"
    title="Waiting for your answer"
  />
) : null}
```

Amber (`bg-amber-500`) is visually distinct from the gray spinner. `animate-pulse`
gives the gentle attention-draw. `role="status"` + `aria-label` for screen
readers.

### Slice retention for paused projects

The dot must not be a dead end: returning to a paused project has to show the
QuestionCard / plan card so the user can actually answer. But a paused turn has
**ended** (`turn_end` fired when the question/plan was emitted), so the existing
`set_project` retain check (`turnInProgress || projectHasInFlightTurn`) drops the
project's rich session slice on switch-away. On return it re-hydrates from the
persisted transcript, which flattens blocks to plain text and — critically —
never contained the driver-synthesized `panda-questions` fence (that lives only
in the live event stream). The QuestionCard then has nothing to render from and
disappears.

Fix: add `awaitingAnswerProjectIds[currentProjectId]` to the `set_project` retain
condition so a paused project keeps its live slice. `setProject`'s existing
`hadRetained` guard then skips the hydrate fetch, and the reducer restores the
slice intact (history with the fence, `awaitingApproval`, `activePlanTurnId`).
Frontend-only; fixes both the QuestionCard and the plan card. (A full process
restart still loses it — see Non-goals.)

## Data flow

```text
plan_proposed / turn_end(+questions fence)   chat_event reducer
        │                                            │
        ▼                                            ▼
  awaitingAnswerProjectIds[projectId] = true   (top-level map)
        │
        ▼ useChatStore selector
  CadWorkspace → Set
        │ prop
        ▼
  FileViewerSidebar → ProjectNode → amber pulsing dot
        ▲
  cleared on: queue_user_message / turn_start / error / mark_plan(non-proposed)
```

## Testing

Pure-reducer tests in `viewer/src/client/components/chat/__tests__/` (the
reducer is exported and exercised without React — see existing
`chatReducer.test.js`, `planFlow.test.js`):

1. `plan_proposed` for a project sets `awaitingAnswerProjectIds[project]`.
2. `turn_end` whose assistant turn contains a `panda-questions` fence sets it.
3. `turn_end` with no questions fence and no prior plan does **not** set it.
4. `queue_user_message` for the project clears it.
5. `mark_plan` approved/superseded clears it.
6. `error` for the project clears it.
7. State survives a `set_project` switch (map is top-level, not in the dropped
   session slice) — set for project A, switch to B, switch back to A: still set.
8. A backgrounded project's `plan_proposed` (event whose `ownerProject` !=
   `currentProjectId`) still sets the map for that project.

Component-level: existing sidebar tests (if any) — assert the dot renders for an
awaiting project and not for an idle/generating one.

Run: `npm --prefix viewer test`.

## Files touched

- `viewer/src/client/store/chat.js` — state field, reducer transitions,
  `turnHasPendingQuestions` helper, `selectAwaitingAnswerProjectIds` selector.
- `viewer/src/client/components/CadWorkspace.js` — derive the Set, pass the prop.
- `viewer/src/client/components/workbench/FileViewerSidebar.js` — thread the prop
  through `FileViewerContents` → `ProjectNode`; render the dot.
- `viewer/src/client/components/chat/__tests__/` — reducer tests.
