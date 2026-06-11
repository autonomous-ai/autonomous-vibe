# Model version control

**Status:** implemented (2026-06) as manual, git-tag-style "saved states." See
`desktop/src-tauri/src/commands/snapshot.rs`, the `snapshot_*` IPC commands in
`docs/panda-interfaces.md` §2, and the `SavedStates` control inline on the active
project's sidebar header.

Originally shipped as option 1 below (model-only snapshot + a linear "↩ Reverted
to …" marker). Since extended to **rewind the chat too**: a save now captures the
Claude session transcript alongside the model, and restore overwrites the live
session JSONL with it, so the conversation rewinds to the snapshot point and the
next turn resumes from there. This reuses the deterministic per-project session
id (it does **not** fork to a new id — that was option 2, still rejected). It is
not the pure option 1 anymore: the chat panel *does* reload on revert. The
trade-off accepted: messages after the snapshot are dropped from the live session
(saving a state before reverting preserves them). Saves predating this capture
restore with the old linear behavior. The notes below are retained as the design
rationale and a record of what was tried before.

**Earlier status:** deferred / removed (2026-06). A first implementation
(per-build checkpoints + a "Start from here" restore that forked the Claude
session) was built and then removed because it added more complexity than it was
worth at this stage and didn't sit cleanly on top of Claude Code sessions. The
auto-reload fix that shipped alongside it (versioned `?v=` mesh asset URLs, see
`docs/panda-interfaces.md` §2) is unrelated and was kept.

## The goal

Let a user try several CAD approaches and pick one to move forward — i.e. go
back to an earlier model and continue from there, without losing the path they
abandoned. A 3D-designer-familiar "version history."

## Why it was hard: sessions don't branch

Each Panda project drives **one append-only Claude Code session**
(`session_id_for_project`, deterministic per project). "Versions" of the *model*
are easy (snapshot the files). The hard part is the *conversation*: restoring an
old model while the chat keeps streaming the newer history is incoherent, but
rewriting/branching the chat on restore surprises the user — and the chat is the
app's primary, most-trusted surface ("keep it clear, don't mess with it").

The removed implementation forked the session on restore: each checkpoint
snapshotted its session JSONL, and restoring copied that snapshot to a new
session id (validated: copying a session JSONL to a new id and `--resume`ing it
preserves context — see the `claude-session-fork-via-jsonl-copy` finding). It
worked, but the restore visibly *rewrote the chat panel* (older conversation
reloaded, later messages hidden in another branch), which is the confusion we
were trying to remove.

## Design options for when we revisit

1. **Linear "undo marker" (IMPLEMENTED).** Versions snapshot only the model.
   Restore reverts the files and appends one clear line to the *same* ongoing
   conversation ("↩ Reverted to version N"); nothing is reloaded or hidden, and
   the session stays linear and append-only. All model versions remain
   restorable. Drops the session-forking machinery entirely. Trade-off: no
   separate *conversation* branches per approach — but you keep separate *model*
   versions, which is what "try approaches, pick one" actually needs.
2. **Branch/fork (the removed approach).** Restore swaps both the model and the
   visible chat to that version's conversation; later edits form conversation
   branches. More powerful, but the chat changes on every restore.

## UX notes (if/when built)

- The original "Start from here" per-turn button was unclear ("what does it do?
  what happens when I click?"). A restore action needs: a self-explaining label,
  a confirm step that states the model/chat go back and that nothing is lost,
  and clear after-feedback.
- A labeled "Versions" list (familiar version-history metaphor) is more
  discoverable than a buried per-turn button. Keep it **out of the chat panel**
  (e.g. the top bar) so the conversation surface stays clean.
- Avoid surfacing a branch *tree* to consumers; a flat list reads better.

## Storage sketch (reusable)

`<project>/.panda/` is already excluded from catalog scans — a safe private
store for checkpoint snapshots + a `history.json` index.
