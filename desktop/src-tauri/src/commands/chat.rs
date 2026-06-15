//! `chat_*` IPC commands. Track F replaces the v0 synthetic stream
//! with the real Claude CLI driver: each turn spawns `claude -p`,
//! parses its stream-json output, and forwards translated events to
//! the React sidebar as Tauri `chat_event` emissions.

use crate::commands::claude_driver;
use crate::commands::claude_driver::TurnPhase;
use crate::ipc::types::{
    ApprovePlanRequest, ChatEvent, ChatEventEnvelope, ChatHistoryEntry, ChatRole, ChatSessionState,
    HistoryBlock, ImageAttachment, PlanChangesRequest, StartTurnRequest, StartTurnResponse,
};
use crate::ipc::{IpcError, IpcResult};
use crate::paths;
use crate::state::AppState;
use base64::Engine as _;
use chrono::DateTime;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const CHAT_EVENT: &str = "chat_event";

/// Prefix of the synthetic prompt [`chat_approve_plan`] injects to kick off the
/// build phase. The user never typed it, so [`parse_session_history`] drops
/// rehydrated user lines that start with it. Keep in sync with the `format!` in
/// [`chat_approve_plan`].
const APPROVE_PLAN_PREAMBLE: &str = "The plan below is approved. Implement it now, generating all parts";

/// Marker beginning the note [`attachment_note`] appends to a user message so
/// the model views attached reference images. [`parse_session_history`] strips
/// it (and everything after) from rehydrated history, so a reloaded user bubble
/// shows only what the user typed — never the machine-readable image note.
const ATTACHMENT_NOTE_MARKER: &str = "\n\n[Attached reference image";

/// Marker beginning the note [`revert_note`] appends to the first user message
/// after a `snapshot_restore`, so the model learns its files were reverted to a
/// saved state (the append-only session still "remembers" the post-snapshot
/// edits). Stripped from rehydrated history exactly like [`ATTACHMENT_NOTE_MARKER`].
const REVERT_NOTE_MARKER: &str = "\n\n[The model was reverted";

/// Caps on per-turn reference images: count, and bytes per image. Generous for
/// phone photos while bounding memory and the appended note's length.
const MAX_ATTACHMENTS: usize = 6;
const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024; // 10 MiB

/// UUID v5 namespace for deriving per-project Claude session UUIDs from
/// `projectId`. Using `Uuid::NAMESPACE_OID` matches what cadcode's
/// `routes/chat.py` does (`uuid5(_CLAUDE_UUID_NS, session_id)` where the
/// constant in cadcode is the OID namespace too) and gives us a stable
/// id across app restarts.
const CLAUDE_SESSION_NS: Uuid = Uuid::NAMESPACE_OID;

/// Per-process registry of in-flight chat turns, keyed by turn_id.
/// `chat_cancel_turn` looks the token up here and cancels it; the
/// driver task removes its entry on completion.
static TURN_REGISTRY: Lazy<Mutex<HashMap<String, CancellationToken>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn register_turn(turn_id: &str, token: CancellationToken) {
    TURN_REGISTRY.lock().insert(turn_id.to_string(), token);
}

fn deregister_turn(turn_id: &str) {
    TURN_REGISTRY.lock().remove(turn_id);
}

fn cancel_turn(turn_id: &str) -> bool {
    if let Some(token) = TURN_REGISTRY.lock().remove(turn_id) {
        token.cancel();
        true
    } else {
        false
    }
}

/// Resolve the on-disk workspace directory for a Panda project. Mirrors
/// `commands::project::project_dir` (kept local to avoid a public
/// dependency).
fn project_workspace(project_id: &str) -> PathBuf {
    paths::projects_root().join(project_id)
}

/// Deterministic per-project Claude session id. Same `projectId` →
/// same UUID across restarts, which is what `--session-id` /
/// `--resume` need to find the persisted JSONL.
pub fn session_id_for_project(project_id: &str) -> Uuid {
    Uuid::new_v5(&CLAUDE_SESSION_NS, project_id.as_bytes())
}

/// The synthetic message that kicks off the build phase from an (approved or
/// auto-approved) plan. Begins with [`APPROVE_PLAN_PREAMBLE`] so rehydration
/// drops it from history.
fn approved_plan_message(plan_text: &str) -> String {
    // Autopilot can reach here with an empty plan (the model exited plan mode
    // without restating it, keeping the plan in its thinking channel). The build
    // resumes the same session, so point it at the plan it just designed rather
    // than appending a blank. Keeps the APPROVE_PLAN_PREAMBLE prefix either way
    // so the synthetic prompt stays strippable on rehydration.
    let body = if plan_text.trim().is_empty() {
        "(Implement the plan you just designed in this session.)"
    } else {
        plan_text
    };
    format!(
        "The plan below is approved. Implement it now, generating all parts \
         and STL/STEP artifacts as described.\n\n{body}"
    )
}

