//! `file_read_bytes` + `file_reveal` IPC commands.

use crate::ipc::types::AssetKind;
use crate::ipc::{IpcError, IpcResult};
use crate::paths;
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn file_read_bytes(
    file: String,
    asset: AssetKind,
    state: State<'_, AppState>,
) -> IpcResult<Vec<u8>> {
    let resolved = resolve_asset(&state, &file, asset)?;
    tokio::fs::read(&resolved).await.map_err(IpcError::from)
}

#[tauri::command]
pub async fn file_reveal(
    file: String,
    asset: AssetKind,
    state: State<'_, AppState>,
) -> IpcResult<()> {
    let resolved = resolve_asset(&state, &file, asset)?;
    let target = resolved.display().to_string();
    // tauri-plugin-opener exposes `reveal_item_in_dir` via Rust API; we
    // call the open crate directly for portability — Track C only needs a
    // synchronous "show in OS file manager" effect.
    let parent = resolved
        .parent()
        .ok_or_else(|| IpcError::invalid_argument("file has no parent dir"))?;
    open::that_detached(parent).map_err(|e| {
        IpcError::new("REVEAL_FAILED", format!("could not open {target}: {e}"))
    })?;
    Ok(())
}

fn resolve_asset(
    state: &AppState,
    file: &str,
    _asset: AssetKind,
) -> IpcResult<std::path::PathBuf> {
    // Asset refs are project-relative (catalog entries are bare, e.g.
    // `model.step`), so they resolve under the open project's dir. Track C
    // treats source/output/artifact identically — they all live there; the
    // asset kind is preserved on the IPC surface for the Python sidecar
    // pipeline to disambiguate later.
    let id = state
        .active_project()
        .ok_or_else(|| IpcError::new("NO_ACTIVE_PROJECT", "no project is open"))?;
    paths::resolve_in_project(&id, file).map_err(IpcError::invalid_argument)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state_with_active(id: &str) -> AppState {
        let state = AppState::new();
        state.set_active_project(Some(id.to_string()));
        state
    }

    #[test]
    fn rejects_path_escape() {
        let state = state_with_active("proj");
        let err = resolve_asset(&state, "../etc/passwd", AssetKind::Output).unwrap_err();
        assert_eq!(err.code, "INVALID_ARGUMENT");
    }

    #[test]
    fn errors_when_no_project_open() {
        let state = AppState::new();
        let err = resolve_asset(&state, "model.step", AssetKind::Output).unwrap_err();
        assert_eq!(err.code, "NO_ACTIVE_PROJECT");
    }

    #[test]
    fn resolves_bare_path_under_active_project() {
        let state = state_with_active("proj");
        let resolved = resolve_asset(&state, "model.step", AssetKind::Output).unwrap();
        assert!(resolved.ends_with("proj/model.step"));
    }
}

