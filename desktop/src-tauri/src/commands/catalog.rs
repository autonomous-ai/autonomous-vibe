//! `catalog_read` + `generation_status_read` IPC commands.
//!
//! Ported (simplified) from
//! `viewer/packages/cadjs/src/lib/cadDirectoryScanner.mjs`. The JS scanner
//! deals with rich sidecar validation (topology buffer views, edge
//! manifests, source-hash freshness). Track C only needs the shape
//! defined by contract §2; richer artifact validation can be folded in
//! as the cadcode pipeline lands.

use crate::ipc::types::{
    Catalog, CatalogArtifact, CatalogEntry, CatalogKind, GenerationStatus, SourceKind,
};
use crate::ipc::{IpcError, IpcResult};
use crate::paths;
use crate::state::AppState;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::State;
use walkdir::{DirEntry, WalkDir};

const SKIPPED_DIRECTORIES: &[&str] = &[
    ".agents",
    ".cache",
    ".git",
    ".panda",
    ".venv",
    ".viewer",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "node_modules",
    // Belt-and-suspenders: a bundled app dir (e.g. OrcaSlicer.app under
    // `resources/`) must never surface as a "model" even if a scan root
    // is ever misconfigured. Projects never legitimately contain one.
    "resources",
    "venv",
];

fn is_skipped_dir(entry: &DirEntry) -> bool {
    if !entry.file_type().is_dir() {
        return false;
    }
    let name = entry.file_name().to_string_lossy();
    SKIPPED_DIRECTORIES.contains(&name.as_ref())
}

#[tauri::command]
pub async fn catalog_read(state: State<'_, AppState>) -> IpcResult<Catalog> {
    // The catalog is scoped to the open project: we scan that project's
    // dir and nothing else, so the Models rail only ever shows the user's
    // own files — never sibling projects or the bundled OrcaSlicer
    // sample/calibration models. The active project is set by
    // `project_open` / `project_create`.
    let Some(id) = state.active_project() else {
        // No project open yet (the viewer auto-creates/opens one on first
        // launch, so this is a brief transient): scan nothing.
        return Ok(Catalog {
            entries: Vec::new(),
            root_path: String::new(),
            revision: state.current_revision(),
        });
    };
    let root = paths::project_root(&id);
    tokio::fs::create_dir_all(&root).await.map_err(IpcError::from)?;
    let entries = scan_workspace(&root)?;
    Ok(Catalog {
        entries,
        root_path: root.display().to_string(),
        revision: state.current_revision(),
    })
}

#[tauri::command]
pub async fn generation_status_read(state: State<'_, AppState>) -> IpcResult<GenerationStatus> {
    // python_available: bundled python or system python3 — matches the
    // detection in app::detect_python so the React side sees one source
    // of truth.
    let python_available = crate::commands::app::python_available_for_status();
    Ok(GenerationStatus {
        queue: state.generation_queue_snapshot(),
        python_available,
        last_error: state.last_generation_error(),
    })
}

/// Walk the workspace and return one [`CatalogEntry`] per relevant file.
///
/// "Relevant" means the file's lowercase extension maps to a
/// [`CatalogKind`] (step/stp/stl/glb/gcode/py/json/png). The mapping is
/// deliberately narrow: contract §2 freezes the enum, and broader file
/// types (e.g. `.dxf`, `.3mf`, `.urdf`) belong to deferred catalogs.
pub fn scan_workspace(root: &Path) -> IpcResult<Vec<CatalogEntry>> {
    let mut entries: Vec<CatalogEntry> = Vec::new();
    let mut path_index: HashMap<PathBuf, ()> = HashMap::new();

    // Pre-pass: gather every regular file under `root`, skipping junk dirs.
    let mut all_files: Vec<PathBuf> = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_skipped_dir(e))
    {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.file_type().is_file() {
            all_files.push(entry.into_path());
        }
    }

    for absolute in &all_files {
        path_index.insert(absolute.clone(), ());
    }

    for absolute in &all_files {
        let Some(extension) = absolute
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
        else {
            continue;
        };
        let Some(kind) = CatalogKind::from_extension(&extension) else {
            continue;
        };
        let Some(rel) = paths::to_workspace_relative(absolute, root) else {
            continue;
        };
        let source_kind = classify_source_kind(kind, absolute, &path_index);
        let artifact = sidecar_artifact(kind, absolute, root);
        entries.push(CatalogEntry {
            file: rel.clone(),
            kind,
            source_kind,
            url: tauri_asset_uri(&rel),
            artifact,
            relations: None,
        });
    }

    entries.sort_by(|a, b| a.file.cmp(&b.file));
    Ok(entries)
}

fn classify_source_kind(
    kind: CatalogKind,
    absolute: &Path,
    index: &HashMap<PathBuf, ()>,
) -> Option<SourceKind> {
    match kind {
        CatalogKind::Step => {
            // Per the deliverable: mark .step files that have a
            // same-stem .py sibling as `sourceKind: "python"`.
            let stem = absolute.file_stem()?.to_owned();
            let mut sibling = absolute.to_path_buf();
            sibling.set_file_name(stem);
            sibling.set_extension("py");
            if index.contains_key(&sibling) {
                Some(SourceKind::Python)
            } else {
                Some(SourceKind::Static)
            }
        }
        CatalogKind::Stl
        | CatalogKind::Glb
        | CatalogKind::Gcode
        | CatalogKind::Json
        | CatalogKind::Png => Some(SourceKind::Static),
        CatalogKind::Py => None,
    }
}

