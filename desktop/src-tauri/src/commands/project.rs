//! `project_*` IPC commands — filesystem CRUD over the app data dir.

use crate::ipc::types::{CreateProjectRequest, ProjectOpenResponse, ProjectSummary};
use crate::ipc::{IpcError, IpcResult};
use crate::paths;
use crate::state::AppState;
use crate::commands::chat::session_id_for_project;
use crate::commands::claude_driver::session_jsonl_path;
use chrono::Utc;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::State;
use tokio::fs;
use uuid::Uuid;

/// Name a project carries until Claude Code's AI title is available. The UI
/// never prompts for a name; `read_project_summary` upgrades this in place
/// once the session JSONL contains an `ai-title` line (see `resolve_ai_title`).
pub const PLACEHOLDER_PROJECT_NAME: &str = "New project";

#[tauri::command]
pub async fn project_list() -> IpcResult<Vec<ProjectSummary>> {
    let root = paths::projects_root();
    fs::create_dir_all(&root).await.map_err(IpcError::from)?;
    let mut summaries = list_projects(&root).await?;
    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(summaries)
}

async fn list_projects(root: &Path) -> IpcResult<Vec<ProjectSummary>> {
    let mut summaries: Vec<ProjectSummary> = Vec::new();
    let mut read = fs::read_dir(root).await.map_err(IpcError::from)?;
    while let Some(entry) = read.next_entry().await.map_err(IpcError::from)? {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if let Some(summary) = read_project_summary(&path).await {
            summaries.push(summary);
        }
    }
    Ok(summaries)
}

async fn read_project_summary(dir: &Path) -> Option<ProjectSummary> {
    let meta_path = dir.join("project.json");
    let id = dir.file_name()?.to_string_lossy().into_owned();
    let has_model = dir.join("model.step").exists() || dir.join("model.stl").exists();

    if let Ok(bytes) = fs::read(&meta_path).await {
        if let Ok(parsed) = serde_json::from_slice::<StoredProjectMeta>(&bytes) {
            let effective_id = parsed.id.unwrap_or(id);
            let mut name = parsed.name;
            let mut updated_at = parsed.updated_at;
            // Self-heal: while the project still carries the placeholder (or an
            // empty name), adopt Claude Code's AI title once it lands in the
            // session JSONL, and persist it so we only pay the read once.
            if name.trim().is_empty() || name == PLACEHOLDER_PROJECT_NAME {
                if let Some(title) = resolve_ai_title(dir, &effective_id).await {
                    let now = Utc::now().timestamp_millis();
                    let meta = StoredProjectMeta {
                        id: Some(effective_id.clone()),
                        name: title.clone(),
                        created_at: parsed.created_at,
                        updated_at: now,
                    };
                    if let Ok(bytes) = serde_json::to_vec_pretty(&meta) {
                        let _ = fs::write(&meta_path, bytes).await;
                    }
                    name = title;
                    updated_at = now;
                }
            }
            return Some(ProjectSummary {
                id: effective_id,
                name,
                created_at: parsed.created_at,
                updated_at,
                has_model,
            });
        }
    }
    // Project dir without metadata — synthesize a summary from the
    // directory mtime so the list never silently drops folders.
    let stat = fs::metadata(dir).await.ok()?;
    let updated = stat
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some(ProjectSummary {
        id: id.clone(),
        name: id,
        created_at: updated,
        updated_at: updated,
        has_model,
    })
}

/// Read the most recent AI title Claude Code wrote for this project's session.
///
/// Claude Code appends `{"type":"ai-title","aiTitle":"…"}` lines to the
/// session JSONL as the conversation evolves; the last one wins. Returns
/// `None` on any IO/parse error or when no title has been generated yet — the
/// caller then keeps the placeholder. Read-only.
async fn resolve_ai_title(dir: &Path, project_id: &str) -> Option<String> {
    let session_id = session_id_for_project(project_id).to_string();
    let jsonl = session_jsonl_path(dir, &session_id)?;
    let contents = fs::read_to_string(&jsonl).await.ok()?;
    parse_latest_ai_title(&contents)
}

