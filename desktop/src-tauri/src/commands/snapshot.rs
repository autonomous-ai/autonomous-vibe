//! `snapshot_*` IPC commands — git-tag-style model save states.
//!
//! A snapshot copies the CAD-defining files of a project (Python source +
//! generated artifacts) into `<project>/.panda/snapshots/<id>/`, indexed by
//! `<project>/.panda/history.json`. `snapshot_restore` reverts those files and
//! stashes a one-line note in [`AppState`] so the *next* chat turn tells the
//! model the files went back — without forking the append-only Claude session.
//! This is the "linear undo marker" design from
//! `docs/future-work-version-control.md`: model versions are restorable, the
//! conversation stays linear.
//!
//! `.panda/` is already excluded from catalog scans (`commands::catalog`), so a
//! project's snapshots never surface as CAD parts in the Models rail.

use crate::ipc::types::SnapshotSummary;
use crate::ipc::{IpcError, IpcResult};
use crate::paths;
use crate::state::AppState;
use chrono::Utc;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use tauri::State;
use uuid::Uuid;

/// Project-root entries a snapshot never copies or restores:
/// - `.panda` — the snapshot store itself (recursion / self-overwrite guard),
/// - `.claude` — Claude Code's per-project settings,
/// - `.git` — never touch a VCS dir if one exists,
/// - `project.json` — so a revert never changes the project name/timestamps,
/// - `inputs` — user-attached reference images, kept stable so earlier chat
///   turns that point at them still resolve after a revert.
///
/// Everything else (`main.py`, `params.py`, `parts/`, `model.step`,
/// `model.stl`, `model_parts/`, …) is the model and is snapshotted.
const SNAPSHOT_EXCLUDE: &[&str] = &[".panda", ".claude", ".git", "project.json", "inputs"];

fn project_dir(id: &str) -> PathBuf {
    paths::projects_root().join(id)
}

fn panda_dir(project: &Path) -> PathBuf {
    project.join(".panda")
}

fn snapshots_dir(project: &Path) -> PathBuf {
    panda_dir(project).join("snapshots")
}

fn history_path(project: &Path) -> PathBuf {
    panda_dir(project).join("history.json")
}

/// Reject a path-component id that could escape the snapshots dir. Mirrors
/// `commands::project::validate_id` (kept local to avoid a public dependency).
fn validate_id(id: &str) -> IpcResult<()> {
    if id.trim().is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        Err(IpcError::invalid_argument("invalid id"))
    } else {
        Ok(())
    }
}

/// The on-disk index. `serde` camelCases `SnapshotSummary` (`createdAt`) the
/// same in `history.json` as on the wire — fine, it's a private file.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct SnapshotHistory {
    #[serde(default)]
    snapshots: Vec<SnapshotSummary>,
}

/// Read the index, tolerating a missing/corrupt file as "no snapshots yet".
fn read_history(project: &Path) -> SnapshotHistory {
    match std::fs::read(history_path(project)) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => SnapshotHistory::default(),
    }
}

fn write_history(project: &Path, history: &SnapshotHistory) -> IpcResult<()> {
    std::fs::create_dir_all(panda_dir(project)).map_err(IpcError::from)?;
    let bytes = serde_json::to_vec_pretty(history).map_err(IpcError::from)?;
    std::fs::write(history_path(project), bytes).map_err(IpcError::from)?;
    Ok(())
}

fn is_excluded(name: &OsStr) -> bool {
    name.to_str().is_some_and(|n| SNAPSHOT_EXCLUDE.contains(&n))
}

/// Recursively copy a directory tree (files + subdirs). Symlinks are skipped —
/// snapshots hold plain data, and following a link could escape the project.
fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_tree(&from, &to)?;
        } else if ty.is_file() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Copy the in-scope entries of `project` (all but [`SNAPSHOT_EXCLUDE`]) into
/// `dst`.
fn copy_scope(project: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(project)? {
        let entry = entry?;
        if is_excluded(&entry.file_name()) {
            continue;
        }
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_tree(&from, &to)?;
        } else if ty.is_file() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Replace the in-scope entries of `project` with the contents of `snap`.
/// Removes the current in-scope files/dirs first so parts added since the
/// snapshot don't linger, then copies the snapshot back.
fn restore_scope(project: &Path, snap: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(project)? {
        let entry = entry?;
        if is_excluded(&entry.file_name()) {
            continue;
        }
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            std::fs::remove_dir_all(&path)?;
        } else {
            std::fs::remove_file(&path)?;
        }
    }
    for entry in std::fs::read_dir(snap)? {
        let entry = entry?;
        let from = entry.path();
        let to = project.join(entry.file_name());
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_tree(&from, &to)?;
        } else if ty.is_file() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// List a project's saved states, newest first.
#[tauri::command]
pub async fn snapshot_list(project_id: String) -> IpcResult<Vec<SnapshotSummary>> {
    validate_id(&project_id)?;
    let mut snapshots = read_history(&project_dir(&project_id)).snapshots;
    snapshots.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(snapshots)
}

/// Save the current model as a new snapshot. `label` is optional; an empty or
/// missing one falls back to `Version N`.
#[tauri::command]
pub async fn snapshot_save(
    project_id: String,
    label: Option<String>,
) -> IpcResult<SnapshotSummary> {
    validate_id(&project_id)?;
    let dir = project_dir(&project_id);
    if !dir.exists() {
        return Err(IpcError::new(
            "PROJECT_NOT_FOUND",
            format!("no project {project_id}"),
        ));
    }
    let mut history = read_history(&dir);
    let label = label
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("Version {}", history.snapshots.len() + 1));
    let id = Uuid::new_v4().to_string();
    copy_scope(&dir, &snapshots_dir(&dir).join(&id)).map_err(IpcError::from)?;
    let summary = SnapshotSummary {
        id,
        label,
        created_at: Utc::now().timestamp_millis(),
    };
    history.snapshots.push(summary.clone());
    write_history(&dir, &history)?;
    Ok(summary)
}

