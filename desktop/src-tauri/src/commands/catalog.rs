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
/// [`CatalogKind`] (step/stp/stl/gcode/py/json/png). The mapping is
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
        // Hide auxiliary files from the catalog so the file list shows only the
        // main deliverables (source `.py` + `.step`/`.stl`). `path_index`
        // still holds every file, so `.step`→`.py` sibling detection and the
        // sidecar artifact URLs below resolve from disk regardless.
        if is_auxiliary_file(absolute, kind) {
            continue;
        }
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

/// Files that are real on disk (and still serve as siblings/sidecars) but
/// should not clutter the workspace file list as standalone entries:
/// - `.json` — `.topology.json` / `.step.json` sidecars + other metadata
///   (surfaced via a `.step` entry's `artifact`, never on their own).
/// - `.png` — QA render images; never an app deliverable (the viewer renders the `.stl`).
/// - underscore-prefixed `.py` — internal helper scripts (e.g. `_export.py`,
///   `_render.py`), not the user's editable source.
///
/// Kept: `.step`/`.stp`/`.stl`/`.gcode` and real (non-underscore) `.py`.
fn is_auxiliary_file(absolute: &Path, kind: CatalogKind) -> bool {
    match kind {
        CatalogKind::Json | CatalogKind::Png => true,
        CatalogKind::Py => absolute
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with('_'))
            .unwrap_or(false),
        _ => false,
    }
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
        | CatalogKind::Gcode
        | CatalogKind::Json
        | CatalogKind::Png => Some(SourceKind::Static),
        CatalogKind::Py => None,
    }
}

/// For a .step entry, fish out matching sidecar URLs (the `.stl` the viewer
/// renders as the preview mesh, plus the `.step.json` metadata) if they exist
/// next to the file.
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
    let stl_url = make_url(".stl");
    let metadata_url = make_url(".step.json");
    if stl_url.is_none() && metadata_url.is_none() {
        return None;
    }
    Some(CatalogArtifact {
        stl_url,
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
        touch(&root.join("model.stl"));
        touch(&root.join("model.step.json"));

        let entries = scan_workspace(root).unwrap();
        let step = entries
            .iter()
            .find(|e| e.file == "model.step")
            .expect("model.step entry present");
        let artifact = step.artifact.clone().expect("artifact attached");
        assert!(artifact.stl_url.unwrap().ends_with("model.stl"));
        assert!(artifact.metadata_url.unwrap().ends_with("model.step.json"));
    }

    #[test]
    fn hides_helper_scripts_renders_and_sidecars() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // Main deliverables.
        touch(&root.join("model.py"));
        touch(&root.join("model.step"));
        touch(&root.join("model.stl"));
        // Auxiliary clutter that must NOT appear as standalone entries.
        touch(&root.join("_export.py"));
        touch(&root.join("_render.py"));
        touch(&root.join("model_iso.png"));
        touch(&root.join("model_side.png"));
        touch(&root.join("model.step.json"));

        let entries = scan_workspace(root).unwrap();
        let mut files: Vec<&str> = entries.iter().map(|e| e.file.as_str()).collect();
        files.sort();
        assert_eq!(
            files,
            vec!["model.py", "model.step", "model.stl"],
            "only the three main files survive; helpers/renders/sidecars are hidden",
        );

        // Sibling detection + sidecar URLs still resolve from disk even though the
        // .py/.json files are no longer standalone entries.
        let step = entries.iter().find(|e| e.file == "model.step").unwrap();
        assert_eq!(step.source_kind, Some(SourceKind::Python));
        let artifact = step.artifact.clone().expect("sidecars attached to .step");
        assert!(artifact.stl_url.unwrap().ends_with("model.stl"));
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

