//! `file_read_bytes` + `file_reveal` IPC commands.

use crate::ipc::types::AssetKind;
use crate::ipc::{IpcError, IpcResult};
use crate::paths;
use crate::state::AppState;
use std::path::{Path, PathBuf};
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

/// Import one or more user-chosen 3D files into the open project via the
/// native "Open" dialog.
///
/// Meshes are normalized to `.stl` — the catalog/render/slice pipeline's
/// native mesh format. `.stl` is copied as-is; `.glb`/`.gltf` is converted to
/// `.stl` via the bundled CPython's `trimesh`. (OrcaSlicer can't slice GLB, so a
/// raw copy would be a print dead-end; converting on import makes an imported
/// model renderable *and* printable through the existing `.stl` paths.) GLB
/// color/materials are intentionally dropped — irrelevant for single-material
/// FDM.
///
/// A `.step`/`.stp` B-rep is run through the bundled `cadcode` generator, which
/// re-meshes it into the full artifact set (`.step` + `.stl` + `.step.json`) so
/// the import becomes a first-class model with selectable faces — the reason to
/// import STEP over a bare mesh.
///
/// Returns the imported workspace-relative paths (e.g. `["dragon.stl"]`,
/// `["bracket.step"]`), or an empty vec if the user cancelled. Bumps the catalog
/// revision so the viewer's asset cache-bust tokens change and the rail
/// re-reads.
#[tauri::command]
pub async fn file_import(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> IpcResult<Vec<String>> {
    let id = state
        .active_project()
        .ok_or_else(|| IpcError::new("NO_ACTIVE_PROJECT", "no project is open"))?;
    let root = paths::project_root(&id);
    tokio::fs::create_dir_all(&root).await.map_err(IpcError::from)?;

    // `blocking_pick_files` parks the calling thread until the user responds, so
    // run it on the blocking pool rather than an async-runtime worker (matches
    // `file_save`'s `blocking_save_file`).
    let dialog_app = app.clone();
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .add_filter("3D models", &["stl", "glb", "gltf", "step", "stp"])
            .blocking_pick_files()
    })
    .await
    .map_err(|e| IpcError::new("IMPORT_FAILED", format!("import dialog failed: {e}")))?;

    let Some(picks) = chosen else {
        return Ok(Vec::new()); // user cancelled
    };

    let mut imported = Vec::new();
    for pick in picks {
        let source = pick
            .into_path()
            .map_err(|e| IpcError::new("IMPORT_FAILED", format!("invalid source path: {e}")))?;
        imported.push(import_one(&source, &root).await?);
    }

    state.bump_revision();
    Ok(imported)
}

/// Place a single imported file into `project_root`, returning its
/// project-relative name. `.stl` copies bytes; `.glb`/`.gltf` converts to
/// `.stl` via trimesh; `.step`/`.stp` is re-meshed by the cadcode generator
/// into the `.step` + `.stl` + `.step.json` artifact set. The destination stem
/// is de-duplicated so an import never clobbers a generated model or a prior
/// import.
async fn import_one(source: &Path, project_root: &Path) -> IpcResult<String> {
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| IpcError::invalid_argument("source file has no name"))?;
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "stl" => {
            let dest = unique_dest(project_root, stem, "stl");
            tokio::fs::copy(source, &dest).await.map_err(IpcError::from)?;
            rel_name(&dest, project_root)
        }
        "glb" | "gltf" => {
            let dest = unique_dest(project_root, stem, "stl");
            convert_mesh_to_stl(source, &dest).await?;
            rel_name(&dest, project_root)
        }
        "step" | "stp" => import_step(source, project_root, stem).await,
        other => Err(IpcError::new(
            "IMPORT_UNSUPPORTED",
            format!("cannot import .{other} files; supported: stl, glb, gltf, step, stp"),
        )),
    }
}

/// Import a `.step`/`.stp` B-rep by running the bundled `cadcode` generator on
/// it: `scripts/cad <source> --out-dir <project> --stem <free-stem>` writes
/// `<stem>.step`, `<stem>.stl`, and `<stem>.step.json` into the project. We
/// reserve a collision-free `<stem>.step` first (so an import never overwrites
/// an existing model), and return that `.step` — the catalog surfaces the
/// sibling `.stl`/`.step.json` under it. On failure any partial artifacts are
/// removed so a broken half-import never lands in the rail.
async fn import_step(source: &Path, project_root: &Path, stem: &str) -> IpcResult<String> {
    let dest_step = unique_dest(project_root, stem, "step");
    // `unique_dest` always yields a `<stem>.step` name, so the stem is valid UTF-8.
    let out_stem = dest_step
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| IpcError::new("IMPORT_FAILED", "could not derive output name"))?
        .to_string();

    if let Err(err) = generate_step_artifacts(source, project_root, &out_stem).await {
        remove_step_artifacts(project_root, &out_stem).await;
        return Err(err);
    }
    rel_name(&dest_step, project_root)
}

