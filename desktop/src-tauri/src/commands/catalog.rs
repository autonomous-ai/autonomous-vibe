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

/// Validate a project id is a bare directory name (no path traversal), so
/// `project_catalog_read` cannot be coerced into scanning outside the projects
/// root. Returns the trimmed id on success.
fn validate_project_id(id: &str) -> IpcResult<&str> {
    let trimmed = id.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
    {
        return Err(IpcError::new(
            "INVALID_PROJECT_ID",
            "project id must be a bare directory name",
        ));
    }
    Ok(trimmed)
}

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
pub async fn project_catalog_read(id: String) -> IpcResult<Catalog> {
    // Read a specific project's files by id WITHOUT changing the active
    // project. Powers the sidebar's lazy per-project subtrees: expanding a
    // non-active project loads its catalog here, leaving `state.active_project`
    // (and thus the chat session + 3D viewer) untouched. Selecting a file then
    // switches the active project via `project_open`, after which the live
    // `catalog_read` takes over.
    let id = validate_project_id(&id)?;
    let root = paths::project_root(id);
    tokio::fs::create_dir_all(&root).await.map_err(IpcError::from)?;
    let entries = scan_workspace(&root)?;
    Ok(Catalog {
        entries,
        root_path: root.display().to_string(),
        // Non-active subtrees are not rendered in the 3D pane (selecting a file
        // first switches the active project, which re-reads via `catalog_read`),
        // so no per-revision cache-busting is needed here.
        revision: 0,
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
/// "Relevant" means the file's name maps to a [`CatalogKind`] via
/// [`CatalogKind::from_filename`] (step/stp/stl/gcode/py/json/png, plus
/// `.implicit.js`/`.implicit.mjs` implicit CAD models). The mapping is
/// deliberately narrow: broader file types (e.g. `.dxf`, `.3mf`, `.urdf`)
/// belong to deferred catalogs.
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
        let Some(file_name) = absolute.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(kind) = CatalogKind::from_filename(file_name) else {
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
        // Renderable meshes (`.stl`) get a cache-bust token so the viewer
        // refetches a regenerated, same-path mesh instead of serving stale
        // bytes from cadjs's URL-keyed cache (see `versioned_asset_uri`).
        let url = if matches!(kind, CatalogKind::Stl) {
            versioned_asset_uri(&rel, absolute)
        } else {
            tauri_asset_uri(&rel)
        };
        entries.push(CatalogEntry {
            file: rel.clone(),
            kind,
            source_kind,
            url,
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
        | CatalogKind::Png
        | CatalogKind::Implicit => Some(SourceKind::Static),
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
    // `versioned` mirrors the standalone `.stl` entry: the preview mesh URL
    // carries a cache-bust token so a regenerated sibling re-renders; the
    // metadata sidecar URL stays plain (it isn't a rendered mesh).
    let make_url = |suffix: &str, versioned: bool| {
        let candidate = parent.join(format!("{stem}{suffix}"));
        if candidate.exists() {
            let rel = paths::to_workspace_relative(&candidate, root)?;
            Some(if versioned {
                versioned_asset_uri(&rel, &candidate)
            } else {
                tauri_asset_uri(&rel)
            })
        } else {
            None
        }
    };
    let stl_url = make_url(".stl", true);
    let metadata_url = make_url(".step.json", false);
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

/// Asset URL for a renderable mesh, with an opaque `?v=<mtime>-<size>` cache-bust
/// token appended.
///
/// cadjs caches loaded mesh bytes keyed by the asset URL
/// (`renderAssetClient.js` `stlCache`), and the viewer's reload trigger keys off
/// a hash synthesized from that URL. A regenerated artifact keeps the same
/// `pandaasset://` path, so without a changing token the viewer serves the stale
/// model (the holes-still-there bug). Deriving the token from the file's mtime +
/// size makes the URL change exactly when the file does — busting both the byte
/// cache and the reload trigger. The `pandaasset://` handler resolves by path and
/// ignores the query (`asset_protocol::handle`), so the token is inert on the
/// wire.
fn versioned_asset_uri(workspace_relative: &str, absolute: &Path) -> String {
    let base = tauri_asset_uri(workspace_relative);
    match version_token(absolute) {
        Some(token) => format!("{base}?v={token}"),
        None => base,
    }
}

/// `<mtime_nanos>-<len>` for a file, or `None` if it can't be `stat`ed. Cheap
/// (one metadata syscall) and changes on every regeneration.
fn version_token(absolute: &Path) -> Option<String> {
    let meta = std::fs::metadata(absolute).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Some(format!("{mtime}-{}", meta.len()))
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
    fn from_filename_recognizes_implicit_but_not_plain_js() {
        assert_eq!(
            CatalogKind::from_filename("sphere.implicit.js"),
            Some(CatalogKind::Implicit),
        );
        assert_eq!(
            CatalogKind::from_filename("Sphere.IMPLICIT.MJS"),
            Some(CatalogKind::Implicit),
        );
        assert_eq!(CatalogKind::from_filename("script.js"), None);
        assert_eq!(CatalogKind::from_filename("module.mjs"), None);
        assert_eq!(
            CatalogKind::from_filename("model.step"),
            Some(CatalogKind::Step),
        );
    }

    #[test]
    fn catalogs_implicit_models_and_skips_plain_js() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(&root.join("sphere.implicit.js"));
        touch(&root.join("helper.js")); // plain JS must stay out of the catalog

        let entries = scan_workspace(root).unwrap();
        let by_file: HashMap<&str, &CatalogEntry> =
            entries.iter().map(|e| (e.file.as_str(), e)).collect();
        let implicit = by_file
            .get("sphere.implicit.js")
            .expect("implicit model catalogued");
        assert_eq!(implicit.kind, CatalogKind::Implicit);
        assert_eq!(implicit.source_kind, Some(SourceKind::Static));
        assert!(
            !by_file.contains_key("helper.js"),
            "plain .js files must not be catalogued",
        );
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
        // The preview-mesh URL carries a `?v=` cache-bust token; the metadata
        // sidecar URL stays plain.
        let stl_url = artifact.stl_url.unwrap();
        assert!(stl_url.contains("model.stl"), "stl_url was {stl_url}");
        assert!(stl_url.contains("?v="), "stl_url should be versioned: {stl_url}");
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
        assert!(artifact.stl_url.unwrap().contains("model.stl"));
        assert!(artifact.metadata_url.unwrap().ends_with("model.step.json"));
    }

    #[test]
    fn standalone_stl_entry_url_is_versioned() {
        // The rendered mesh URL must carry a cache-bust token so a regenerated,
        // same-path `.stl` re-renders instead of serving cadjs's stale bytes.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("model.stl"), b"solid\n").unwrap();
        fs::write(root.join("model.step"), b"").unwrap(); // non-mesh stays plain

        let entries = scan_workspace(root).unwrap();
        let stl = entries.iter().find(|e| e.file == "model.stl").unwrap();
        assert!(stl.url.contains("model.stl"), "url was {}", stl.url);
        assert!(stl.url.contains("?v="), "stl url should be versioned: {}", stl.url);

        let step = entries.iter().find(|e| e.file == "model.step").unwrap();
        assert!(!step.url.contains("?v="), "non-mesh url stays plain: {}", step.url);
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
    fn validate_project_id_accepts_bare_names_and_rejects_traversal() {
        assert_eq!(validate_project_id("  abc-123 ").unwrap(), "abc-123");
        for bad in ["", "   ", "..", "a/b", "a\\b", "../escape", "x/.."] {
            assert!(
                validate_project_id(bad).is_err(),
                "expected {bad:?} to be rejected",
            );
        }
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

