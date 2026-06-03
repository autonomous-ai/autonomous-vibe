//! `chat_*` IPC commands. Track F replaces the v0 synthetic stream
//! with the real Claude CLI driver: each turn spawns `claude -p`,
//! parses its stream-json output, and forwards translated events to
//! the React sidebar as Tauri `chat_event` emissions.

use crate::commands::claude_driver;
use crate::commands::claude_driver::TurnPhase;
use crate::ipc::types::{
    ApprovePlanRequest, ChatEvent, ChatSessionState, PlanChangesRequest, StartTurnRequest,
    StartTurnResponse,
};
use crate::ipc::IpcResult;
use crate::paths;
use crate::state::AppState;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const CHAT_EVENT: &str = "chat_event";

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
    let session_id = session_id_for_project(project_id);
    let workspace = project_workspace(project_id);
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
    // Empty session matches the contract: `history: []`, no turn in
    // progress. The deterministic session id matches what the driver
    // will use, so the React side can correlate.
    Ok(ChatSessionState {
        session_id: session_id_for_project(&project_id).to_string(),
        turn_in_progress: false,
        history: Vec::new(),
    })
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
