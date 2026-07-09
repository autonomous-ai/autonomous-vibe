//! Filesystem path helpers — the workspace root, projects dir, and
//! settings file all live under the platform's app data directory.

use directories::ProjectDirs;
use std::path::{Path, PathBuf};

// These three feed `ProjectDirs::from(qualifier, organization, application)`,
// which on macOS builds the Application Support folder name as
// `{qualifier}.{organization}.{application}` → `app.panda.desktop`. This is
// intentionally kept in sync with `tauri.conf.json`'s `identifier`, but note
// the two are independent: this crate's data paths come from here, NOT from
// the Tauri identifier.
const QUALIFIER: &str = "app";
const ORGANIZATION: &str = "panda";
const APPLICATION: &str = "desktop";

/// Resolve the platform app-data root directory. Falls back to
/// `./.panda-data/` if `ProjectDirs` returns nothing (test environments,
/// containers).
pub fn app_data_dir() -> PathBuf {
    if let Some(dirs) = ProjectDirs::from(QUALIFIER, ORGANIZATION, APPLICATION) {
        dirs.data_dir().to_path_buf()
    } else {
        PathBuf::from(".panda-data")
    }
}

/// Projects subdir under the app data root. This is the workspace root the
/// `app_info` command reports.
pub fn projects_root() -> PathBuf {
    app_data_dir().join("projects")
}

pub fn settings_path() -> PathBuf {
    app_data_dir().join("settings.json")
}

pub fn printers_path() -> PathBuf {
    app_data_dir().join("bambu-printers.json")
}

/// The signed-in Bambu cloud account record (tokens + account metadata).
/// Sensitive — like the LAN access code it is never serialized back to JS.
pub fn cloud_account_path() -> PathBuf {
    app_data_dir().join("bambu-cloud.json")
}

/// Resolve a workspace-relative path against the projects root. Returns
/// an error if the resolved path escapes the projects root.
pub fn resolve_workspace_relative(rel: &str) -> Result<PathBuf, String> {
    resolve_under(&projects_root(), rel)
}

/// The on-disk directory for a single project.
pub fn project_root(project_id: &str) -> PathBuf {
    projects_root().join(project_id)
}

/// Resolve a project-relative path against a specific project's dir,
/// rejecting `..` traversal. Catalog entries and asset references are
/// project-relative (bare, e.g. `model.step`), so reads resolve here.
pub fn resolve_in_project(project_id: &str, rel: &str) -> Result<PathBuf, String> {
    resolve_under(&project_root(project_id), rel)
}

pub fn resolve_under(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let trimmed = rel.trim().trim_start_matches('/');
    if trimmed.is_empty() || trimmed.contains("..") {
        return Err(format!("path escapes workspace root: {rel}"));
    }
    let candidate = root.join(trimmed);
    // Don't strictly require existence — callers may want to create paths.
    Ok(candidate)
}

/// Convert an absolute path to a workspace-relative POSIX-style string.
pub fn to_workspace_relative(absolute: &Path, root: &Path) -> Option<String> {
    let rel = absolute.strip_prefix(root).ok()?;
    let s = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/");
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_under_root() {
        let tmp = tempfile::tempdir().unwrap();
        let resolved = resolve_under(tmp.path(), "model.step").unwrap();
        assert_eq!(resolved, tmp.path().join("model.step"));
    }

    #[test]
    fn rejects_escape() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(resolve_under(tmp.path(), "../escape.txt").is_err());
        assert!(resolve_under(tmp.path(), "").is_err());
    }

    #[test]
    fn to_workspace_relative_handles_subdirs() {
        let tmp = tempfile::tempdir().unwrap();
        let nested = tmp.path().join("parts").join("base.py");
        assert_eq!(
            to_workspace_relative(&nested, tmp.path()).as_deref(),
            Some("parts/base.py"),
        );
    }
}