/// For a .step entry, fish out matching sidecar URLs (GLB / topology
/// JSON / metadata JSON) if they exist next to the file.
fn sidecar_artifact(
    kind: CatalogKind,
    absolute: &Path,
    root: &Path,
) -> Option<CatalogArtifact> {
    if !matches!(kind, CatalogKind::Step) {
        return None;
    }
    let stem = absolute.file_stem()?.to_string_lossy().into_owned();
    let parent = absolute.parent()?;
    let make_url = |suffix: &str| {
        let candidate = parent.join(format!("{stem}{suffix}"));
        if candidate.exists() {
            let rel = paths::to_workspace_relative(&candidate, root)?;
            Some(tauri_asset_uri(&rel))
        } else {
            None
        }
    };
    let glb_url = make_url(".glb");
    let topology_url = make_url(".topology.json");
    let metadata_url = make_url(".step.json");
    if glb_url.is_none() && topology_url.is_none() && metadata_url.is_none() {
        return None;
    }
    Some(CatalogArtifact {
        glb_url,
        topology_url,
        metadata_url,
    })
}

fn tauri_asset_uri(workspace_relative: &str) -> String {
    // The viewer `fetch()`es this URL directly to load asset bytes; the
    // `pandaasset://` scheme (src/asset_protocol.rs) serves them from the
    // open project's dir. (The `file_read_bytes` command remains for
    // reveal-in-finder and other byte reads.)
    crate::asset_protocol::asset_url(workspace_relative)
}

// ---------------------------------------------------------------------------
// Tests — exercise the scanner against an ephemeral filesystem tree.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, b"").unwrap();
    }

    #[test]
    fn flags_step_with_py_sibling_as_python_source() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(&root.join("model.step"));
        touch(&root.join("model.py"));
        touch(&root.join("static.step")); // no sibling

        let entries = scan_workspace(root).unwrap();
        let by_file: HashMap<&str, &CatalogEntry> =
            entries.iter().map(|e| (e.file.as_str(), e)).collect();
        assert_eq!(
            by_file["model.step"].source_kind,
            Some(SourceKind::Python),
            "model.step has a same-stem .py sibling",
        );
        assert_eq!(
            by_file["static.step"].source_kind,
            Some(SourceKind::Static),
            "static.step has no sibling",
        );
    }

    #[test]
    fn picks_up_artifact_sidecars_for_step() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(&root.join("model.step"));
        touch(&root.join("model.glb"));
        touch(&root.join("model.topology.json"));
        touch(&root.join("model.step.json"));

        let entries = scan_workspace(root).unwrap();
        let step = entries
            .iter()
            .find(|e| e.file == "model.step")
            .expect("model.step entry present");
        let artifact = step.artifact.clone().expect("artifact attached");
        assert!(artifact.glb_url.unwrap().ends_with("model.glb"));
        assert!(artifact.topology_url.unwrap().ends_with("model.topology.json"));
        assert!(artifact.metadata_url.unwrap().ends_with("model.step.json"));
    }

    #[test]
    fn skips_node_modules_and_dot_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(&root.join("keep.py"));
        touch(&root.join("node_modules").join("ignored.py"));
        touch(&root.join(".git").join("HEAD"));
        touch(&root.join("parts").join("base.py"));

        let entries = scan_workspace(root).unwrap();
        let files: Vec<&str> = entries.iter().map(|e| e.file.as_str()).collect();
        assert!(files.contains(&"keep.py"));
        assert!(files.contains(&"parts/base.py"));
        assert!(!files.iter().any(|f| f.contains("node_modules")));
        assert!(!files.iter().any(|f| f.starts_with(".git")));
    }

    #[test]
    fn skips_bundled_resources_dir() {
        // A misconfigured scan root must never surface bundled slicer
        // models (OrcaSlicer.app lives under `resources/`).
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(&root.join("model.step"));
        touch(
            &root
                .join("resources")
                .join("slicer")
                .join("handy_models")
                .join("sample.stl"),
        );

        let entries = scan_workspace(root).unwrap();
        let files: Vec<&str> = entries.iter().map(|e| e.file.as_str()).collect();
        assert!(files.contains(&"model.step"));
        assert!(!files.iter().any(|f| f.contains("resources")));
    }

    #[test]
    fn nests_into_subdirs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(&root.join("parts").join("base.step"));
        let entries = scan_workspace(root).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].file, "parts/base.step");
    }

    #[test]
    fn entries_are_sorted_alphabetically() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(&root.join("z.py"));
        touch(&root.join("a.py"));
        touch(&root.join("m.py"));
        let entries = scan_workspace(root).unwrap();
        let files: Vec<&str> = entries.iter().map(|e| e.file.as_str()).collect();
        assert_eq!(files, vec!["a.py", "m.py", "z.py"]);
    }
}

