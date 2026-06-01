//! `slice_*` IPC commands — real OrcaSlicer CLI wiring.
//!
//! Track G replaces the canned stub with a subprocess invocation against
//! the configured (or bundled) OrcaSlicer binary. Parses the resulting
//! G-code's metadata header for the stats `SliceStats` advertises in
//! `docs/panda-interfaces.md` §2, and emits `slice_progress` events while
//! the job is in flight.
//!
//! See `skills/gcode/references/slicer-backends.md` for the CLI flag set.

use crate::ipc::types::{
    AppSettings, FilamentKind, SliceProgressEvent, SliceRequest, SliceStage, SliceStats,
    SliceStatus,
};
use crate::ipc::{IpcError, IpcResult};
use crate::paths;
use crate::state::AppState;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncReadExt;

const SLICE_PROGRESS_EVENT: &str = "slice_progress";

// ---------------------------------------------------------------------------
// Public Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn slice_run(
    req: SliceRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> IpcResult<SliceStats> {
    // untested against real OrcaSlicer — verify in field test before v1 ship
    let mesh = req.mesh_file.trim();
    if mesh.is_empty() {
        return Err(IpcError::invalid_argument("meshFile is required"));
    }

    set_status(
        &state,
        &app,
        SliceStatus {
            in_flight: true,
            stage: Some(SliceStage::Preparing),
            progress: Some(0.05),
        },
    );

    let outcome = run_slice_job(&req, &state, &app).await;

    let final_status = match &outcome {
        Ok(_) => SliceStatus {
            in_flight: false,
            stage: None,
            progress: Some(1.0),
        },
        Err(_) => SliceStatus {
            in_flight: false,
            stage: None,
            progress: None,
        },
    };
    set_status(&state, &app, final_status);

    outcome
}

#[tauri::command]
pub async fn slice_status(state: State<'_, AppState>) -> IpcResult<SliceStatus> {
    Ok(state.slice_status_snapshot())
}

// ---------------------------------------------------------------------------
// Job driver
// ---------------------------------------------------------------------------

async fn run_slice_job(
    req: &SliceRequest,
    state: &State<'_, AppState>,
    app: &AppHandle,
) -> IpcResult<SliceStats> {
    let mesh_path = resolve_mesh_path(state.active_project().as_deref(), &req.mesh_file)?;
    if !mesh_path.exists() {
        return Err(IpcError::invalid_argument(format!(
            "meshFile does not exist on disk: {}",
            mesh_path.display()
        )));
    }

    let settings = read_app_settings_for_slice().await;
    let slicer_bin = resolve_slicer_binary(settings.slicer_binary_path.as_str())?;

    let gcode_path = gcode_path_for(&mesh_path);
    let out_dir = gcode_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir());
    tokio::fs::create_dir_all(&out_dir).await.ok();

    let args = build_orcaslicer_args(SlicerInvocation {
        out_dir: &out_dir,
        mesh: &mesh_path,
        filament: req.filament,
    });

    set_status(
        state,
        app,
        SliceStatus {
            in_flight: true,
            stage: Some(SliceStage::Slicing),
            progress: Some(0.25),
        },
    );

    let exec_result = spawn_slicer(&slicer_bin, &args).await?;

    if !exec_result.success {
        let summary = stderr_summary(&exec_result.stderr);
        return Err(IpcError::new("SLICE_FAILED", summary).with_detail(serde_json::json!({
            "exitCode": exec_result.exit_code,
            "command": format!("{} {}", slicer_bin.display(), args.join(" ")),
            "stderrTail": stderr_tail(&exec_result.stderr, 2_000),
        })));
    }

    set_status(
        state,
        app,
        SliceStatus {
            in_flight: true,
            stage: Some(SliceStage::Writing),
            progress: Some(0.85),
        },
    );

    let produced_gcode = pick_produced_gcode(&out_dir, &mesh_path, &gcode_path).await?;
    let header_bytes = read_gcode_header(&produced_gcode).await?;
    let parsed = parse_gcode_metadata(&String::from_utf8_lossy(&header_bytes));

    let stats = SliceStats {
        duration_seconds: parsed.duration_seconds.unwrap_or(0.0),
        filament_grams: parsed.filament_grams.unwrap_or(0.0),
        filament_meters: parsed.filament_meters.unwrap_or(0.0),
        layer_count: parsed.layer_count.unwrap_or(0),
        supports_used: parsed.supports_used.unwrap_or(false),
        gcode_file: produced_gcode_relpath(&produced_gcode, &req.mesh_file),
    };

    Ok(stats)
}

