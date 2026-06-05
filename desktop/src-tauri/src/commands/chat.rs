//! `chat_*` IPC commands. Track F replaces the v0 synthetic stream
//! with the real Claude CLI driver: each turn spawns `claude -p`,
//! parses its stream-json output, and forwards translated events to
//! the React sidebar as Tauri `chat_event` emissions.

use crate::commands::claude_driver;
use crate::commands::claude_driver::TurnPhase;
use crate::ipc::types::{
    ApprovePlanRequest, ChatEvent, ChatHistoryEntry, ChatRole, ChatSessionState,
    PlanChangesRequest, StartTurnRequest, StartTurnResponse,
};
use crate::ipc::IpcResult;
use crate::paths;
use crate::state::AppState;
use chrono::DateTime;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const CHAT_EVENT: &str = "chat_event";

/// Prefix of the synthetic prompt [`chat_approve_plan`] injects to kick off the
/// build phase. The user never typed it, so [`parse_session_history`] drops
/// rehydrated user lines that start with it. Keep in sync with the `format!` in
/// [`chat_approve_plan`].
const APPROVE_PLAN_PREAMBLE: &str = "The plan below is approved. Implement it now, generating all parts";

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

/// Spawn one chat turn in the given phase and return its turn_id. Shared
/// by `chat_start_turn` (plan), `chat_approve_plan` (implement), and
/// `chat_request_plan_changes` (plan). The session id is deterministic per
/// project, so every phase resumes the same Claude session — planning
/// context (and the prior plan) carries into the build phase for free.
fn spawn_chat_turn(app: AppHandle, project_id: &str, message: String, phase: TurnPhase) -> String {
    let turn_id = Uuid::new_v4().to_string();
    let workspace = project_workspace(project_id);
    let session_id = session_id_for_project(project_id);
    let cancel = CancellationToken::new();
    register_turn(&turn_id, cancel.clone());

    let app_clone = app.clone();
    let turn_id_for_task = turn_id.clone();

    tauri::async_runtime::spawn(async move {
        let emitter = app_clone.clone();
        let event_turn_id = turn_id_for_task.clone();
        let on_event = move |event: ChatEvent| {
            // Best-effort emit. If the React side has unmounted (window
            // closed), emit fails — there's nothing useful to do here.
            let _ = emitter.emit(CHAT_EVENT, &event);
        };
        let _ = claude_driver::spawn_turn(
            &workspace,
            session_id,
            &message,
            &event_turn_id,
            phase,
            on_event,
            cancel,
        )
        .await;
        deregister_turn(&turn_id_for_task);
    });

    turn_id
}

#[tauri::command]
pub async fn chat_start_turn(
    req: StartTurnRequest,
    app: AppHandle,
    _state: State<'_, AppState>,
) -> IpcResult<StartTurnResponse> {
    // A fresh user message always starts in the planning phase; the model
    // may call ExitPlanMode immediately for a trivial edit (a one-line
    // plan) or run a full design pass for a new part.
    let turn_id = spawn_chat_turn(app, &req.project_id, req.user_message, TurnPhase::Plan);
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
    // text back honors any edits without diffing.
    let message = format!(
        "The plan below is approved. Implement it now, generating all parts \
         and STL/STEP artifacts as described.\n\n{}",
        req.plan_text
    );
    let turn_id = spawn_chat_turn(app, &req.project_id, message, TurnPhase::Implement);
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
    let turn_id = spawn_chat_turn(app, &req.project_id, req.feedback, TurnPhase::Plan);
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
/// per assistant message that carries visible text; `thinking`/`tool_use`
/// blocks, tool-result user turns, `isMeta` system injections, and the
/// synthetic approve-plan prompt are all dropped. Pure so it's unit-testable
/// without the real `~/.claude/projects` path.
fn parse_session_history(contents: &str) -> Vec<ChatHistoryEntry> {
    let mut history = Vec::new();
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        // Skip Claude Code's injected meta turns (system reminders, etc.).
        if obj.get("isMeta").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let role = match obj.get("type").and_then(Value::as_str) {
            Some("user") => ChatRole::User,
            Some("assistant") => ChatRole::Assistant,
            _ => continue,
        };
        let text = obj
            .get("message")
            .and_then(Value::as_object)
            .map(|message| extract_visible_text(message.get("content")))
            .unwrap_or_default();
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Drop the synthetic "implement the approved plan" prompt the build
        // phase injects — it isn't something the user typed.
        if role == ChatRole::User && trimmed.starts_with(APPROVE_PLAN_PREAMBLE) {
            continue;
        }
        let at = obj
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|ts| DateTime::parse_from_rfc3339(ts).ok())
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(0);
        history.push(ChatHistoryEntry {
            role,
            content: trimmed.to_string(),
            at,
        });
    }
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
    fn parse_session_history_skips_meta_tool_and_synthetic_lines() {
        let jsonl = concat!(
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<system-reminder>noise</system-reminder>"},"timestamp":"2026-06-03T05:00:00.000Z"}"#,
            "\n",
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]},"timestamp":"2026-06-03T05:00:01.000Z"}"#,
            "\n",
            r#"{"type":"user","message":{"role":"user","content":"The plan below is approved. Implement it now, generating all parts and STL/STEP artifacts as described.\n\nBuild a box."},"timestamp":"2026-06-03T05:00:02.000Z"}"#,
            "\n",
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"cadcode","input":{}}]},"timestamp":"2026-06-03T05:00:03.000Z"}"#,
            "\n",
        );
        let history = parse_session_history(jsonl);
        assert!(
            history.is_empty(),
            "meta/tool/synthetic lines must be dropped, got {history:?}"
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
}
