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

use crate::commands::chat::session_id_for_project;
use crate::commands::claude_driver;
use crate::ipc::types::{SnapshotRestore, SnapshotSummary};
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

/// Where a snapshot stores its captured chat transcript. Deliberately a *sibling*
/// of the snapshot's model dir (`<id>.session.jsonl`, not `<id>/session.jsonl`)
/// so [`restore_scope`] — which copies the whole `<id>/` dir back into the
/// project — never lands the transcript among the model files. The live
/// transcript belongs under `~/.claude`, not in the project.
fn session_snapshot_path(project: &Path, snapshot_id: &str) -> PathBuf {
    snapshots_dir(project).join(format!("{snapshot_id}.session.jsonl"))
}

/// Absolute path of the live Claude Code session transcript for `project_id`
/// (`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`, outside the project dir).
/// `None` only when the home dir can't be resolved.
fn live_session_path(project_id: &str) -> Option<PathBuf> {
    let session_id = session_id_for_project(project_id).to_string();
    claude_driver::session_jsonl_path(&project_dir(project_id), &session_id)
}

/// Overwrite the live Claude session with `saved`, rewinding the conversation to
/// the snapshot point. Split from path resolution so it's unit-testable. Returns
/// false (caller falls back to the linear marker) when the copy can't happen.
fn rewind_session_to(saved: &Path, live: &Path) -> bool {
    if !saved.exists() {
        return false;
    }
    if let Some(parent) = live.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    std::fs::copy(saved, live).is_ok()
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

/// Copy a snapshot file back into the project and stamp it with the current
/// mtime. The stamp matters: `std::fs::copy` preserves the source's mtime (on
/// macOS it clones it outright), but a *restored* file must look freshly written.
/// The catalog cache-busts renderable assets with a `?v=<mtime>-<size>` token
/// (`commands::catalog::versioned_asset_uri`), and the viewer keys its reload
/// trigger, its manifest-signature dedup, and its URL-keyed byte cache off that
/// token. A normal build always writes a fresh (monotonic) mtime; a revert via
/// plain copy resurrects the snapshot's *old* mtime, so the token — and thus the
/// whole manifest signature — can land back on a value the viewer already has
/// cached, leaving the stale mesh on screen even after the catalog refreshes.
/// Stamping `now` makes a revert refresh the viewer exactly like a build does.
/// Best-effort: a touch failure only risks the rare same-bytes revert not
/// repainting.
fn restore_file(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::copy(from, to)?;
    if let Ok(file) = std::fs::OpenOptions::new().write(true).open(to) {
        let _ = file.set_modified(std::time::SystemTime::now());
    }
    Ok(())
}

/// Recursively restore a directory, stamping every file with a fresh mtime
/// (see [`restore_file`]). Used for nested model dirs like `<stem>_parts/`.
fn restore_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            restore_tree(&from, &to)?;
        } else if ty.is_file() {
            restore_file(&from, &to)?;
        }
    }
    Ok(())
}

/// Replace the in-scope entries of `project` with the contents of `snap`.
/// Removes the current in-scope files/dirs first so parts added since the
/// snapshot don't linger, then copies the snapshot back (with fresh mtimes so
/// the viewer reloads — see [`restore_file`]).
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
            restore_tree(&from, &to)?;
        } else if ty.is_file() {
            restore_file(&from, &to)?;
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
    save_snapshot_at(
        &project_dir(&project_id),
        live_session_path(&project_id).as_deref(),
        label,
    )
}