/// Map an absolute artifact path back to its project-relative name, or an
/// `IMPORT_FAILED` if it somehow escaped the project root.
fn rel_name(dest: &Path, project_root: &Path) -> IpcResult<String> {
    paths::to_workspace_relative(dest, project_root)
        .ok_or_else(|| IpcError::new("IMPORT_FAILED", "imported file escaped project root"))
}

/// Pick a non-colliding destination `<dir>/<stem>.<ext>`, appending `-1`, `-2`,
/// … until the name is free, so an import never overwrites an existing file.
fn unique_dest(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    let mut n = 1u32;
    loop {
        let candidate = dir.join(format!("{stem}-{n}.{ext}"));
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Convert a `.glb`/`.gltf` to `.stl` with the bundled CPython's `trimesh`
/// (already vendored in the desktop python runtime and used by cadpy's render
/// path). `force='mesh'` flattens a multi-geometry scene into one mesh; the
/// `.stl` extension drives the exporter. A `.glb` is self-contained; a `.gltf`
/// referencing external buffers/textures is best-effort and surfaces any failure
/// as `IMPORT_FAILED`.
async fn convert_mesh_to_stl(source: &Path, dest: &Path) -> IpcResult<()> {
    let python = resolve_python()
        .ok_or_else(|| IpcError::new("PYTHON_MISSING", "bundled python interpreter not found"))?;
    let output = tokio::process::Command::new(&python)
        .arg("-c")
        .arg("import sys,trimesh; trimesh.load(sys.argv[1],force='mesh').export(sys.argv[2])")
        .arg(source)
        .arg(dest)
        .output()
        .await
        .map_err(|e| IpcError::new("IMPORT_FAILED", format!("conversion failed to start: {e}")))?;
    if !output.status.success() {
        // A partial/empty export can be left behind on failure; drop it so a
        // de-duped retry doesn't skip the name and a broken `.stl` never lands
        // in the catalog.
        let _ = tokio::fs::remove_file(dest).await;
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(IpcError::new(
            "IMPORT_FAILED",
            "GLB/GLTF to STL conversion failed",
        )
        .with_detail(serde_json::Value::String(stderr.trim().to_string())));
    }
    Ok(())
}

/// Re-mesh a `.step`/`.stp` into the Panda artifact set by running the cadcode
/// generator: `python <scripts/cad> <source> --out-dir <out_dir> --stem <stem>`.
/// The generator meshes the imported B-rep and writes `<stem>.step`,
/// `<stem>.stl`, and `<stem>.step.json` (with face IDs + validation) into
/// `out_dir`. It prints one JSON line and exits non-zero on failure; we surface
/// its stderr/stdout as the error detail.
async fn generate_step_artifacts(source: &Path, out_dir: &Path, stem: &str) -> IpcResult<()> {
    let python = resolve_python()
        .ok_or_else(|| IpcError::new("PYTHON_MISSING", "bundled python interpreter not found"))?;
    let cad_script = cadcode_cad_script().ok_or_else(|| {
        IpcError::new(
            "IMPORT_FAILED",
            "cadcode generator not found under ~/.claude/skills",
        )
    })?;
    let output = tokio::process::Command::new(&python)
        .arg(&cad_script)
        .arg(source)
        .arg("--out-dir")
        .arg(out_dir)
        .arg("--stem")
        .arg(stem)
        .output()
        .await
        .map_err(|e| IpcError::new("IMPORT_FAILED", format!("STEP import failed to start: {e}")))?;

    // The generator exits 0 only when it emitted an `ok: true` result line; a
    // non-zero exit (or a spawn that produced no artifacts) is a failed import.
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if stderr.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            stderr.trim().to_string()
        };
        return Err(
            IpcError::new("IMPORT_FAILED", "STEP import failed")
                .with_detail(serde_json::Value::String(detail)),
        );
    }
    Ok(())
}

