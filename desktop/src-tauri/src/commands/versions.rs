//! Version control for a project's model: checkpoints + branching.
//!
//! A **checkpoint** is an immutable snapshot of the project's working files
//! *and* the Claude conversation that produced them, auto-created after each
//! successful build turn (see the hook in [`crate::commands::claude_driver`]).
//! Checkpoints form a **tree** via `parent_id`: restoring an older checkpoint
//! and building again forks the history, which is the "try several approaches,
//! keep one" workflow a 3D designer expects.
//!
//! Everything lives under the project's `.panda/` dir (already excluded from
//! catalog scans), so it never surfaces as a model file:
//!
//! ```text
//! <project>/.panda/
//!   history.json                  # the tree + HEAD + current session id
//!   checkpoints/<id>/
//!     files/  model.py, model.step, model.stl, ...   # working-tree snapshot
//!     session.jsonl                                  # Claude transcript at this turn
//! ```
//!
//! ### Branching over Claude Code sessions
//!
//! Claude Code sessions are append-only JSONL files; Panda used one
//! deterministic session per project ([`crate::commands::chat::session_id_for_project`]),
//! so the conversation was a single line. To branch, we stop deriving the
//! per-turn session from the project and instead read the **current** session
//! id from `history.json`. Restoring checkpoint `C` mints a *new* session id and
//! seeds it from `C`'s `session.jsonl` snapshot (validated: copying a session
//! JSONL to a new id and `--resume`ing it preserves full context). The next
//! build then writes a checkpoint whose parent is `C` — a real fork.

use crate::commands::claude_driver;
use crate::ipc::types::{CheckpointInfo, RestoreVersionRequest};
use crate::ipc::{IpcError, IpcResult};
use crate::paths;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::Path;
use tauri::State;
use uuid::Uuid;
use walkdir::{DirEntry, WalkDir};

/// Dir names never copied into a checkpoint snapshot (build junk + our own
/// store). Mirrors the spirit of `catalog::SKIPPED_DIRECTORIES`; `.panda` is the
/// critical one (copying it would recurse into prior checkpoints).
const EXCLUDED_DIRS: &[&str] = &[
    ".panda",
    ".git",
    ".cache",
    ".venv",
    ".viewer",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "venv",
];

/// Persisted contents of `.panda/history.json`: the checkpoint tree plus the
/// two moving pointers — `head` (the checkpoint the working tree currently
/// reflects) and `current_session_id` (the Claude session the next turn
/// resumes).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionHistory {
    head: Option<String>,
    current_session_id: Option<String>,
    #[serde(default)]
    checkpoints: Vec<CheckpointInfo>,
}

fn panda_dir(workspace: &Path) -> std::path::PathBuf {
    workspace.join(".panda")
}

fn history_path(workspace: &Path) -> std::path::PathBuf {
    panda_dir(workspace).join("history.json")
}

fn checkpoint_dir(workspace: &Path, id: &str) -> std::path::PathBuf {
    panda_dir(workspace).join("checkpoints").join(id)
}