/// Core of [`snapshot_save`], split out from the tauri command and the
/// `project_id` → path mapping so the chat driver can auto-snapshot a finished
/// build directly (it already holds the project dir and session path, not a bare
/// id). `project` is the project dir; `live_session` is the live Claude
/// transcript to capture beside the model (None / missing → the save just can't
/// rewind chat on restore). `label` is trimmed; empty/missing falls back to
/// `Version N`. Synchronous: it only does quick blocking IO.
pub(crate) fn save_snapshot_at(
    project: &Path,
    live_session: Option<&Path>,
    label: Option<String>,
) -> IpcResult<SnapshotSummary> {
    if !project.exists() {
        return Err(IpcError::new(
            "PROJECT_NOT_FOUND",
            format!("no project at {}", project.display()),
        ));
    }
    let mut history = read_history(project);
    let label = label
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("Version {}", history.snapshots.len() + 1));
    let id = Uuid::new_v4().to_string();
    copy_scope(project, &snapshots_dir(project).join(&id)).map_err(IpcError::from)?;
    // Capture the conversation too: the Claude session transcript lives outside
    // the project dir, so snapshot it explicitly alongside the model. Best-effort
    // — a missing/unreadable session just means this save can't rewind the chat
    // on restore (the restore then keeps the chat linear).
    if let Some(live) = live_session {
        if live.exists() {
            let _ = std::fs::copy(live, session_snapshot_path(project, &id));
        }
    }
    let summary = SnapshotSummary {
        id,
        label,
        created_at: Utc::now().timestamp_millis(),
    };
    history.snapshots.push(summary.clone());
    write_history(project, &history)?;
    Ok(summary)
}