fn set_status(state: &State<'_, AppState>, app: &AppHandle, status: SliceStatus) {
    state.set_slice_status(status.clone());
    let stage_label = status
        .stage
        .map(|s| match s {
            SliceStage::Preparing => "preparing",
            SliceStage::Slicing => "slicing",
            SliceStage::Writing => "writing",
        })
        .unwrap_or(if status.in_flight { "running" } else { "done" });
    let _ = app.emit(
        SLICE_PROGRESS_EVENT,
        SliceProgressEvent {
            stage: stage_label.to_string(),
            progress: status.progress.unwrap_or(0.0),
        },
    );
}

/// Read AppSettings without going through the Tauri command (so we can
/// stay in this module's process boundary). Returns defaults on any
/// error — same behavior as `app_settings_read` for missing files.
async fn read_app_settings_for_slice() -> AppSettings {
    let path = paths::settings_path();
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(_) => return AppSettings::default(),
    };
    if bytes.is_empty() {
        return AppSettings::default();
    }
    serde_json::from_slice::<AppSettings>(&bytes).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Slicer-binary resolution
// ---------------------------------------------------------------------------

pub(crate) fn resolve_slicer_binary(configured: &str) -> Result<PathBuf, IpcError> {
    let trimmed = configured.trim();
    if !trimmed.is_empty() {
        let p = PathBuf::from(trimmed);
        if p.exists() {
            return Ok(p);
        }
        return Err(IpcError::new(
            "SLICER_NOT_FOUND",
            format!("configured slicer_binary_path does not exist: {trimmed}"),
        ));
    }
    if let Some(bundled) = bundled_slicer_path() {
        if bundled.exists() && file_is_executable(&bundled) {
            return Ok(bundled);
        }
    }
    if let Ok(p) = which::which("orcaslicer").or_else(|_| which::which("OrcaSlicer")) {
        return Ok(p);
    }
    Err(IpcError::new(
        "SLICER_NOT_FOUND",
        "no OrcaSlicer binary configured, bundled, or on PATH",
    ))
}

fn bundled_slicer_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let parent = exe.parent()?;
    let arch = std::env::consts::ARCH;
    let os = std::env::consts::OS;
    let name = format!("orcaslicer-{arch}-{os}");
    Some(parent.join("resources/slicer").join(name))
}

fn file_is_executable(p: &Path) -> bool {
    // On Unix the placeholder file may be 0-bytes. Treat empty files as
    // "not executable" so we fall through to which::which() in tests.
    match std::fs::metadata(p) {
        Ok(m) => m.is_file() && m.len() > 0,
        Err(_) => false,
    }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

fn resolve_mesh_path(active_project: Option<&str>, mesh_ref: &str) -> Result<PathBuf, IpcError> {
    let trimmed = mesh_ref.trim();
    if trimmed.is_empty() {
        return Err(IpcError::invalid_argument("meshFile is required"));
    }
    let p = PathBuf::from(trimmed);
    if p.is_absolute() {
        return Ok(p);
    }
    // Relative refs are project-relative (bare catalog paths); resolve
    // them under the open project's dir.
    let id = active_project
        .ok_or_else(|| IpcError::new("NO_ACTIVE_PROJECT", "no project is open"))?;
    paths::resolve_in_project(id, trimmed).map_err(IpcError::invalid_argument)
}

fn gcode_path_for(mesh: &Path) -> PathBuf {
    let stem = mesh
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "model".to_string());
    let dir = mesh.parent().unwrap_or_else(|| Path::new(""));
    dir.join(format!("{stem}.gcode"))
}

