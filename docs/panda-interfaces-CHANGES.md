# panda-interfaces changes

Append-only log of changes to the frozen `panda-interfaces.md` contracts. Each
entry records the date, what changed, which tracks are affected, and the
migration note. See the "Contract change discipline" section of
`panda-interfaces.md`.

## 2026-06-05 — `StartTurnRequest.images` (chat reference images)

**Change.** Added an optional `images?: ImageAttachment[]` field to
`StartTurnRequest` (the `chat_start_turn` IPC), where `ImageAttachment` is
`{ name?: string; mediaType: string; dataBase64: string }`.

**Why.** The chat composer now lets users attach reference photos (file picker,
copy-paste, drag-drop) so the model can see them when designing CAD.

**Backward compatible.** Additive + optional. The Rust struct field is
`#[serde(default)]`, so existing callers — and the browser HTTP stub — that omit
it still deserialize. Text-only turns send the exact same request shape as
before (no `images` key). Input-only: no `ChatEvent` variants changed.

**Mechanism (driver untouched).** `chat_start_turn` decodes + persists each
image into `<workspace>/inputs/<uuid>.<ext>` *before* the turn spawns (so they
predate the driver's mtime baseline and emit no `artifact_changed`), then
appends a one-line note to the user message listing the paths; the model opens
them with its Read tool. `inputs/` is excluded from the catalog, so reference
images never surface as CAD parts. The `claude` CLI invocation (plain-text
prompt arg) is unchanged.

**Tracks affected.** Tauri (`ipc/types.rs`, `commands/chat.rs`,
`commands/catalog.rs`, `tauri.conf.json`), chat (viewer `transport.ts`,
`store/chat.js`, composer). No cadpy / skill impact.

## 2026-07-06 — §3 clarification: who consumes the stdout line vs the sidecar

**Change.** Docs-only clarification of §3 ("Skill stdout + artifact
contract"): the `CadcodeResult` stdout line is consumed by the `claude` CLI
as the tool-call result (what the model sees); the Rust driver never parses
it. The driver's load-bearing machine contract is the `.step.json` sidecar's
`validation.warnings`, which the review-fix loop gates on `severity` (not on
the enumerated `kind` strings — that set is open). Also removed the stale
"(not yet created)" note about this CHANGES file.

**Why.** The old wording read as if the driver deserialized the stdout JSON,
which could mislead a contract change: renaming a stdout field is invisible
to the driver, while renaming a `validation.warnings` field breaks the
review loop.

**Backward compatible.** No schema, wire format, or behavior changed —
prose only, describing what the code already does.

**Tracks affected.** None.
