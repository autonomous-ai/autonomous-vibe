# Block auth-mode switching while any turn is processing

**Date:** 2026-06-11
**Status:** Approved design, pending implementation plan

## Problem

The `AuthModeControl` badge in the chat header lets the user switch Claude
access between the Panda hosted proxy and their own local Claude Code
(`app_set_auth_mode`). Today this switch is reachable and actionable even while
a chat turn is processing. Auth mode is a global setting that determines how the
`claude` subprocess is spawned, so flipping it mid-turn is confusing and can put
the next turn into an unexpected mode. The switch should be visible but not
actionable while any session is processing.

## Scope decisions (confirmed)

- **Block UX:** The badge still opens the chooser dialog so the user can *see*
  their current mode, but the Panda/local switch options are **disabled** with a
  short note while a turn runs. (Not: disabling/hiding the whole badge.)
- **Block scope:** Block if **any** session is processing — the active project
  *or* any backgrounded project with a turn in flight. Auth mode is global, so
  any running turn could be affected.
- **Enforcement:** **UI only.** No change to the Rust `app_set_auth_mode`
  command. The block lives entirely in the React layer.

## Design

### 1. New selector — `store/chat.js`

Add a pure, exported selector alongside the existing `select*` functions:

```js
export function selectAnyTurnInProgress(state) {
  return state.turnInProgress
    || Object.values(state.sessions).some((s) => s.turnInProgress === true);
}
```

- `state.turnInProgress` covers the **active** project (top-level slice).
- `state.sessions[*].turnInProgress` covers every **backgrounded** project; the
  session slice already records `turnInProgress` (see `sessionSlice`), so no
  store-shape change is needed.
- Pure function → unit-testable without React, consistent with the other
  selectors.

### 2. Consume it in `AuthModeControl.jsx`

- Read the flag via the store hook:
  `const turnBusy = useChatStore(selectAnyTurnInProgress);`
- The badge and dialog open exactly as today (discoverability unchanged).
- While `turnBusy` is true, inside the dialog:
  - The Panda option button (`auth-mode-panda`) is `disabled`.
  - The local option button (`auth-mode-local`) is `disabled`.
  - The "Sign out of Panda" button (`auth-mode-panda-logout`) is `disabled`
    (signing out also flips auth state mid-turn).
  - A short note renders: **"Finish the current chat before switching."** —
    shown only while `turnBusy`.
  - Disabling combines with the existing `busy` state:
    `disabled={busy || turnBusy}`.
- Harden the action handlers so a keyboard/race bypass of the disabled buttons
  still can't fire the switch: add `|| turnBusy` to the early-return guards in
  `switchTo` and `signOutPanda`. Still UI-only — no Rust change.

### 3. Tests (`viewer` test runner)

- Unit tests for `selectAnyTurnInProgress`:
  - `false` when idle (no active turn, no background sessions running).
  - `true` when the active project's `turnInProgress` is set.
  - `true` when only a backgrounded session has `turnInProgress` set.
- A component/interaction test for `AuthModeControl`:
  - With a turn in progress, the Panda/local/sign-out buttons are `disabled`
    and the "Finish the current chat before switching." note is present.
  - When idle, the buttons are enabled and the note is absent.

## Non-goals

- No change to `app_set_auth_mode` or any Rust/IPC code.
- No change to the badge's visibility or its click-to-open behaviour.
- No change to the panda sign-in / logout flows beyond gating their trigger
  buttons while a turn runs.

## Files touched

- `viewer/src/client/store/chat.js` — add `selectAnyTurnInProgress`.
- `viewer/src/client/components/chat/AuthModeControl.jsx` — consume selector,
  disable options + add note + guard handlers.
- Test files under `viewer/src/client/...` for the selector and the control.
