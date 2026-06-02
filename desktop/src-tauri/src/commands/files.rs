//! `file_read_bytes` + `file_reveal` IPC commands.

use crate::ipc::types::AssetKind;
use crate::ipc::{IpcError, IpcResult};
use crate::paths;
use crate::state::AppState;
use std::path::PathBuf;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn file_read_bytes(
    file: String,
    asset: AssetKind,
    state: State<'_, AppState>,
) -> IpcResult<Vec<u8>> {
    let resolved = resolve_asset(&state, &file, asset)?;
    tokio::fs::read(&resolved).await.map_err(IpcError::from)
}

/// Save (copy) a project file to a user-chosen location via the native
/// "Save As" dialog. Artifacts already live on the user's disk, so a download
/// is just a local-to-local copy: pick a destination, copy the bytes. We never
/// touch the source, and the OS dialog handles any overwrite confirmation.
///
/// Returns the chosen destination path, or `None` if the user cancelled.
#[tauri::command]
pub async fn file_save(
    app: tauri::AppHandle,
    file: String,
    asset: AssetKind,
    state: State<'_, AppState>,
) -> IpcResult<Option<String>> {
    let source = prepare_save_source(&state, &file, asset)?;

    // `blocking_save_file` parks the calling thread until the user responds,
    // so run it on the blocking pool rather than an async-runtime worker.
    let default_name = source.default_name.clone();
    let extension = source.extension.clone();
    let dialog_app = app.clone();
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = dialog_app.dialog().file().set_file_name(default_name);
        if let Some(ext) = extension.as_deref() {
            builder = builder.add_filter(ext.to_uppercase(), &[ext]);
        }
        builder.blocking_save_file()
    })
    .await
    .map_err(|e| IpcError::new("SAVE_FAILED", format!("save dialog failed: {e}")))?;

    let Some(destination) = chosen else {
        return Ok(None); // user cancelled
    };
    let destination = destination
        .into_path()
        .map_err(|e| IpcError::new("SAVE_FAILED", format!("invalid destination: {e}")))?;

    tokio::fs::copy(&source.path, &destination)
        .await
        .map_err(IpcError::from)?;

    Ok(Some(destination.display().to_string()))
}

#[derive(Debug)]
struct SaveSource {
    path: PathBuf,
    default_name: String,
    extension: Option<String>,
}

fn prepare_save_source(state: &AppState, file: &str, asset: AssetKind) -> IpcResult<SaveSource> {
    validate_save_source(resolve_asset(state, file, asset)?)
}

fn validate_save_source(path: PathBuf) -> IpcResult<SaveSource> {
    if !path.is_file() {
        return Err(IpcError::new(
            "FILE_NOT_FOUND",
            format!("file does not exist: {}", path.display()),
        ));
    }
    let default_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("download")
        .to_string();
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_string());
    Ok(SaveSource {
        path,
        default_name,
        extension,
    })
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

    #[test]
    fn prepare_save_source_rejects_path_escape() {
        // The Save As path must be as locked-down as the read path: no
        // traversal out of the open project.
        let state = state_with_active("proj");
        let err = prepare_save_source(&state, "../secrets.key", AssetKind::Output).unwrap_err();
        assert_eq!(err.code, "INVALID_ARGUMENT");
    }

    #[test]
    fn validate_save_source_derives_name_and_extension() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("dome.stl");
        std::fs::write(&file, b"solid").unwrap();

        let source = validate_save_source(file.clone()).unwrap();
        assert_eq!(source.path, file);
        assert_eq!(source.default_name, "dome.stl");
        assert_eq!(source.extension.as_deref(), Some("stl"));
    }

    #[test]
    fn validate_save_source_errors_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let err = validate_save_source(dir.path().join("nope.stl")).unwrap_err();
        assert_eq!(err.code, "FILE_NOT_FOUND");
    }
}