/// Spawn one chat turn in the given phase and return its turn_id. Shared
/// by `chat_start_turn` (plan), `chat_approve_plan` (implement), and
/// `chat_request_plan_changes` (plan). The session id is deterministic per
/// project, so every phase resumes the same Claude session — planning
/// context (and the prior plan) carries into the build phase for free.
///
/// **Autopilot:** when `auto_build` is set (the default), a PLAN turn that
/// produces a plan (i.e. the model called ExitPlanMode — *not* a turn that
/// stopped to ask preference questions) chains straight into a build turn here,
/// with no `chat_approve_plan` round-trip. The manual approve path still exists
/// for `auto_build = false`.
fn spawn_chat_turn(
    app: AppHandle,
    project_id: &str,
    message: String,
    images: Vec<PathBuf>,
    phase: TurnPhase,
) -> String {
    let turn_id = Uuid::new_v4().to_string();
    let workspace = project_workspace(project_id);
    let session_id = session_id_for_project(project_id);
    let cancel = CancellationToken::new();
    register_turn(&turn_id, cancel.clone());

    let app_clone = app.clone();
    let turn_id_for_task = turn_id.clone();
    let cancel_for_task = cancel.clone();
    let project_id_for_task = project_id.to_string();

    tauri::async_runtime::spawn(async move {
        let emitter = app_clone.clone();
        let event_turn_id = turn_id_for_task.clone();
        // Stamps every emitted event so the frontend routes it to this project's
        // chat regardless of which project is on screen (see `ChatEventEnvelope`).
        let event_project_id = project_id_for_task.clone();
        // Capture the plan the model proposes so autopilot can build from it.
        // `Some(_)` means ExitPlanMode fired — build it, even if the plan TEXT is
        // empty (the model sometimes keeps the plan in its thinking channel and
        // exits plan mode blank; the build turn resumes the same session, so its
        // reasoning carries over). `None` means the turn ended without proposing a
        // plan — it stopped to ask preference questions, or errored — so don't
        // build. This distinction is why we track the Option rather than testing
        // the string: an empty ExitPlanMode plan must still build.
        let captured_plan: std::sync::Arc<Mutex<Option<String>>> =
            std::sync::Arc::new(Mutex::new(None));
        let plan_sink = captured_plan.clone();
        let on_event = move |event: ChatEvent| {
            if let ChatEvent::PlanProposed { ref plan, .. } = event {
                *plan_sink.lock() = Some(plan.clone());
            }
            // Best-effort emit. If the React side has unmounted (window
            // closed), emit fails — there's nothing useful to do here.
            let _ = emitter.emit(
                CHAT_EVENT,
                &ChatEventEnvelope { project_id: &event_project_id, event: &event },
            );
        };
        let _ = claude_driver::spawn_turn(
            &workspace,
            session_id,
            &message,
            &images,
            &event_turn_id,
            phase,
            on_event,
            cancel_for_task.clone(),
        )
        .await;
        deregister_turn(&turn_id_for_task);

        // Autopilot: after a plan turn that PROPOSED a plan (ExitPlanMode fired),
        // build it now — gated on the event, NOT on the plan text being
        // non-empty. The old `!plan.trim().is_empty()` guard silently aborted the
        // build when ExitPlanMode returned an empty plan, leaving the turn stuck
        // on "Building automatically" with nothing ever happening.
        let proposed_plan = captured_plan.lock().clone();
        if matches!(phase, TurnPhase::Plan) && !cancel_for_task.is_cancelled() {
            if let Some(plan) = proposed_plan {
                let auto_build = crate::commands::app::load_settings()
                    .await
                    .map(|s| s.auto_build)
                    .unwrap_or(true);
                if auto_build {
                    run_auto_build_turn(app_clone, project_id_for_task, workspace, session_id, plan)
                        .await;
                }
            }
        }
    });

    turn_id
}

/// Run a build (Implement) turn to completion from an auto-approved plan. Used
/// only by autopilot in [`spawn_chat_turn`]; registers its own turn so it can be
/// cancelled, and emits events the React side renders exactly like a manual
/// build. The driver's post-build review loop (geometry → functional →
/// aesthetic) runs inside this turn.
async fn run_auto_build_turn(
    app: AppHandle,
    project_id: String,
    workspace: PathBuf,
    session_id: Uuid,
    plan: String,
) {
    let turn_id = Uuid::new_v4().to_string();
    let cancel = CancellationToken::new();
    register_turn(&turn_id, cancel.clone());
    let emitter = app.clone();
    let on_event = move |event: ChatEvent| {
        let _ = emitter.emit(
            CHAT_EVENT,
            &ChatEventEnvelope { project_id: &project_id, event: &event },
        );
    };
    let _ = claude_driver::spawn_turn(
        &workspace,
        session_id,
        &approved_plan_message(&plan),
        &[],
        &turn_id,
        TurnPhase::Implement,
        on_event,
        cancel,
    )
    .await;
    deregister_turn(&turn_id);
}