/// Scan session-JSONL text for the last `ai-title` line's `aiTitle`. Pure so
/// it's unit-testable without the real `~/.claude/projects` path.
fn parse_latest_ai_title(contents: &str) -> Option<String> {
    let mut latest: Option<String> = None;
    for line in contents.lines() {
        // Cheap pre-filter so we only JSON-parse candidate lines.
        if !line.contains("\"ai-title\"") {
            continue;
        }
        if let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(line) {
            if obj.get("type").and_then(Value::as_str) == Some("ai-title") {
                if let Some(title) = obj.get("aiTitle").and_then(Value::as_str) {
                    let trimmed = title.trim();
                    if !trimmed.is_empty() {
                        latest = Some(trimmed.to_string());
                    }
                }
            }
        }
    }
    latest
}

/// Does this project still carry the auto-name placeholder?
///
/// True only when `project.json` exists and its `name` is empty or the
/// [`PLACEHOLDER_PROJECT_NAME`]. A missing or unparseable `project.json`
/// returns false so we never try to title a non-project directory. Read-only.
pub async fn needs_autoname(project_dir: &Path) -> bool {
    let Ok(bytes) = fs::read(project_dir.join("project.json")).await else {
        return false;
    };
    match serde_json::from_slice::<StoredProjectMeta>(&bytes) {
        Ok(meta) => meta.name.trim().is_empty() || meta.name == PLACEHOLDER_PROJECT_NAME,
        Err(_) => false,
    }
}

