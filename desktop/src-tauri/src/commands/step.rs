//! `step_*` IPC commands. Lightweight v0 — full Python-sidecar plumbing
//! lands once Track A's cadpy CadQuery adapter is wired up.

use crate::ipc::types::{
    GenerationQueueItem, GenerationQueueKind, StepSourceKind, StepSourceStatus,
};
use crate::ipc::{IpcError, IpcResult};
use crate::paths;
use crate::state::AppState;
use chrono::Utc;
use std::path::Path;
use tauri::State;

/// `step_source_status_read` — real: scan for a same-stem `.py` sidecar
/// next to the requested `.step` file and report it back. Scoped to the
/// open project: `file` is project-relative and resolves under that
/// project's dir.
#[tauri::command]
pub async fn step_source_status_read(
    file: String,
    state: State<'_, AppState>,
) -> IpcResult<StepSourceStatus> {
    let none = StepSourceStatus {
        has_source: false,
        source_path: None,
        source_kind: None,
    };
    let Some(id) = state.active_project() else {
        return Ok(none);
    };
    source_status_in(&paths::project_root(&id), &file)
}

/// Sidecar lookup against a concrete project dir. Split out so tests can
/// exercise it without a Tauri `State`.
fn source_status_in(project_root: &Path, file: &str) -> IpcResult<StepSourceStatus> {
    let none = StepSourceStatus {
        has_source: false,
        source_path: None,
        source_kind: None,
    };
    let absolute =
        paths::resolve_under(project_root, file).map_err(IpcError::invalid_argument)?;
    if !absolute.exists() {
        return Ok(none);
    }
    let Some(stem) = absolute.file_stem().map(|s| s.to_owned()) else {
        return Ok(none);
    };
    let mut sibling = absolute.clone();
    sibling.set_file_name(stem);
    sibling.set_extension("py");
    if !sibling.exists() {
        return Ok(none);
    }
    let rel = paths::to_workspace_relative(&sibling, project_root);
    Ok(StepSourceStatus {
        has_source: true,
        source_path: rel,
        source_kind: Some(StepSourceKind::Python),
    })
}

/// `step_artifact_regenerate` — stub: enqueue a generation job so the
/// React side sees `generation_status_read.queue` change, then drop it
/// after a beat. Real Python-sidecar invocation arrives once the cadcode
/// runner can produce STEP + GLB + topology from a `gen_step()` source.
///
/// TODO(track-c-followup): wire to `python -m cadpy.step_artifact` via
/// `tauri-plugin-shell` sidecar once the bundled CPython exists.
#[tauri::command]
pub async fn step_artifact_regenerate(
    file: String,
    force: bool,
    state: State<'_, AppState>,
) -> IpcResult<()> {
    let _ = force; // silence-warnings; the force flag controls whether to
                   // bypass mtime checks once the sidecar is real.
    let queue_item = GenerationQueueItem {
        file: file.clone(),
        started_at: Utc::now().timestamp_millis(),
        kind: GenerationQueueKind::Step,
    };
    state.push_generation_job(queue_item);
    state.bump_revision();
    // Without a real sidecar we mark the job done immediately so the
    // queue does not grow unbounded across test calls. A subsequent
    // mtime poll on the React side will read an empty queue, matching
    // the "request submitted, no progress to report" shape.
    state.pop_generation_job(&file);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_no_source_when_step_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let res = source_status_in(tmp.path(), "nonexistent.step").unwrap();
        assert!(!res.has_source);
        assert!(res.source_path.is_none());
    }

    #[test]
    fn reports_python_source_with_bare_relative_path() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("model.step"), b"").unwrap();
        std::fs::write(tmp.path().join("model.py"), b"").unwrap();
        let res = source_status_in(tmp.path(), "model.step").unwrap();
        assert!(res.has_source);
        assert_eq!(res.source_path.as_deref(), Some("model.py"));
        assert_eq!(res.source_kind, Some(StepSourceKind::Python));
    }

    #[test]
    fn step_source_status_struct_shape() {
        // Just confirm the serde shape matches the TS interface.
        let status = StepSourceStatus {
            has_source: true,
            source_path: Some("model.py".into()),
            source_kind: Some(StepSourceKind::Python),
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["hasSource"], true);
        assert_eq!(json["sourcePath"], "model.py");
        assert_eq!(json["sourceKind"], "python");
    }

    #[test]
    fn last_generation_error_serde() {
        let err = crate::ipc::types::GenerationLastError {
            file: "model.step".into(),
            message: "bad".into(),
            at: 0,
        };
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["file"], "model.step");
    }
}