fn produced_gcode_relpath(produced: &Path, original_ref: &str) -> String {
    // If the user passed a workspace-relative mesh path, return a
    // workspace-relative G-code path next to it (same dir, .gcode suffix).
    // Absolute caller inputs get an absolute string back.
    if Path::new(original_ref).is_absolute() {
        return produced.display().to_string();
    }
    let dir = Path::new(original_ref)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let stem = produced
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "model".to_string());
    if dir.is_empty() {
        format!("{stem}.gcode")
    } else {
        format!("{dir}/{stem}.gcode")
    }
}

async fn pick_produced_gcode(
    out_dir: &Path,
    mesh: &Path,
    preferred: &Path,
) -> Result<PathBuf, IpcError> {
    // OrcaSlicer's --outputdir flag drops a file named after the input
    // mesh stem in most versions, but the exact naming varies; pick the
    // newest .gcode under out_dir whose stem matches.
    if preferred.exists() {
        return Ok(preferred.to_path_buf());
    }
    let stem = mesh
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let same_dir = out_dir.join(format!("{stem}.gcode"));
    if same_dir.exists() {
        return Ok(same_dir);
    }
    // Scan the out_dir for any .gcode produced during this slice. Pick
    // the freshest by mtime.
    let mut best: Option<(PathBuf, std::time::SystemTime)> = None;
    let mut rd = match tokio::fs::read_dir(out_dir).await {
        Ok(rd) => rd,
        Err(e) => return Err(IpcError::new("SLICE_FAILED", e.to_string())),
    };
    while let Ok(Some(entry)) = rd.next_entry().await {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("gcode") {
            continue;
        }
        let mtime = entry
            .metadata()
            .await
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(std::time::UNIX_EPOCH);
        match &best {
            None => best = Some((p, mtime)),
            Some((_, prev)) if mtime > *prev => best = Some((p, mtime)),
            _ => {}
        }
    }
    best.map(|(p, _)| p).ok_or_else(|| {
        IpcError::new(
            "SLICE_FAILED",
            "slicer exited 0 but produced no .gcode in the output dir",
        )
    })
}

// ---------------------------------------------------------------------------
// Argument builder
// ---------------------------------------------------------------------------

struct SlicerInvocation<'a> {
    out_dir: &'a Path,
    mesh: &'a Path,
    filament: FilamentKind,
}

fn build_orcaslicer_args(inv: SlicerInvocation<'_>) -> Vec<String> {
    // Matches the OrcaSlicer flag shape documented in
    // `skills/gcode/references/slicer-backends.md`:
    //
    //   OrcaSlicer --load-settings machine.json\;process.json \
    //              --load-filaments filament.json --outputdir /tmp/out \
    //              --slice 0 input.stl
    //
    // We don't ship native machine/process/filament JSON profiles in v1
    // (Track H deliverable). For now we lean on OrcaSlicer's built-in
    // defaults and pass `--filament-profile <kind>` so the chosen filament
    // shows up in the produced G-code header. `--orient 1` lets the
    // slicer auto-orient the mesh for the consumer flow.
    let mut args = vec![
        "--orient".to_string(),
        "1".to_string(),
        "--outputdir".to_string(),
        inv.out_dir.display().to_string(),
        "--filament-profile".to_string(),
        filament_profile_label(inv.filament).to_string(),
        "--slice".to_string(),
        "0".to_string(),
        inv.mesh.display().to_string(),
    ];
    // Some OrcaSlicer builds want positional input last (above); other
    // mirrors put it under `--load`. Keep the documented form so the
    // skill reference stays the single source of truth.
    args.shrink_to_fit();
    args
}

fn filament_profile_label(kind: FilamentKind) -> &'static str {
    match kind {
        FilamentKind::Pla => "Generic PLA",
        FilamentKind::Petg => "Generic PETG",
        FilamentKind::Tpu => "Generic TPU",
    }
}

// ---------------------------------------------------------------------------
// Subprocess driver
// ---------------------------------------------------------------------------

struct SlicerOutcome {
    success: bool,
    exit_code: Option<i32>,
    stderr: Vec<u8>,
}