/// Decode and persist the user's reference images into `<workspace>/inputs/`,
/// returning their workspace-relative paths (e.g. `inputs/<uuid>.png`). Written
/// before the turn spawns so they predate the driver's mtime baseline (no
/// spurious `artifact_changed`); `inputs/` is skipped by the catalog so they
/// never surface as CAD parts. The user-supplied `name` is never used as a
/// path — files are uuid-named with an extension chosen from the MIME type.
async fn persist_attachments(workspace: &Path, images: &[ImageAttachment]) -> IpcResult<Vec<String>> {
    if images.len() > MAX_ATTACHMENTS {
        return Err(IpcError::invalid_argument(format!(
            "too many images: {} (max {MAX_ATTACHMENTS})",
            images.len()
        )));
    }
    let dir = workspace.join("inputs");
    tokio::fs::create_dir_all(&dir).await.map_err(IpcError::from)?;
    let mut rels = Vec::with_capacity(images.len());
    for image in images {
        let ext = image_extension(&image.media_type).ok_or_else(|| {
            IpcError::invalid_argument(format!("unsupported image type: {}", image.media_type))
        })?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(image.data_base64.as_bytes())
            .map_err(|e| IpcError::invalid_argument(format!("invalid base64 image data: {e}")))?;
        if bytes.is_empty() || bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(IpcError::invalid_argument(format!(
                "image must be 1..={MAX_ATTACHMENT_BYTES} bytes, got {}",
                bytes.len()
            )));
        }
        let name = format!("{}.{ext}", Uuid::new_v4());
        tokio::fs::write(dir.join(&name), &bytes)
            .await
            .map_err(IpcError::from)?;
        rels.push(format!("inputs/{name}"));
    }
    Ok(rels)
}

/// Map an image MIME type to a file extension (allow-list — anything else is
/// rejected so we never persist a blob the model cannot view).
fn image_extension(media_type: &str) -> Option<&'static str> {
    match media_type.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

/// The note appended to the next user message after a model revert, telling the
/// model the on-disk files went back to the saved state `label` and to ignore
/// the post-snapshot edits its session still remembers. Begins with
/// [`REVERT_NOTE_MARKER`] so it's stripped on rehydration.
fn revert_note(label: &str) -> String {
    format!(
        "{REVERT_NOTE_MARKER} to the saved state \"{label}\". The files on disk now reflect \
         that earlier version — build on the current files and disregard any changes described \
         after that state was saved.]"
    )
}

/// The note appended to a user message so the model opens the attached images
/// (Claude Code's Read tool renders images). Listing workspace-relative paths
/// suffices — the child's cwd is the workspace. Begins with
/// [`ATTACHMENT_NOTE_MARKER`] so it can be stripped on rehydration.
fn attachment_note(rels: &[String]) -> String {
    if rels.is_empty() {
        return String::new();
    }
    format!(
        "{ATTACHMENT_NOTE_MARKER}(s): {}. View each with the Read tool before responding.]",
        rels.join(", ")
    )
}