fn read_history(workspace: &Path) -> io::Result<Option<VersionHistory>> {
    match fs::read(history_path(workspace)) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn write_history(workspace: &Path, history: &VersionHistory) -> io::Result<()> {
    let dir = panda_dir(workspace);
    fs::create_dir_all(&dir)?;
    let bytes = serde_json::to_vec_pretty(history)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    // Atomic-ish: write a temp sibling then rename over the target.
    let tmp = dir.join("history.json.tmp");
    fs::write(&tmp, &bytes)?;
    fs::rename(&tmp, history_path(workspace))
}

/// The Claude session id the next turn should resume for `workspace`. Reads
/// `current_session_id` from `history.json`; falls back to `fallback` (the
/// caller's deterministic per-project id) for projects that predate version
/// history. The persisted id only diverges from the fallback after a restore.
pub fn current_session_id(workspace: &Path, fallback: Uuid) -> Uuid {
    read_history(workspace)
        .ok()
        .flatten()
        .and_then(|h| h.current_session_id)
        .and_then(|s| Uuid::parse_str(&s).ok())
        .unwrap_or(fallback)
}

fn is_excluded_dir(entry: &DirEntry) -> bool {
    entry.file_type().is_dir()
        && entry
            .file_name()
            .to_str()
            .map(|n| EXCLUDED_DIRS.contains(&n))
            .unwrap_or(false)
}

/// Copy every regular file under `workspace` (minus [`EXCLUDED_DIRS`]) into
/// `dest`, returning the workspace-relative POSIX paths copied.
fn snapshot_files(workspace: &Path, dest: &Path) -> io::Result<Vec<String>> {
    let mut copied = Vec::new();
    for entry in WalkDir::new(workspace)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_excluded_dir(e))
    {
        let entry = entry.map_err(io::Error::other)?;
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = match entry.path().strip_prefix(workspace) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let target = dest.join(rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(entry.path(), &target)?;
        copied.push(rel.to_string_lossy().replace('\\', "/"));
    }
    copied.sort();
    Ok(copied)
}

/// Copy a checkpoint's `files/` snapshot back into `workspace`.
fn restore_files(snapshot: &Path, workspace: &Path) -> io::Result<()> {
    for entry in WalkDir::new(snapshot).follow_links(false) {
        let entry = entry.map_err(io::Error::other)?;
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = match entry.path().strip_prefix(snapshot) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let target = workspace.join(rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(entry.path(), &target)?;
    }
    Ok(())
}

/// Remove everything in `workspace` except the `.panda` store, so a restore
/// lands an exact copy of the checkpoint (no leftover files from later turns).
/// Safe because the working tree always corresponds to a checkpoint snapshot.
fn clear_workspace(workspace: &Path) -> io::Result<()> {
    for entry in fs::read_dir(workspace)? {
        let entry = entry?;
        if entry.file_name() == ".panda" {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            fs::remove_dir_all(&path)?;
        } else {
            fs::remove_file(&path)?;
        }
    }
    Ok(())
}

/// One-line label for a checkpoint, derived from the turn's prompt. Build turns
/// receive a synthetic "The plan below is approved…" preamble followed by the
/// plan text — strip it so the label reflects the actual change.
fn derive_title(prompt: &str) -> String {
    let body = match prompt.split_once("\n\n") {
        Some((head, rest)) if head.starts_with("The plan below is approved") => rest,
        _ => prompt,
    };
    let line = body.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    // Drop a leading markdown heading marker for a cleaner label.
    let line = line.trim_start_matches('#').trim();
    let mut title: String = line.chars().take(60).collect();
    if line.chars().count() > 60 {
        title.push('…');
    }
    if title.is_empty() {
        "Checkpoint".to_string()
    } else {
        title
    }
}

/// Snapshot the working tree + session transcript as a new checkpoint, appended
/// as a child of the current HEAD. Returns the new checkpoint id, or `None` if
/// there were no files to snapshot. Best-effort on the session copy (a missing
/// transcript just yields a checkpoint that can't fork its conversation).
pub fn create_checkpoint(
    workspace: &Path,
    session_id: &str,
    turn_id: &str,
    prompt: &str,
) -> io::Result<Option<String>> {
    let id = Uuid::new_v4().to_string();
    let cp_dir = checkpoint_dir(workspace, &id);
    let files_dir = cp_dir.join("files");
    fs::create_dir_all(&files_dir)?;

    let artifacts = snapshot_files(workspace, &files_dir)?;
    if artifacts.is_empty() {
        // Nothing was produced — don't litter an empty checkpoint.
        let _ = fs::remove_dir_all(&cp_dir);
        return Ok(None);
    }

    // Snapshot the Claude transcript as-of this turn (best-effort).
    if let Some(src) = claude_driver::session_jsonl_path(workspace, session_id) {
        if src.exists() {
            let _ = fs::copy(&src, cp_dir.join("session.jsonl"));
        }
    }

    let mut history = read_history(workspace)?.unwrap_or_default();
    let node = CheckpointInfo {
        id: id.clone(),
        parent_id: history.head.clone(),
        turn_id: turn_id.to_string(),
        session_id: session_id.to_string(),
        created_at: chrono::Utc::now().timestamp_millis(),
        title: derive_title(prompt),
        prompt: prompt.to_string(),
        artifacts,
    };
    history.checkpoints.push(node);
    history.head = Some(id.clone());
    if history.current_session_id.is_none() {
        history.current_session_id = Some(session_id.to_string());
    }
    write_history(workspace, &history)?;
    Ok(Some(id))
}

/// Restore the working tree to checkpoint `checkpoint_id` and fork the
/// conversation: mint a fresh session id seeded from the checkpoint's transcript
/// snapshot, and move HEAD to the checkpoint. A subsequent build then forks the
/// tree (its checkpoint's parent is `checkpoint_id`).
pub fn restore_checkpoint(workspace: &Path, checkpoint_id: &str) -> io::Result<()> {
    let mut history = read_history(workspace)?
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no version history"))?;
    if !history.checkpoints.iter().any(|c| c.id == checkpoint_id) {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("unknown checkpoint {checkpoint_id}"),
        ));
    }
    let cp_dir = checkpoint_dir(workspace, checkpoint_id);
    let files_dir = cp_dir.join("files");
    if !files_dir.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "checkpoint snapshot missing",
        ));
    }

    // 1. Working files → exact copy of the checkpoint.
    clear_workspace(workspace)?;
    restore_files(&files_dir, workspace)?;

    // 2. Fork the session: a new id, seeded from this checkpoint's transcript.
    let new_session = Uuid::new_v4().to_string();
    let snapshot_jsonl = cp_dir.join("session.jsonl");
    if snapshot_jsonl.exists() {
        if let Some(dest) = claude_driver::session_jsonl_path(workspace, &new_session) {
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&snapshot_jsonl, &dest)?;
        }
    }

    // 3. Move the pointers.
    history.head = Some(checkpoint_id.to_string());
    history.current_session_id = Some(new_session);
    write_history(workspace, &history)
}