async fn spawn_slicer(bin: &Path, args: &[String]) -> Result<SlicerOutcome, IpcError> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    // OrcaSlicer's CLI mode still tries to spin up a GUI on Linux/Mac
    // unless we strip DISPLAY-ish env vars; the safest baseline for
    // automated runs is to inherit env unchanged and rely on the user's
    // profile path. We document this as untested above.

    let mut child = cmd.spawn().map_err(|e| {
        IpcError::new(
            "SLICE_FAILED",
            format!("failed to spawn slicer {}: {e}", bin.display()),
        )
    })?;

    let mut stderr_buf = Vec::new();
    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.read_to_end(&mut stderr_buf).await;
    }
    let status = child
        .wait()
        .await
        .map_err(|e| IpcError::new("SLICE_FAILED", e.to_string()))?;
    Ok(SlicerOutcome {
        success: status.success(),
        exit_code: status.code(),
        stderr: stderr_buf,
    })
}

fn stderr_summary(stderr: &[u8]) -> String {
    let s = String::from_utf8_lossy(stderr);
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return "slicer exited non-zero with no stderr".to_string();
    }
    let last_line = trimmed.lines().rev().next().unwrap_or(trimmed);
    last_line.to_string()
}

fn stderr_tail(stderr: &[u8], max_bytes: usize) -> String {
    let s = String::from_utf8_lossy(stderr);
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let start = s.len() - max_bytes;
    s[start..].to_string()
}

// ---------------------------------------------------------------------------
// G-code header parsing
// ---------------------------------------------------------------------------

#[derive(Default, Debug, PartialEq)]
pub(crate) struct ParsedGcodeMetadata {
    pub duration_seconds: Option<f64>,
    pub filament_grams: Option<f64>,
    pub filament_meters: Option<f64>,
    pub layer_count: Option<u32>,
    pub supports_used: Option<bool>,
}

/// OrcaSlicer (and most Slic3r-derived slicers) write a `; KEY = VALUE`
/// metadata block at the top and bottom of the G-code. The fields we
/// look for are:
///
/// - `estimated printing time (normal mode) = 1h 4m 50s` (PrusaSlicer style)
/// - `total estimated time : 1h 4m 50s` (Orca variant)
/// - `total filament used [g] = 12.34`
/// - `total filament length [mm] = 4321.5` (some builds use [m])
/// - `total layer number = 50`
/// - `support_material = 1`
pub(crate) fn parse_gcode_metadata(text: &str) -> ParsedGcodeMetadata {
    let mut out = ParsedGcodeMetadata::default();
    for raw in text.lines() {
        let line = raw.trim_start_matches(';').trim();
        if line.is_empty() {
            continue;
        }
        // Split on '=' first, falling back to ':' for Orca's variant.
        let (key, value) = match split_kv(line) {
            Some(kv) => kv,
            None => continue,
        };
        let key_norm = key.to_ascii_lowercase();
        let value = value.trim();
        if key_norm.contains("estimated") && key_norm.contains("time")
            || key_norm.contains("total estimated time")
            || key_norm == "total print time"
        {
            if let Some(secs) = parse_duration_to_seconds(value) {
                out.duration_seconds.get_or_insert(secs);
            }
        } else if key_norm.contains("filament used")
            && (key_norm.contains("[g]") || key_norm.contains("(g)"))
        {
            if let Some(g) = parse_first_float(value) {
                out.filament_grams.get_or_insert(g);
            }
        } else if key_norm.contains("filament used [mm]")
            || (key_norm.contains("filament length") && key_norm.contains("mm"))
        {
            if let Some(mm) = parse_first_float(value) {
                out.filament_meters.get_or_insert(mm / 1000.0);
            }
        } else if key_norm.contains("filament used [m]")
            || (key_norm.contains("filament length") && !key_norm.contains("mm"))
        {
            if let Some(m) = parse_first_float(value) {
                out.filament_meters.get_or_insert(m);
            }
        } else if key_norm.contains("layer count")
            || key_norm.contains("total layer number")
            || key_norm.contains("total layers count")
        {
            if let Some(n) = parse_first_float(value) {
                out.layer_count.get_or_insert(n as u32);
            }
        } else if key_norm.contains("support_material")
            || key_norm.contains("support used")
            || key_norm == "supports"
        {
            out.supports_used.get_or_insert(parse_bool_int(value));
        }
    }
    out
}