#[tauri::command]
pub async fn chat_start_turn(
    req: StartTurnRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> IpcResult<StartTurnResponse> {
    // A fresh user message always starts in the planning phase; the model
    // may call ExitPlanMode immediately for a trivial edit (a one-line
    // plan) or run a full design pass for a new part.
    let mut message = req.user_message;
    // If the model was just reverted to a saved state, tell it so — the
    // append-only session otherwise still "remembers" the edits made after that
    // snapshot, which no longer match the files on disk. Drained (one-shot)
    // here; appended like the attachment note so it's stripped on rehydration.
    if let Some(label) = state.take_pending_revert_note(&req.project_id) {
        message.push_str(&revert_note(&label));
    }
    let mut image_paths: Vec<PathBuf> = Vec::new();
    if !req.images.is_empty() {
        // Persist the reference images into the project workspace, inline them
        // into the turn as base64 image blocks (so the VLM sees the pixels), and
        // ALSO append a text note pointing at the saved files (a fallback the
        // model can `Read`). Done here, before the turn spawns, so the files
        // predate the driver's mtime baseline and fire no `artifact_changed`.
        let workspace = project_workspace(&req.project_id);
        let rels = persist_attachments(&workspace, &req.images).await?;
        image_paths = rels.iter().map(|r| workspace.join(r)).collect();
        message.push_str(&attachment_note(&rels));
    }
    let turn_id = spawn_chat_turn(app, &req.project_id, message, image_paths, TurnPhase::Plan);
    Ok(StartTurnResponse { turn_id })
}

#[tauri::command]
pub async fn chat_approve_plan(
    req: ApprovePlanRequest,
    app: AppHandle,
    _state: State<'_, AppState>,
) -> IpcResult<StartTurnResponse> {
    // Resume the same session in acceptEdits mode and instruct the model to
    // implement the approved (possibly user-edited) plan. Echoing the plan
    // text back honors any edits without diffing. (Manual path — autopilot
    // chains the build automatically in spawn_chat_turn.)
    let message = approved_plan_message(&req.plan_text);
    let turn_id = spawn_chat_turn(app, &req.project_id, message, Vec::new(), TurnPhase::Implement);
    Ok(StartTurnResponse { turn_id })
}

#[tauri::command]
pub async fn chat_request_plan_changes(
    req: PlanChangesRequest,
    app: AppHandle,
    _state: State<'_, AppState>,
) -> IpcResult<StartTurnResponse> {
    // Stay in planning mode; the resumed session remembers the prior plan,
    // so the feedback alone is enough for the model to revise and re-propose.
    let turn_id = spawn_chat_turn(app, &req.project_id, req.feedback, Vec::new(), TurnPhase::Plan);
    Ok(StartTurnResponse { turn_id })
}

#[tauri::command]
pub async fn chat_cancel_turn(turn_id: String, _app: AppHandle) -> IpcResult<()> {
    // The driver task observes the cancel token and emits its own
    // `TurnEnd` + `Error{message:"cancelled"}` before exiting; we
    // don't double-emit here.
    cancel_turn(&turn_id);
    Ok(())
}

#[tauri::command]
pub async fn chat_session_state(
    project_id: String,
    state: State<'_, AppState>,
) -> IpcResult<ChatSessionState> {
    if let Some(existing) = state.chat_session_snapshot(&project_id) {
        return Ok(existing);
    }
    let session_id = session_id_for_project(&project_id).to_string();
    // No in-memory snapshot (e.g. fresh app launch or project switch): rebuild
    // the transcript from the JSONL Claude Code persists for this session so
    // chat history survives restarts. A missing or unreadable file just means
    // no prior turns — the contract's empty `history: []`. Read-only.
    let history = match claude_driver::session_jsonl_path(
        &project_workspace(&project_id),
        &session_id,
    ) {
        Some(path) => tokio::fs::read_to_string(path)
            .await
            .ok()
            .map(|contents| parse_session_history(&contents))
            .unwrap_or_default(),
        None => Vec::new(),
    };
    // The deterministic session id matches what the driver will use, so the
    // React side can correlate.
    Ok(ChatSessionState {
        session_id,
        turn_in_progress: false,
        history,
    })
}

/// Parse a Claude Code session JSONL transcript into the chat history the
/// sidebar rehydrates from. Emits one [`ChatHistoryEntry`] per user prompt and
/// one *grouped* assistant turn per response — all the assistant messages and
/// tool-result turns between two user prompts fold into a single entry whose
/// `blocks` carry the reasoning (thinking + narration) and tool calls (with
/// `tool_result`-resolved status/summary and start/end timings). This lets a
/// reloaded turn rebuild the same inline trace (segments, tool groups,
/// per-segment counters) the live stream produced. `isMeta` system injections,
/// the synthetic approve-plan prompt, and the intercepted `ExitPlanMode` /
/// `AskUserQuestion` tool calls are dropped (the latter aren't tool chips live
/// either). Pure so it's unit-testable without the real `~/.claude/projects`.
fn parse_session_history(contents: &str) -> Vec<ChatHistoryEntry> {
    let mut history: Vec<ChatHistoryEntry> = Vec::new();
    // The in-progress assistant turn: a response spans several assistant
    // messages + tool-result user turns until the next real user prompt.
    let mut blocks: Vec<HistoryBlock> = Vec::new();
    let mut text_parts: Vec<String> = Vec::new();
    let mut turn_at: i64 = 0;
    // tool_use_id -> index into `blocks`, to resolve a later tool_result.
    let mut pending: HashMap<String, usize> = HashMap::new();

    fn flush(
        history: &mut Vec<ChatHistoryEntry>,
        blocks: &mut Vec<HistoryBlock>,
        text_parts: &mut Vec<String>,
        turn_at: &mut i64,
        pending: &mut HashMap<String, usize>,
    ) {
        if !blocks.is_empty() {
            history.push(ChatHistoryEntry {
                role: ChatRole::Assistant,
                content: text_parts.join("\n\n"),
                at: *turn_at,
                blocks: std::mem::take(blocks),
            });
        }
        text_parts.clear();
        *turn_at = 0;
        pending.clear();
    }

    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if obj.get("isMeta").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let role = match obj.get("type").and_then(Value::as_str) {
            Some("user") => ChatRole::User,
            Some("assistant") => ChatRole::Assistant,
            _ => continue,
        };
        let ts = obj
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(0);
        let content = obj
            .get("message")
            .and_then(Value::as_object)
            .and_then(|m| m.get("content"));

        if role == ChatRole::Assistant {
            if turn_at == 0 {
                turn_at = ts;
            }
            if let Some(Value::Array(items)) = content {
                for block in items {
                    match block.get("type").and_then(Value::as_str).unwrap_or("") {
                        "thinking" => {
                            if let Some(t) = block.get("thinking").and_then(Value::as_str) {
                                if !t.is_empty() {
                                    blocks.push(HistoryBlock::Thinking {
                                        text: t.to_string(),
                                        at: ts,
                                    });
                                }
                            }
                        }
                        "text" => {
                            if let Some(t) = block.get("text").and_then(Value::as_str) {
                                if !t.is_empty() {
                                    text_parts.push(t.to_string());
                                    blocks.push(HistoryBlock::Text { text: t.to_string() });
                                }
                            }
                        }
                        "tool_use" => {
                            let name = block
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            // Not tool chips live — they become a plan / question card.
                            if name == "ExitPlanMode" || name == "AskUserQuestion" {
                                continue;
                            }
                            let id = block
                                .get("id")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            let input = block
                                .get("input")
                                .cloned()
                                .unwrap_or_else(|| Value::Object(Default::default()));
                            if !id.is_empty() {
                                pending.insert(id.clone(), blocks.len());
                            }
                            blocks.push(HistoryBlock::ToolUse {
                                tool: name,
                                tool_use_id: id,
                                input,
                                // Resolved by the matching tool_result; defaults to ok
                                // for the rare result-less tool in a completed turn.
                                status: "ok".to_string(),
                                result_summary: None,
                                at: ts,
                                ended_at: ts,
                            });
                        }
                        _ => {}
                    }
                }
            }
            continue;
        }

        // A user turn carrying tool_result blocks isn't a prompt — it resolves
        // the current assistant turn's pending tools and continues it.
        let is_tool_result = matches!(
            content,
            Some(Value::Array(items))
                if items.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
        );
        if is_tool_result {
            if let Some(Value::Array(items)) = content {
                for b in items {
                    if b.get("type").and_then(Value::as_str) != Some("tool_result") {
                        continue;
                    }
                    let id = b.get("tool_use_id").and_then(Value::as_str).unwrap_or("");
                    let Some(&idx) = pending.get(id) else { continue };
                    let is_error = b.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                    let summary = claude_driver::summarize_tool_result(b.get("content"));
                    if let Some(HistoryBlock::ToolUse {
                        status,
                        ended_at,
                        result_summary,
                        ..
                    }) = blocks.get_mut(idx)
                    {
                        *status = if is_error { "error" } else { "ok" }.to_string();
                        *ended_at = ts;
                        *result_summary = summary;
                    }
                }
            }
            continue;
        }

        // A real user prompt closes the previous assistant turn, then lands.
        flush(
            &mut history,
            &mut blocks,
            &mut text_parts,
            &mut turn_at,
            &mut pending,
        );
        let mut text = extract_visible_text(content);
        // Strip the machine-readable notes the build appends to a user message
        // (image attachments, model-revert) so the bubble shows only what the
        // user typed.
        if let Some(idx) = [
            text.find(ATTACHMENT_NOTE_MARKER),
            text.find(REVERT_NOTE_MARKER),
        ]
        .into_iter()
        .flatten()
        .min()
        {
            text.truncate(idx);
        }
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Drop the synthetic "implement the approved plan" prompt the build
        // phase injects — it isn't something the user typed.
        if trimmed.starts_with(APPROVE_PLAN_PREAMBLE) {
            continue;
        }
        history.push(ChatHistoryEntry {
            role: ChatRole::User,
            content: trimmed.to_string(),
            at: ts,
            blocks: Vec::new(),
        });
    }
    flush(
        &mut history,
        &mut blocks,
        &mut text_parts,
        &mut turn_at,
        &mut pending,
    );
    history
}