/// Revert the model to a saved state. The model files go back; a one-line note
/// is stashed so the next chat turn tells the model what happened (the chat
/// panel's own "↩ Reverted to …" marker is added by the frontend). The saved
/// state is not consumed — it stays restorable.
#[tauri::command]
pub async fn snapshot_restore(
    project_id: String,
    snapshot_id: String,
    state: State<'_, AppState>,
) -> IpcResult<SnapshotSummary> {
    validate_id(&project_id)?;
    validate_id(&snapshot_id)?;
    let dir = project_dir(&project_id);
    let summary = read_history(&dir)
        .snapshots
        .into_iter()
        .find(|s| s.id == snapshot_id)
        .ok_or_else(|| {
            IpcError::new("SNAPSHOT_NOT_FOUND", format!("no snapshot {snapshot_id}"))
        })?;
    let snap = snapshots_dir(&dir).join(&snapshot_id);
    if !snap.exists() {
        return Err(IpcError::new(
            "SNAPSHOT_NOT_FOUND",
            format!("snapshot {snapshot_id} has no files"),
        ));
    }
    restore_scope(&dir, &snap).map_err(IpcError::from)?;
    state.set_pending_revert_note(&project_id, &summary.label);
    Ok(summary)
}

/// Delete a saved state (its files and index entry). Idempotent — a missing
/// snapshot is a no-op.
#[tauri::command]
pub async fn snapshot_delete(project_id: String, snapshot_id: String) -> IpcResult<()> {
    validate_id(&project_id)?;
    validate_id(&snapshot_id)?;
    let dir = project_dir(&project_id);
    let mut history = read_history(&dir);
    let before = history.snapshots.len();
    history.snapshots.retain(|s| s.id != snapshot_id);
    if history.snapshots.len() != before {
        write_history(&dir, &history)?;
    }
    let snap = snapshots_dir(&dir).join(&snapshot_id);
    if snap.exists() {
        std::fs::remove_dir_all(&snap).map_err(IpcError::from)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }

    /// Lay out a project under a temp "projects root" so the scope helpers can
    /// run without the real app-data dir. Returns the project dir.
    fn scaffold_project(root: &Path) -> PathBuf {
        let dir = root.join("proj");
        write(&dir.join("main.py"), "v1 source");
        write(&dir.join("model.step"), "v1 step");
        write(&dir.join("parts/base.py"), "v1 base");
        write(&dir.join("project.json"), r#"{"name":"X","createdAt":1,"updatedAt":1}"#);
        write(&dir.join("inputs/ref.png"), "img");
        dir
    }

    #[test]
    fn copy_then_restore_round_trips_model_and_skips_excluded() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = scaffold_project(tmp.path());
        let snap = tmp.path().join("snap");

        copy_scope(&dir, &snap).unwrap();
        // Excluded dirs/files are never copied into the snapshot.
        assert!(snap.join("main.py").is_file());
        assert!(snap.join("parts/base.py").is_file());
        assert!(!snap.join("project.json").exists());
        assert!(!snap.join("inputs").exists());

        // Mutate the working tree: edit source, add a new part, drop the step.
        write(&dir.join("main.py"), "v2 source");
        write(&dir.join("parts/extra.py"), "added later");
        std::fs::remove_file(dir.join("model.step")).unwrap();

        restore_scope(&dir, &snap).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("main.py")).unwrap(), "v1 source");
        assert_eq!(std::fs::read_to_string(dir.join("model.step")).unwrap(), "v1 step");
        // A part added after the snapshot is removed on restore.
        assert!(!dir.join("parts/extra.py").exists());
        // Excluded entries survive the restore untouched.
        assert!(dir.join("project.json").is_file());
        assert!(dir.join("inputs/ref.png").is_file());
    }

    #[test]
    fn history_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("p");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(read_history(&dir).snapshots.is_empty());

        let mut h = SnapshotHistory::default();
        h.snapshots.push(SnapshotSummary {
            id: "a".into(),
            label: "Version 1".into(),
            created_at: 10,
        });
        write_history(&dir, &h).unwrap();

        let back = read_history(&dir);
        assert_eq!(back.snapshots.len(), 1);
        assert_eq!(back.snapshots[0].label, "Version 1");
    }

    #[test]
    fn validate_id_rejects_escape() {
        assert!(validate_id("../etc").is_err());
        assert!(validate_id("a/b").is_err());
        assert!(validate_id("  ").is_err());
        assert!(validate_id("a-normal-uuid").is_ok());
    }
}