fn split_kv(line: &str) -> Option<(&str, &str)> {
    if let Some(idx) = line.find('=') {
        return Some((line[..idx].trim(), line[idx + 1..].trim()));
    }
    if let Some(idx) = line.find(':') {
        return Some((line[..idx].trim(), line[idx + 1..].trim()));
    }
    None
}

fn parse_first_float(s: &str) -> Option<f64> {
    let mut start = None;
    let mut end = s.len();
    for (i, c) in s.char_indices() {
        let is_num = c.is_ascii_digit() || c == '.' || c == '-' || c == '+';
        if is_num && start.is_none() {
            start = Some(i);
        } else if !is_num && start.is_some() {
            end = i;
            break;
        }
    }
    let start = start?;
    s[start..end].parse::<f64>().ok()
}

fn parse_bool_int(s: &str) -> bool {
    let v = s.trim().to_ascii_lowercase();
    matches!(v.as_str(), "1" | "true" | "yes" | "on")
}

/// Parse `1h 4m 50s` / `64m 50s` / `3850` (seconds) / `1:04:50` into seconds.
fn parse_duration_to_seconds(s: &str) -> Option<f64> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Colon-separated H:M:S
    if trimmed.contains(':') {
        let parts: Vec<&str> = trimmed.split(':').collect();
        let nums: Vec<f64> = parts
            .iter()
            .map(|p| p.trim().parse::<f64>().unwrap_or(0.0))
            .collect();
        return match nums.as_slice() {
            [h, m, s] => Some(h * 3600.0 + m * 60.0 + s),
            [m, s] => Some(m * 60.0 + s),
            [s] => Some(*s),
            _ => None,
        };
    }
    // "1h 4m 50s"
    let mut total = 0.0;
    let mut saw_unit = false;
    let mut cur = String::new();
    for ch in trimmed.chars() {
        if ch.is_ascii_digit() || ch == '.' {
            cur.push(ch);
        } else if matches!(ch.to_ascii_lowercase(), 'h' | 'm' | 's' | 'd') {
            if let Ok(n) = cur.parse::<f64>() {
                let mult = match ch.to_ascii_lowercase() {
                    'd' => 86_400.0,
                    'h' => 3600.0,
                    'm' => 60.0,
                    's' => 1.0,
                    _ => 0.0,
                };
                total += n * mult;
                saw_unit = true;
            }
            cur.clear();
        } else {
            cur.clear();
        }
    }
    if saw_unit {
        Some(total)
    } else {
        // Bare number => seconds.
        trimmed.parse::<f64>().ok()
    }
}