/// Collect human-visible text from a message `content` field. Claude Code
/// stores user prompts as a bare string and assistant turns as a block array;
/// keep `text` blocks (joining a multi-block turn with blank lines) and ignore
/// `thinking`, `tool_use`, and `tool_result` blocks.
fn extract_visible_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| {
                let obj = block.as_object()?;
                if obj.get("type").and_then(Value::as_str) != Some("text") {
                    return None;
                }
                obj.get("text").and_then(Value::as_str)
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::types::ArtifactReason;

    #[test]
    fn chat_event_serializes_with_camel_case_fields() {
        let event = ChatEvent::TextDelta {
            turn_id: "t1".into(),
            text: "hi".into(),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["kind"], "text_delta");
        assert_eq!(json["turnId"], "t1");
        assert_eq!(json["text"], "hi");
    }

    #[test]
    fn chat_event_envelope_flattens_event_and_adds_project_id() {
        // The wire shape every `chat_event` is emitted as: the event's own
        // fields (flattened) plus the owning `projectId` for frontend routing.
        let event = ChatEvent::TextDelta {
            turn_id: "t1".into(),
            text: "hi".into(),
        };
        let json = serde_json::to_value(ChatEventEnvelope {
            project_id: "proj-1",
            event: &event,
        })
        .unwrap();
        assert_eq!(json["kind"], "text_delta");
        assert_eq!(json["turnId"], "t1");
        assert_eq!(json["text"], "hi");
        assert_eq!(json["projectId"], "proj-1");
    }

    #[test]
    fn chat_event_artifact_changed_includes_reason() {
        let event = ChatEvent::ArtifactChanged {
            turn_id: "t1".into(),
            file: "model.step".into(),
            reason: ArtifactReason::New,
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["kind"], "artifact_changed");
        assert_eq!(json["reason"], "new");
    }

    #[test]
    fn approved_plan_message_carries_preamble_and_plan() {
        let msg = approved_plan_message("Make a 120mm phone stand.");
        assert!(msg.starts_with(APPROVE_PLAN_PREAMBLE));
        assert!(msg.contains("Make a 120mm phone stand."));
        // The build phase's synthetic prompt must be droppable from history.
        assert!(parse_session_history(
            &serde_json::json!({
                "type": "user",
                "message": {"role": "user", "content": msg},
                "timestamp": "2026-06-10T00:00:00.000Z"
            })
            .to_string()
        )
        .is_empty());
    }

    #[test]
    fn approved_plan_message_handles_empty_plan_and_stays_strippable() {
        // Autopilot reaches this with an empty plan when the model exits plan mode
        // blank. The message must still kick off a build (keep the preamble) and
        // stay droppable from rehydrated history, and must not append a bare gap.
        let msg = approved_plan_message("   ");
        assert!(msg.starts_with(APPROVE_PLAN_PREAMBLE));
        assert!(msg.contains("Implement the plan you just designed"));
        assert!(parse_session_history(
            &serde_json::json!({
                "type": "user",
                "message": {"role": "user", "content": msg},
                "timestamp": "2026-06-10T00:00:00.000Z"
            })
            .to_string()
        )
        .is_empty());
    }

    #[test]
    fn auto_build_defaults_true_even_for_legacy_settings() {
        use crate::ipc::types::AppSettings;
        // Default impl is autopilot-on.
        assert!(AppSettings::default().auto_build);
        // A settings file written before the field existed → still autopilot.
        let legacy = r#"{"defaultFilament":"PLA","slicerBinaryPath":"","slicerSettingsProfile":"","slicerFilamentProfile":"","defaultPrinterId":"","usePandaCloud":false,"hasOnboarded":true,"autoUpdate":false}"#;
        let parsed: AppSettings = serde_json::from_str(legacy).unwrap();
        assert!(parsed.auto_build, "missing auto_build must default to true");
        // Explicit false is honored (manual approve flow).
        let manual: AppSettings =
            serde_json::from_str(r#"{"defaultFilament":"PLA","slicerBinaryPath":"","slicerSettingsProfile":"","slicerFilamentProfile":"","defaultPrinterId":"","usePandaCloud":false,"hasOnboarded":true,"autoUpdate":false,"autoBuild":false}"#)
                .unwrap();
        assert!(!manual.auto_build);
    }

    #[test]
    fn session_id_for_project_is_deterministic() {
        let a1 = session_id_for_project("proj-A");
        let a2 = session_id_for_project("proj-A");
        let b1 = session_id_for_project("proj-B");
        assert_eq!(a1, a2, "same projectId must produce same uuid");
        assert_ne!(a1, b1, "different projectIds must differ");
    }

    #[test]
    fn cancel_unknown_turn_is_safe() {
        // Cancelling a turn that was never registered must be a no-op,
        // not a panic.
        assert!(!cancel_turn("does-not-exist"));
    }

    #[test]
    fn parse_session_history_extracts_user_and_assistant_text() {
        let jsonl = concat!(
            r#"{"type":"last-prompt","prompt":"hi"}"#,
            "\n",
            r#"{"type":"user","message":{"role":"user","content":"make a phone stand"},"timestamp":"2026-06-03T04:59:51.273Z"}"#,
            "\n",
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"}]},"timestamp":"2026-06-03T04:59:56.000Z"}"#,
            "\n",
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Sure, here is the plan."}]},"timestamp":"2026-06-03T04:59:57.000Z"}"#,
            "\n",
        );
        let history = parse_session_history(jsonl);
        assert_eq!(history.len(), 2, "got {history:?}");
        assert_eq!(history[0].role, ChatRole::User);
        assert_eq!(history[0].content, "make a phone stand");
        assert!(history[0].at > 0, "ISO timestamp must parse to epoch millis");
        assert_eq!(history[1].role, ChatRole::Assistant);
        assert_eq!(history[1].content, "Sure, here is the plan.");
    }

    #[test]
    fn parse_session_history_drops_meta_and_synthetic_but_keeps_tool_calls() {
        // isMeta system turns, the synthetic approve-plan prompt, and an orphan
        // tool_result (no matching tool_use) are dropped; a real tool call still
        // rehydrates as a tool block.
        let jsonl = concat!(
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<system-reminder>noise</system-reminder>"},"timestamp":"2026-06-03T05:00:00.000Z"}"#,
            "\n",
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]},"timestamp":"2026-06-03T05:00:01.000Z"}"#,
            "\n",
            r#"{"type":"user","message":{"role":"user","content":"The plan below is approved. Implement it now, generating all parts and STL/STEP artifacts as described.\n\nBuild a box."},"timestamp":"2026-06-03T05:00:02.000Z"}"#,
            "\n",
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"u1","name":"cadcode","input":{}}]},"timestamp":"2026-06-03T05:00:03.000Z"}"#,
            "\n",
        );
        let history = parse_session_history(jsonl);
        assert_eq!(history.len(), 1, "got {history:?}");
        assert_eq!(history[0].role, ChatRole::Assistant);
        assert_eq!(history[0].blocks.len(), 1);
        assert!(
            matches!(&history[0].blocks[0], HistoryBlock::ToolUse { tool, .. } if tool == "cadcode"),
            "got {:?}",
            history[0].blocks,
        );
    }

    #[test]
    fn parse_session_history_rebuilds_grouped_assistant_trace_with_tool_timings() {
        // Several assistant messages + tool-result turns between two prompts fold
        // into ONE assistant entry; tool_results resolve status/summary/timings.
        let jsonl = concat!(
            r#"{"type":"user","message":{"role":"user","content":"make a box"},"timestamp":"2026-06-03T05:00:00.000Z"}"#,
            "\n",
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me check."},{"type":"tool_use","id":"u1","name":"Read","input":{"file_path":"a.py"}}]},"timestamp":"2026-06-03T05:00:01.000Z"}"#,
            "\n",
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"u1","is_error":false,"content":[{"type":"text","text":"x\ny\nz"}]}]},"timestamp":"2026-06-03T05:00:04.000Z"}"#,
            "\n",
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Now writing."},{"type":"tool_use","id":"u2","name":"Write","input":{}}]},"timestamp":"2026-06-03T05:00:05.000Z"}"#,
            "\n",
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"u2","is_error":true,"content":"boom"}]},"timestamp":"2026-06-03T05:00:06.000Z"}"#,
            "\n",
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done."}]},"timestamp":"2026-06-03T05:00:07.000Z"}"#,
            "\n",
        );
        let history = parse_session_history(jsonl);
        assert_eq!(history.len(), 2, "user + one grouped assistant turn, got {history:?}");
        assert_eq!(history[0].role, ChatRole::User);
        let asst = &history[1];
        assert_eq!(asst.role, ChatRole::Assistant);
        assert_eq!(asst.content, "Let me check.\n\nNow writing.\n\nDone.");
        let kinds: Vec<&str> = asst
            .blocks
            .iter()
            .map(|b| match b {
                HistoryBlock::Text { .. } => "text",
                HistoryBlock::Thinking { .. } => "thinking",
                HistoryBlock::ToolUse { .. } => "tool_use",
            })
            .collect();
        assert_eq!(kinds, ["text", "tool_use", "text", "tool_use", "text"]);
        match &asst.blocks[1] {
            HistoryBlock::ToolUse {
                tool,
                status,
                result_summary,
                at,
                ended_at,
                ..
            } => {
                assert_eq!(tool, "Read");
                assert_eq!(status, "ok");
                assert_eq!(result_summary.as_deref(), Some("3 lines"));
                assert!(ended_at > at, "tool end ({ended_at}) after start ({at})");
            }
            other => panic!("expected Read ToolUse, got {other:?}"),
        }
        assert!(
            matches!(&asst.blocks[3], HistoryBlock::ToolUse { tool, status, .. } if tool == "Write" && status == "error"),
            "Write must resolve to error, got {:?}",
            asst.blocks[3],
        );
    }

    #[test]
    fn parse_session_history_joins_multiple_text_blocks() {
        let jsonl = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Part one."},{"type":"text","text":"Part two."}]},"timestamp":"2026-06-03T05:00:00.000Z"}"#;
        let history = parse_session_history(jsonl);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].content, "Part one.\n\nPart two.");
    }

    #[test]
    fn parse_session_history_ignores_garbage_lines() {
        assert!(parse_session_history("not json\n\n{bad}\n").is_empty());
    }

    #[test]
    fn registry_register_then_cancel_round_trip() {
        let token = CancellationToken::new();
        let id = format!("turn-{}", Uuid::new_v4());
        register_turn(&id, token.clone());
        assert!(!token.is_cancelled());
        assert!(cancel_turn(&id));
        assert!(token.is_cancelled());
        // Removed from registry on cancel:
        assert!(!cancel_turn(&id));
    }

    #[tokio::test]
    async fn persist_attachments_writes_uuid_named_files() {
        let dir = tempfile::tempdir().unwrap();
        let images = vec![
            ImageAttachment {
                name: "photo.png".into(),
                media_type: "image/png".into(),
                data_base64: "aGVsbG8=".into(), // "hello"
            },
            // A hostile filename must never reach the path — files are uuid-named.
            ImageAttachment {
                name: "../../evil.jpg".into(),
                media_type: "image/jpeg".into(),
                data_base64: "d29ybGQ=".into(), // "world"
            },
        ];
        let rels = persist_attachments(dir.path(), &images).await.unwrap();
        assert_eq!(rels.len(), 2);
        for rel in &rels {
            assert!(rel.starts_with("inputs/"), "got {rel}");
            assert!(!rel.contains("evil"), "user name must not leak into path: {rel}");
            assert!(dir.path().join(rel).is_file());
        }
    }

    #[tokio::test]
    async fn persist_attachments_rejects_bad_base64() {
        let dir = tempfile::tempdir().unwrap();
        let images = vec![ImageAttachment {
            name: "a.png".into(),
            media_type: "image/png".into(),
            data_base64: "not valid base64!!".into(),
        }];
        let err = persist_attachments(dir.path(), &images).await.unwrap_err();
        assert_eq!(err.code, "INVALID_ARGUMENT");
    }

    #[tokio::test]
    async fn persist_attachments_rejects_unsupported_type() {
        let dir = tempfile::tempdir().unwrap();
        let images = vec![ImageAttachment {
            name: "a.txt".into(),
            media_type: "text/plain".into(),
            data_base64: "aGVsbG8=".into(),
        }];
        let err = persist_attachments(dir.path(), &images).await.unwrap_err();
        assert_eq!(err.code, "INVALID_ARGUMENT");
    }

    #[tokio::test]
    async fn persist_attachments_rejects_too_many() {
        let dir = tempfile::tempdir().unwrap();
        let one = ImageAttachment {
            name: "a.png".into(),
            media_type: "image/png".into(),
            data_base64: "aGVsbG8=".into(),
        };
        let images = vec![one; MAX_ATTACHMENTS + 1];
        let err = persist_attachments(dir.path(), &images).await.unwrap_err();
        assert_eq!(err.code, "INVALID_ARGUMENT");
    }

    #[test]
    fn attachment_note_lists_paths_and_is_empty_for_none() {
        assert_eq!(attachment_note(&[]), "");
        let note = attachment_note(&["inputs/a.png".into(), "inputs/b.jpg".into()]);
        assert!(note.starts_with(ATTACHMENT_NOTE_MARKER));
        assert!(note.contains("inputs/a.png") && note.contains("inputs/b.jpg"));
        assert!(note.contains("Read tool"));
    }

    #[test]
    fn start_turn_request_defaults_images_when_absent() {
        let req: StartTurnRequest =
            serde_json::from_str(r#"{"projectId":"p","userMessage":"hi"}"#).unwrap();
        assert!(req.images.is_empty());
    }

    #[test]
    fn start_turn_request_parses_camel_case_images() {
        let req: StartTurnRequest = serde_json::from_str(
            r#"{"projectId":"p","userMessage":"hi","images":[{"name":"a.png","mediaType":"image/png","dataBase64":"aGVsbG8="}]}"#,
        )
        .unwrap();
        assert_eq!(req.images.len(), 1);
        assert_eq!(req.images[0].media_type, "image/png");
        assert_eq!(req.images[0].data_base64, "aGVsbG8=");
    }

    #[test]
    fn revert_note_strips_on_rehydration_and_keeps_user_text() {
        // A user message carrying the revert note shows only the typed text.
        let content = format!("make it taller{}", revert_note("Version 2"));
        let line = serde_json::json!({
            "type": "user",
            "message": {"role": "user", "content": content},
            "timestamp": "2026-06-10T00:00:00.000Z"
        })
        .to_string();
        let history = parse_session_history(&line);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].content, "make it taller");
        // The note names the saved state so the model knows what changed.
        assert!(revert_note("Version 2").contains("Version 2"));
    }

    #[test]
    fn parse_session_history_strips_earliest_of_revert_and_attachment_notes() {
        // Both notes can ride one message (revert + attached image); strip from
        // the earliest marker so neither leaks into the rehydrated bubble.
        let content = format!(
            "tweak it{}{}",
            revert_note("v1"),
            attachment_note(&["inputs/a.png".into()])
        );
        let line = serde_json::json!({
            "type": "user",
            "message": {"role": "user", "content": content},
            "timestamp": "2026-06-10T00:00:00.000Z"
        })
        .to_string();
        let history = parse_session_history(&line);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].content, "tweak it");
    }

    #[test]
    fn parse_session_history_strips_the_attachment_note() {
        let content = format!(
            "make a stand{ATTACHMENT_NOTE_MARKER}(s): inputs/x.png. View each with the Read tool before responding.]"
        );
        let line = serde_json::json!({
            "type": "user",
            "message": {"role": "user", "content": content},
            "timestamp": "2026-06-03T05:00:00.000Z"
        })
        .to_string();
        let history = parse_session_history(&line);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].content, "make a stand");
    }
}