/// Delete any `<stem>.step`/`.stl`/`.step.json` left behind by a failed STEP
/// import so a broken half-import never surfaces in the catalog. Best-effort.
async fn remove_step_artifacts(dir: &Path, stem: &str) {
    for name in [
        format!("{stem}.step"),
        format!("{stem}.stl"),
        format!("{stem}.step.json"),
    ] {
        let _ = tokio::fs::remove_file(dir.join(name)).await;
    }
}

/// Absolute path to the installed cadcode generator entrypoint
/// (`~/.claude/skills/cadcode/scripts/cad`) — the same path the chat driver
/// invokes. Skills are installed there on every app startup by
/// [`crate::skills::install_bundled_skills`]. Returns `None` if it is absent
/// (skills not yet installed, or `HOME` unset).
fn cadcode_cad_script() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let script = home.join(".claude/skills/cadcode/scripts/cad");
    script.exists().then_some(script)
}

/// Resolve a usable Python interpreter: the bundled CPython sidecar first, else
/// a system `python3`. Mirrors `commands::app::resolve_python`.
fn resolve_python() -> Option<PathBuf> {
    crate::commands::claude_driver::bundled_python_bin_dir()
        .map(|dir| dir.join("python3"))
        .filter(|p| p.exists())
        .or_else(|| which::which("python3").ok())
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

    #[test]
    fn unique_dest_appends_suffix_on_collision() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert_eq!(unique_dest(root, "m", "stl"), root.join("m.stl"));
        std::fs::write(root.join("m.stl"), b"").unwrap();
        assert_eq!(unique_dest(root, "m", "stl"), root.join("m-1.stl"));
        std::fs::write(root.join("m-1.stl"), b"").unwrap();
        assert_eq!(unique_dest(root, "m", "stl"), root.join("m-2.stl"));
    }

    #[tokio::test]
    async fn import_one_copies_stl_into_project_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        std::fs::create_dir_all(&root).unwrap();
        let src = dir.path().join("dragon.stl");
        std::fs::write(&src, b"solid dragon\n").unwrap();

        let rel = import_one(&src, &root).await.unwrap();
        assert_eq!(rel, "dragon.stl");
        assert_eq!(
            std::fs::read(root.join("dragon.stl")).unwrap(),
            b"solid dragon\n"
        );
    }

    #[tokio::test]
    async fn import_one_dedupes_and_never_clobbers() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        std::fs::create_dir_all(&root).unwrap();
        // A generated model already occupies the name.
        std::fs::write(root.join("dragon.stl"), b"existing").unwrap();
        let src = dir.path().join("dragon.stl");
        std::fs::write(&src, b"new bytes").unwrap();

        let rel = import_one(&src, &root).await.unwrap();
        assert_eq!(rel, "dragon-1.stl");
        assert_eq!(std::fs::read(root.join("dragon.stl")).unwrap(), b"existing");
        assert_eq!(std::fs::read(root.join("dragon-1.stl")).unwrap(), b"new bytes");
    }

    #[tokio::test]
    async fn import_one_rejects_unsupported_extension() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        std::fs::create_dir_all(&root).unwrap();
        let src = dir.path().join("model.obj");
        std::fs::write(&src, b"v 0 0 0").unwrap();

        let err = import_one(&src, &root).await.unwrap_err();
        assert_eq!(err.code, "IMPORT_UNSUPPORTED");
    }

    #[tokio::test]
    async fn remove_step_artifacts_drops_the_whole_set() {
        // A failed STEP import must not leave a half-written model behind: the
        // cleanup removes the .step/.stl/.step.json trio (and no-ops on absent
        // files) so the catalog never lists a broken import.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("part.step"), b"").unwrap();
        std::fs::write(root.join("part.stl"), b"").unwrap();
        // .step.json intentionally absent — removal must tolerate it.
        std::fs::write(root.join("keep.stl"), b"").unwrap();

        remove_step_artifacts(root, "part").await;

        assert!(!root.join("part.step").exists());
        assert!(!root.join("part.stl").exists());
        // An unrelated model with a different stem is untouched.
        assert!(root.join("keep.stl").exists());
    }

    #[test]
    fn step_import_reserves_a_collision_free_step_stem() {
        // The STEP import reserves `<stem>.step` up front so it never clobbers
        // an existing model — same de-dup contract as the mesh path.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert_eq!(unique_dest(root, "bracket", "step"), root.join("bracket.step"));
        std::fs::write(root.join("bracket.step"), b"").unwrap();
        assert_eq!(unique_dest(root, "bracket", "step"), root.join("bracket-1.step"));
    }
}