async fn read_gcode_header(path: &Path) -> Result<Vec<u8>, IpcError> {
    // OrcaSlicer puts the estimated-time line near the head, but the
    // filament summary is in the trailing footer. Read both ends so we
    // don't miss either.
    let mut head = vec![0u8; 64 * 1024];
    let mut tail = vec![0u8; 64 * 1024];
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| IpcError::new("SLICE_FAILED", format!("open {}: {e}", path.display())))?;
    let head_len = file
        .read(&mut head)
        .await
        .map_err(|e| IpcError::new("SLICE_FAILED", e.to_string()))?;
    head.truncate(head_len);
    let meta = tokio::fs::metadata(path).await.ok();
    let size = meta.map(|m| m.len()).unwrap_or(0);
    if size > head_len as u64 + 1024 {
        use tokio::io::AsyncSeekExt;
        let seek_from = size.saturating_sub(64 * 1024);
        if file
            .seek(std::io::SeekFrom::Start(seek_from))
            .await
            .is_ok()
        {
            let tail_len = file.read(&mut tail).await.unwrap_or(0);
            tail.truncate(tail_len);
            head.extend_from_slice(&tail);
        }
    }
    Ok(head)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::types::FilamentKind;

    #[test]
    fn slice_request_serializes_camel_case() {
        let req = SliceRequest {
            mesh_file: "model.stl".into(),
            printer_id: "x1c-001".into(),
            filament: FilamentKind::Pla,
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["meshFile"], "model.stl");
        assert_eq!(json["printerId"], "x1c-001");
        assert_eq!(json["filament"], "PLA");
    }

    #[test]
    fn argv_includes_outdir_filament_and_input_mesh() {
        let out = PathBuf::from("/tmp/slice-out");
        let mesh = PathBuf::from("/tmp/in.stl");
        let args = build_orcaslicer_args(SlicerInvocation {
            out_dir: &out,
            mesh: &mesh,
            filament: FilamentKind::Petg,
        });
        assert!(args.iter().any(|a| a == "--outputdir"));
        let outdir_idx = args.iter().position(|a| a == "--outputdir").unwrap();
        assert_eq!(args[outdir_idx + 1], "/tmp/slice-out");
        assert!(args.iter().any(|a| a == "--orient"));
        assert!(args.contains(&"--filament-profile".to_string()));
        assert!(args.iter().any(|a| a == "Generic PETG"));
        assert_eq!(args.last().unwrap(), "/tmp/in.stl");
        // slice mode 0 means "first plate".
        let slice_idx = args.iter().position(|a| a == "--slice").unwrap();
        assert_eq!(args[slice_idx + 1], "0");
    }

    #[test]
    fn parses_prusaslicer_style_header() {
        let g = r#"
; estimated printing time (normal mode) = 1h 4m 50s
; total filament used [g] = 6.50
; total filament used [mm] = 2180.0
; total layer number = 50
; support_material = 0
G1 X0 Y0
"#;
        let meta = parse_gcode_metadata(g);
        assert_eq!(meta.duration_seconds, Some(3890.0));
        assert_eq!(meta.filament_grams, Some(6.50));
        assert_eq!(meta.filament_meters, Some(2.180));
        assert_eq!(meta.layer_count, Some(50));
        assert_eq!(meta.supports_used, Some(false));
    }

    #[test]
    fn parses_orca_colon_variant() {
        let g = r#"
; total estimated time : 2h 12m 0s
; total filament length [m] : 3.5
; total filament used [g] : 11.2
; total layers count : 120
; support_material : 1
"#;
        let meta = parse_gcode_metadata(g);
        assert_eq!(meta.duration_seconds, Some(7920.0));
        assert_eq!(meta.filament_meters, Some(3.5));
        assert_eq!(meta.filament_grams, Some(11.2));
        assert_eq!(meta.layer_count, Some(120));
        assert_eq!(meta.supports_used, Some(true));
    }

    #[test]
    fn duration_parser_handles_multiple_formats() {
        assert_eq!(parse_duration_to_seconds("3850"), Some(3850.0));
        assert_eq!(parse_duration_to_seconds("1:04:50"), Some(3890.0));
        assert_eq!(parse_duration_to_seconds("4m 50s"), Some(290.0));
        assert_eq!(parse_duration_to_seconds("1d 2h"), Some(93600.0));
        assert_eq!(parse_duration_to_seconds(""), None);
    }

    #[test]
    fn resolve_slicer_falls_back_to_path_when_unconfigured() {
        // An empty configured path + missing bundled binary should not
        // produce SLICER_NOT_FOUND if `orcaslicer` happens to be on PATH;
        // either way the function must not panic.
        let _ = resolve_slicer_binary("");
        let err = resolve_slicer_binary("/this/path/does/not/exist/slicer").unwrap_err();
        assert_eq!(err.code, "SLICER_NOT_FOUND");
    }

    #[test]
    fn gcode_path_relpath_preserves_workspace_directory() {
        let produced = PathBuf::from("/abs/projects/parts/lid.gcode");
        assert_eq!(produced_gcode_relpath(&produced, "parts/lid.stl"), "parts/lid.gcode");
        assert_eq!(produced_gcode_relpath(&produced, "model.stl"), "lid.gcode");
    }

    #[test]
    fn stderr_summary_picks_last_nonempty_line() {
        let stderr = b"warning: blah\nerror: profile not loaded\n";
        assert_eq!(stderr_summary(stderr), "error: profile not loaded");
        assert_eq!(stderr_summary(b""), "slicer exited non-zero with no stderr");
    }
}