/// Revert the model to a saved state. The model files go back, and — when the
/// save captured the chat transcript — the live Claude session is rewound to the
/// snapshot point too (the frontend reloads the chat panel from it). For older
/// saves with no captured transcript, the conversation stays linear and a
/// one-line note is stashed so the next turn tells the model the files went back
/// (the chat panel's "↩ Reverted to …" marker is added by the frontend). The
/// saved state is not consumed — it stays restorable.
#[tauri::command]
pub async fn snapshot_restore(
    project_id: String,
    snapshot_id: String,
    state: State<'_, AppState>,
) -> IpcResult<SnapshotRestore> {
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
    // Bump the catalog revision so every renderable entry's synthesized mesh
    // hash (`${url}#${revision}` in cadCatalogBackendTauri) changes on the next
    // scan — covers assembly part entries whose URLs aren't mtime-versioned, so
    // the whole reverted model repaints, not just the top-level mesh.
    state.bump_revision();
    // Rewind the chat if this save captured it. When it did, the reverted model
    // and conversation are consistent (both at the snapshot point), so the
    // next-turn "files went back" note is unnecessary — and would mislead, since
    // the rewound session never saw the later edits.
    let chat_rewound = live_session_path(&project_id)
        .map(|live| rewind_session_to(&session_snapshot_path(&dir, &snapshot_id), &live))
        .unwrap_or(false);
    if !chat_rewound {
        state.set_pending_revert_note(&project_id, &summary.label);
    }
    Ok(SnapshotRestore {
        summary,
        chat_rewound,
    })
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
    // Drop the captured chat transcript sibling too, if this save had one.
    let _ = std::fs::remove_file(session_snapshot_path(&dir, &snapshot_id));
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
    fn restore_stamps_fresh_mtime_so_the_viewer_reloads() {
        use std::time::{Duration, SystemTime};
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("proj");
        let snap = tmp.path().join("snap");

        // A snapshot whose model.stl carries an OLD mtime — exactly what
        // `std::fs::copy` preserves from the save (it clones the mtime on macOS).
        write(&snap.join("model.stl"), "solid v1");
        let old = SystemTime::now() - Duration::from_secs(3600);
        std::fs::OpenOptions::new()
            .write(true)
            .open(snap.join("model.stl"))
            .unwrap()
            .set_modified(old)
            .unwrap();

        // The working tree currently shows a different (newer) model.
        write(&dir.join("model.stl"), "solid v2");

        let before = SystemTime::now() - Duration::from_secs(5);
        restore_scope(&dir, &snap).unwrap();

        // Content reverts...
        assert_eq!(std::fs::read_to_string(dir.join("model.stl")).unwrap(), "solid v1");
        // ...and the restored file is stamped ~now, NOT the snapshot's old mtime,
        // so the catalog's `?v=<mtime>-<size>` token changes and the viewer
        // reloads the reverted mesh instead of keeping the stale one.
        let restored = std::fs::metadata(dir.join("model.stl"))
            .unwrap()
            .modified()
            .unwrap();
        assert!(
            restored > before,
            "restored mtime should be fresh (≈now), not the snapshot's preserved old mtime"
        );
    }

    #[test]
    fn restore_never_lands_the_captured_session_among_model_files() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("proj");
        write(&project.join("main.py"), "current");
        // A snapshot: model dir under `.panda/snapshots/<id>/` plus a sibling
        // transcript `.panda/snapshots/<id>.session.jsonl`.
        let id = "snap1";
        write(&snapshots_dir(&project).join(id).join("main.py"), "v1");
        write(&session_snapshot_path(&project, id), r#"{"transcript":true}"#);

        restore_scope(&project, &snapshots_dir(&project).join(id)).unwrap();

        assert_eq!(std::fs::read_to_string(project.join("main.py")).unwrap(), "v1");
        // The transcript is a sibling of the model dir (not inside it), so a
        // restore never copies it into the project as a stray file.
        assert!(!project.join("session.jsonl").exists());
        assert!(!project.join("snap1.session.jsonl").exists());
    }

    #[test]
    fn rewind_session_overwrites_live_only_when_captured() {
        let tmp = tempfile::tempdir().unwrap();
        // Mimic the live session living a few dirs deep under a fake ~/.claude.
        let live = tmp.path().join("home/.claude/projects/enc/uuid.jsonl");
        write(&live, "later conversation");
        let saved = tmp.path().join("saved.session.jsonl");

        // No captured transcript (older save) → linear fallback, live untouched.
        assert!(!rewind_session_to(&saved, &live));
        assert_eq!(std::fs::read_to_string(&live).unwrap(), "later conversation");

        // Captured transcript → rewinds the live session back to it.
        write(&saved, "snapshot conversation");
        assert!(rewind_session_to(&saved, &live));
        assert_eq!(std::fs::read_to_string(&live).unwrap(), "snapshot conversation");
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
    fn save_snapshot_at_auto_labels_and_captures_session() {
        let tmp = tempfile::tempdir().unwrap();
        let project = scaffold_project(tmp.path());
        // A live session transcript living outside the project dir, like the real
        // `~/.claude/projects/<enc>/<uuid>.jsonl`.
        let live = tmp.path().join("home/.claude/projects/enc/uuid.jsonl");
        write(&live, r#"{"transcript":true}"#);

        // Two back-to-back auto-saves (label omitted) increment "Version N" and
        // each captures the session transcript beside its model dir.
        let v1 = save_snapshot_at(&project, Some(&live), None).unwrap();
        let v2 = save_snapshot_at(&project, Some(&live), None).unwrap();
        assert_eq!(v1.label, "Version 1");
        assert_eq!(v2.label, "Version 2");

        let history = read_history(&project);
        assert_eq!(history.snapshots.len(), 2);
        // Model files copied into the snapshot, transcript captured as a sibling.
        assert!(snapshots_dir(&project).join(&v2.id).join("main.py").is_file());
        assert!(session_snapshot_path(&project, &v2.id).is_file());
        assert_eq!(
            std::fs::read_to_string(session_snapshot_path(&project, &v2.id)).unwrap(),
            r#"{"transcript":true}"#
        );
    }

    #[test]
    fn save_snapshot_at_without_session_still_saves_model() {
        let tmp = tempfile::tempdir().unwrap();
        let project = scaffold_project(tmp.path());
        let missing = tmp.path().join("nope.jsonl");

        // No live transcript (e.g. an unreadable session) → the model still saves;
        // the restore just can't rewind chat (no sibling transcript written).
        let v1 = save_snapshot_at(&project, Some(&missing), None).unwrap();
        assert_eq!(v1.label, "Version 1");
        assert!(snapshots_dir(&project).join(&v1.id).join("main.py").is_file());
        assert!(!session_snapshot_path(&project, &v1.id).exists());
    }

    #[test]
    fn save_snapshot_at_rejects_missing_project() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("does-not-exist");
        let err = save_snapshot_at(&missing, None, None).unwrap_err();
        assert_eq!(err.code, "PROJECT_NOT_FOUND");
    }

    #[test]
    fn validate_id_rejects_escape() {
        assert!(validate_id("../etc").is_err());
        assert!(validate_id("a/b").is_err());
        assert!(validate_id("  ").is_err());
        assert!(validate_id("a-normal-uuid").is_ok());
    }
}