/// Adopt `title` as the project name, but only while the stored name is still
/// the placeholder (or empty). Re-reads `project.json` under the same check as
/// [`needs_autoname`] so a concurrent rename or a later plan turn can't clobber
/// a real name, then persists `title` and bumps `updated_at` (mirroring the
/// self-heal write in [`read_project_summary`]). Returns whether it wrote.
/// Best-effort: an empty title or any IO/parse error yields `false`.
pub async fn set_name_if_placeholder(project_dir: &Path, title: &str) -> bool {
    let title = title.trim();
    if title.is_empty() {
        return false;
    }
    let meta_path = project_dir.join("project.json");
    let Ok(bytes) = fs::read(&meta_path).await else {
        return false;
    };
    let Ok(parsed) = serde_json::from_slice::<StoredProjectMeta>(&bytes) else {
        return false;
    };
    if !(parsed.name.trim().is_empty() || parsed.name == PLACEHOLDER_PROJECT_NAME) {
        return false;
    }
    let id = parsed
        .id
        .or_else(|| project_dir.file_name().map(|n| n.to_string_lossy().into_owned()));
    let meta = StoredProjectMeta {
        id,
        name: title.to_string(),
        created_at: parsed.created_at,
        updated_at: Utc::now().timestamp_millis(),
    };
    match serde_json::to_vec_pretty(&meta) {
        Ok(bytes) => fs::write(&meta_path, bytes).await.is_ok(),
        Err(_) => false,
    }
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct StoredProjectMeta {
    #[serde(default)]
    id: Option<String>,
    name: String,
    created_at: i64,
    updated_at: i64,
}

/// Filesystem half of `project_create`, factored out so the command can
/// also flip the active project after creating it (and so tests can
/// exercise creation without a Tauri `State`).
async fn create_project(name: &str) -> IpcResult<ProjectSummary> {
    let name = name.trim();
    if name.is_empty() {
        return Err(IpcError::invalid_argument("project name is required"));
    }
    let id = Uuid::new_v4().to_string();
    let dir = project_dir(&id);
    fs::create_dir_all(&dir).await.map_err(IpcError::from)?;
    let now = Utc::now().timestamp_millis();
    let meta = StoredProjectMeta {
        id: Some(id.clone()),
        name: name.to_string(),
        created_at: now,
        updated_at: now,
    };
    let bytes = serde_json::to_vec_pretty(&meta).map_err(IpcError::from)?;
    fs::write(dir.join("project.json"), bytes)
        .await
        .map_err(IpcError::from)?;
    Ok(ProjectSummary {
        id,
        name: name.to_string(),
        created_at: now,
        updated_at: now,
        has_model: false,
    })
}

#[tauri::command]
pub async fn project_create(
    req: CreateProjectRequest,
    state: State<'_, AppState>,
) -> IpcResult<ProjectSummary> {
    let summary = create_project(&req.name).await?;
    // A freshly created project is the one the viewer lands in.
    state.set_active_project(Some(summary.id.clone()));
    Ok(summary)
}

#[tauri::command]
pub async fn project_open(id: String, state: State<'_, AppState>) -> IpcResult<ProjectOpenResponse> {
    validate_id(&id)?;
    let dir = project_dir(&id);
    if !dir.exists() {
        return Err(IpcError::new("PROJECT_NOT_FOUND", format!("no project {id}")));
    }
    // Scope subsequent catalog scans + asset reads to this project.
    state.set_active_project(Some(id.clone()));
    Ok(ProjectOpenResponse {
        workspace_root: dir.display().to_string(),
    })
}

#[tauri::command]
pub async fn project_delete(id: String, state: State<'_, AppState>) -> IpcResult<()> {
    validate_id(&id)?;
    let dir = project_dir(&id);
    if dir.exists() {
        fs::remove_dir_all(&dir).await.map_err(IpcError::from)?;
    }
    if state.active_project().as_deref() == Some(id.as_str()) {
        state.set_active_project(None);
    }
    Ok(())
}

#[tauri::command]
pub async fn project_rename(id: String, name: String) -> IpcResult<ProjectSummary> {
    validate_id(&id)?;
    rename_project_at(&project_dir(&id), &id, &name).await
}

/// Filesystem half of `project_rename`, factored out so tests can rename a
/// project in a temp dir without the real app-data `projects_root`. Writes the
/// new name to `project.json` (creating it if absent), preserves `created_at`,
/// and bumps `updated_at`. A user-chosen name is never the placeholder, so the
/// AI-title self-heal in `read_project_summary` leaves it untouched afterward.
async fn rename_project_at(dir: &Path, id: &str, name: &str) -> IpcResult<ProjectSummary> {
    let name = name.trim();
    if name.is_empty() {
        return Err(IpcError::invalid_argument("project name is required"));
    }
    if !dir.exists() {
        return Err(IpcError::new("PROJECT_NOT_FOUND", format!("no project {id}")));
    }
    let meta_path = dir.join("project.json");
    // Preserve created_at when the metadata exists and parses; otherwise stamp
    // a fresh one (a dir without project.json is otherwise summarized by mtime).
    let created_at = match fs::read(&meta_path).await {
        Ok(bytes) => serde_json::from_slice::<StoredProjectMeta>(&bytes)
            .map(|m| m.created_at)
            .unwrap_or_else(|_| Utc::now().timestamp_millis()),
        Err(_) => Utc::now().timestamp_millis(),
    };
    let now = Utc::now().timestamp_millis();
    let meta = StoredProjectMeta {
        id: Some(id.to_string()),
        name: name.to_string(),
        created_at,
        updated_at: now,
    };
    let bytes = serde_json::to_vec_pretty(&meta).map_err(IpcError::from)?;
    fs::write(&meta_path, bytes).await.map_err(IpcError::from)?;
    let has_model = dir.join("model.step").exists() || dir.join("model.stl").exists();
    Ok(ProjectSummary {
        id: id.to_string(),
        name: name.to_string(),
        created_at,
        updated_at: now,
        has_model,
    })
}

fn project_dir(id: &str) -> PathBuf {
    paths::projects_root().join(id)
}

pub(crate) fn validate_id(id: &str) -> IpcResult<()> {
    if id.trim().is_empty()
        || id.contains('/')
        || id.contains('\\')
        || id.contains("..")
    {
        Err(IpcError::invalid_argument("invalid project id"))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn create_then_list_round_trip() {
        // Use a temp dir as our "projects root" by saving + restoring the
        // env-injected app data dir is overkill — we test list_projects
        // directly so we don't disturb the real app data dir.
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("abc");
        fs::create_dir_all(&dir).await.unwrap();
        let meta = StoredProjectMeta {
            id: Some("abc".into()),
            name: "Hook".into(),
            created_at: 100,
            updated_at: 200,
        };
        let bytes = serde_json::to_vec_pretty(&meta).unwrap();
        fs::write(dir.join("project.json"), bytes).await.unwrap();

        let summaries = list_projects(tmp.path()).await.unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].name, "Hook");
        assert_eq!(summaries[0].id, "abc");
        assert!(!summaries[0].has_model);
    }

    #[tokio::test]
    async fn rename_preserves_created_at_and_persists_name() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("p1");
        fs::create_dir_all(&dir).await.unwrap();
        write_meta(&dir, PLACEHOLDER_PROJECT_NAME).await; // created_at=1, updated_at=2

        let summary = rename_project_at(&dir, "p1", "  Wall Hook  ").await.unwrap();
        assert_eq!(summary.name, "Wall Hook", "name is trimmed");
        assert_eq!(summary.id, "p1");
        assert_eq!(summary.created_at, 1, "created_at preserved");
        assert!(summary.updated_at >= 2, "updated_at bumped");

        let bytes = fs::read(dir.join("project.json")).await.unwrap();
        let meta: StoredProjectMeta = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(meta.name, "Wall Hook", "new name persisted to disk");
        assert_eq!(meta.created_at, 1);
    }

    #[tokio::test]
    async fn rename_rejects_empty_name() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("p1");
        fs::create_dir_all(&dir).await.unwrap();
        write_meta(&dir, "Original").await;

        let err = rename_project_at(&dir, "p1", "   ").await.unwrap_err();
        assert_eq!(err.code, "INVALID_ARGUMENT");
    }

    #[tokio::test]
    async fn rename_missing_project_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("ghost"); // never created
        let err = rename_project_at(&dir, "ghost", "New").await.unwrap_err();
        assert_eq!(err.code, "PROJECT_NOT_FOUND");
    }

    #[test]
    fn validate_id_rejects_escape() {
        let err = validate_id("../../etc").unwrap_err();
        assert_eq!(err.code, "INVALID_ARGUMENT");
    }

    #[tokio::test]
    async fn project_create_requires_name() {
        let err = create_project("  ").await.unwrap_err();
        assert_eq!(err.code, "INVALID_ARGUMENT");
    }

    async fn write_meta(dir: &Path, name: &str) {
        let meta = StoredProjectMeta {
            id: Some(dir.file_name().unwrap().to_string_lossy().into_owned()),
            name: name.to_string(),
            created_at: 1,
            updated_at: 2,
        };
        fs::write(dir.join("project.json"), serde_json::to_vec_pretty(&meta).unwrap())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn needs_autoname_only_for_placeholder_or_empty() {
        let tmp = tempfile::tempdir().unwrap();

        let placeholder = tmp.path().join("a");
        fs::create_dir_all(&placeholder).await.unwrap();
        write_meta(&placeholder, PLACEHOLDER_PROJECT_NAME).await;
        assert!(needs_autoname(&placeholder).await);

        let empty = tmp.path().join("b");
        fs::create_dir_all(&empty).await.unwrap();
        write_meta(&empty, "   ").await;
        assert!(needs_autoname(&empty).await);

        let named = tmp.path().join("c");
        fs::create_dir_all(&named).await.unwrap();
        write_meta(&named, "Phone Stand").await;
        assert!(!needs_autoname(&named).await);

        // Missing project.json → not a project we should title.
        let bare = tmp.path().join("d");
        fs::create_dir_all(&bare).await.unwrap();
        assert!(!needs_autoname(&bare).await);
    }

    #[tokio::test]
    async fn set_name_if_placeholder_writes_then_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("proj");
        fs::create_dir_all(&dir).await.unwrap();
        write_meta(&dir, PLACEHOLDER_PROJECT_NAME).await;

        // First write upgrades the placeholder and persists.
        assert!(set_name_if_placeholder(&dir, "  Phone Stand  ").await);
        let persisted: StoredProjectMeta =
            serde_json::from_slice(&fs::read(dir.join("project.json")).await.unwrap()).unwrap();
        assert_eq!(persisted.name, "Phone Stand");
        assert_eq!(persisted.created_at, 1, "created_at preserved");

        // A real name is never clobbered, and an empty title is rejected.
        assert!(!set_name_if_placeholder(&dir, "Wall Hook").await);
        assert!(!set_name_if_placeholder(&dir, "   ").await);
        let after: StoredProjectMeta =
            serde_json::from_slice(&fs::read(dir.join("project.json")).await.unwrap()).unwrap();
        assert_eq!(after.name, "Phone Stand", "name held after no-op writes");
    }

    #[test]
    fn parse_latest_ai_title_takes_last_nonempty() {
        let jsonl = concat!(
            "{\"type\":\"user\",\"message\":\"hi\"}\n",
            "{\"type\":\"ai-title\",\"aiTitle\":\"First Draft\",\"sessionId\":\"s\"}\n",
            "{\"type\":\"assistant\",\"message\":\"ok\"}\n",
            "{\"type\":\"ai-title\",\"aiTitle\":\"Headphone Wall Hook\",\"sessionId\":\"s\"}\n",
        );
        assert_eq!(
            parse_latest_ai_title(jsonl).as_deref(),
            Some("Headphone Wall Hook")
        );
    }

    #[test]
    fn parse_latest_ai_title_none_when_absent_or_empty() {
        assert_eq!(parse_latest_ai_title(""), None);
        assert_eq!(
            parse_latest_ai_title("{\"type\":\"assistant\",\"message\":\"no title here\"}\n"),
            None
        );
        // An empty/whitespace aiTitle is ignored.
        assert_eq!(
            parse_latest_ai_title("{\"type\":\"ai-title\",\"aiTitle\":\"   \"}\n"),
            None
        );
    }

    /// End-to-end naming self-heal, exercising the real path:
    /// read_project_summary → resolve_ai_title → session_jsonl_path →
    /// parse_latest_ai_title → write-back. Both the "no title yet" and the
    /// "title lands" cases live in one test so the global `HOME` sandbox can't
    /// race a sibling test mutating the same env.
    #[tokio::test]
    async fn read_project_summary_naming_self_heal() {
        let home_tmp = tempfile::tempdir().unwrap();
        let old_home = std::env::var_os("HOME");
        std::env::set_var("HOME", home_tmp.path());

        // A project dir whose name is the project id (mirrors projects_root/<id>).
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("proj-naming-1");
        fs::create_dir_all(&dir).await.unwrap();
        let write_meta = |name: &str| StoredProjectMeta {
            id: Some("proj-naming-1".into()),
            name: name.to_string(),
            created_at: 1,
            updated_at: 2,
        };
        fs::write(
            dir.join("project.json"),
            serde_json::to_vec_pretty(&write_meta(PLACEHOLDER_PROJECT_NAME)).unwrap(),
        )
        .await
        .unwrap();

        // 1) No session JSONL yet → placeholder preserved (no churn).
        let before = read_project_summary(&dir).await.expect("summary");

        // 2) Claude writes an ai-title → next read upgrades + persists. Write at
        //    the exact path the resolver reads (same helper → no canonicalization
        //    mismatch).
        let session_id = session_id_for_project("proj-naming-1").to_string();
        let jsonl = session_jsonl_path(&dir, &session_id).expect("HOME is set");
        fs::create_dir_all(jsonl.parent().unwrap()).await.unwrap();
        fs::write(
            &jsonl,
            "{\"type\":\"user\"}\n{\"type\":\"ai-title\",\"aiTitle\":\"First\"}\n\
             {\"type\":\"ai-title\",\"aiTitle\":\"Headphone Wall Hook\"}\n",
        )
        .await
        .unwrap();
        let after = read_project_summary(&dir).await.expect("summary");
        let persisted: StoredProjectMeta =
            serde_json::from_slice(&fs::read(dir.join("project.json")).await.unwrap()).unwrap();

        // Restore env before asserting so a failure can't leak HOME.
        match &old_home {
            Some(h) => std::env::set_var("HOME", h),
            None => std::env::remove_var("HOME"),
        }

        assert_eq!(before.name, PLACEHOLDER_PROJECT_NAME, "placeholder kept until title exists");
        assert_eq!(after.name, "Headphone Wall Hook", "last ai-title wins");
        assert_eq!(persisted.name, "Headphone Wall Hook", "upgrade persisted to project.json");
    }
}