fn list_checkpoints(workspace: &Path) -> Vec<CheckpointInfo> {
    read_history(workspace)
        .ok()
        .flatten()
        .map(|h| h.checkpoints)
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// IPC commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn versions_list(project_id: String) -> IpcResult<Vec<CheckpointInfo>> {
    Ok(list_checkpoints(&paths::project_root(&project_id)))
}

#[tauri::command]
pub async fn version_restore(
    req: RestoreVersionRequest,
    state: State<'_, AppState>,
) -> IpcResult<()> {
    let workspace = paths::project_root(&req.project_id);
    restore_checkpoint(&workspace, &req.checkpoint_id)
        .map_err(|e| IpcError::new("VERSION_RESTORE_FAILED", e.to_string()))?;
    // Nudge the catalog so the viewer re-reads (the restored mesh files also
    // carry fresh mtimes → fresh asset URLs → re-render; see catalog.rs).
    state.bump_revision();
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn write(workspace: &Path, rel: &str, contents: &[u8]) {
        let p = workspace.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, contents).unwrap();
    }

    #[test]
    fn create_checkpoint_snapshots_files_and_sets_head() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        write(ws, "model.py", b"box()");
        write(ws, "model.stl", b"solid");

        let id = create_checkpoint(ws, "sess-1", "turn-1", "make a box")
            .unwrap()
            .expect("checkpoint created");

        let list = list_checkpoints(ws);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, id);
        assert_eq!(list[0].parent_id, None);
        assert_eq!(list[0].title, "make a box");
        assert!(list[0].artifacts.contains(&"model.py".to_string()));
        assert!(list[0].artifacts.contains(&"model.stl".to_string()));
        // Snapshot bytes exist on disk.
        assert!(checkpoint_dir(ws, &id).join("files/model.py").exists());
    }

    #[test]
    fn empty_workspace_makes_no_checkpoint() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(create_checkpoint(tmp.path(), "s", "t", "p").unwrap(), None);
        assert!(list_checkpoints(tmp.path()).is_empty());
    }

    #[test]
    fn checkpoints_chain_parent_to_child() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        write(ws, "model.py", b"v1");
        let a = create_checkpoint(ws, "s", "t1", "first").unwrap().unwrap();
        write(ws, "model.py", b"v2");
        let b = create_checkpoint(ws, "s", "t2", "second").unwrap().unwrap();

        let list = list_checkpoints(ws);
        assert_eq!(list.len(), 2);
        let bn = list.iter().find(|c| c.id == b).unwrap();
        assert_eq!(bn.parent_id.as_deref(), Some(a.as_str()));
    }

    #[test]
    fn restore_reverts_files_and_forks_history() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        write(ws, "model.py", b"vA");
        write(ws, "model.stl", b"A");
        let a = create_checkpoint(ws, "s", "t1", "approach A").unwrap().unwrap();

        // Move on to B (different geometry).
        write(ws, "model.py", b"vB");
        write(ws, "model.stl", b"B");
        let _b = create_checkpoint(ws, "s", "t2", "approach B").unwrap().unwrap();

        // "Start from here" on A.
        restore_checkpoint(ws, &a).unwrap();
        assert_eq!(fs::read(ws.join("model.py")).unwrap(), b"vA");
        assert_eq!(fs::read(ws.join("model.stl")).unwrap(), b"A");

        // Session id forked away from the deterministic fallback.
        let forked = current_session_id(ws, Uuid::nil());
        assert_ne!(forked, Uuid::nil(), "restore must set a current session id");

        // Build again from A → forks the tree (C.parent == A).
        write(ws, "model.py", b"vC");
        let c = create_checkpoint(ws, &forked.to_string(), "t3", "approach C")
            .unwrap()
            .unwrap();
        let list = list_checkpoints(ws);
        let cn = list.iter().find(|c2| c2.id == c).unwrap();
        assert_eq!(cn.parent_id.as_deref(), Some(a.as_str()), "C must fork from A");
        // A now has two children (B and C).
        let a_children = list.iter().filter(|c2| c2.parent_id.as_deref() == Some(a.as_str())).count();
        assert_eq!(a_children, 2, "A is a fork point");
    }

    #[test]
    fn restore_clears_files_added_after_the_checkpoint() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        write(ws, "model.py", b"v1");
        let a = create_checkpoint(ws, "s", "t1", "first").unwrap().unwrap();
        write(ws, "extra.py", b"added later");
        let _b = create_checkpoint(ws, "s", "t2", "second").unwrap().unwrap();

        restore_checkpoint(ws, &a).unwrap();
        assert!(ws.join("model.py").exists());
        assert!(!ws.join("extra.py").exists(), "files added after A must be gone");
    }

    #[test]
    fn current_session_id_falls_back_without_history() {
        let tmp = tempfile::tempdir().unwrap();
        let fb = Uuid::new_v4();
        assert_eq!(current_session_id(tmp.path(), fb), fb);
    }

    #[test]
    fn derive_title_strips_approve_preamble_and_heading() {
        let prompt = "The plan below is approved. Implement it now, generating all parts.\n\n# Remove the bottom holes\n\nDetails follow.";
        assert_eq!(derive_title(prompt), "Remove the bottom holes");
        assert_eq!(derive_title("make a phone stand"), "make a phone stand");
    }
}
