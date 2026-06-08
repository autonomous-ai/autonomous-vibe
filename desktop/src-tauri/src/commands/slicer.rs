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
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncReadExt;

const SLICE_PROGRESS_EVENT: &str = "slice_progress";

/// Hard ceiling on a single OrcaSlicer CLI run. A consumer-scale slice (orient
/// + slice + 3mf export) finishes in seconds to a couple of minutes; past this
/// the process is presumed wedged (we have seen CLI invocations hang in
/// uninterruptible wait and pile up). On timeout we kill the child so it never
/// lingers like a left-open app.
const SLICE_TIMEOUT: Duration = Duration::from_secs(300);

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

    // When the user has configured no profile at all, OrcaSlicer would fall
    // back to its own internal default config — which enables relative-extruder
    // addressing without a matching `G92 E0` in the layer-change G-code and so
    // fails CLI validation ("Add G92 E0 to layer_gcode"). Slice against the
    // bundled Bambu profiles instead so a fresh install can slice out of the
    // box. A user who configured their own profiles keeps them untouched.
    let (settings_profile, filament_profile) =
        effective_profiles(&settings, &slicer_bin, req.filament);

    // OrcaSlicer's CLI cannot consume the bundled Bambu *system* profiles as
    // they ship. They are inheritance layers (`"inherits": ...`), and
    // `--load-settings` does not resolve that chain from a raw file path, so
    // inherited fields (e.g. `printable_area`) are missing and the bed silently
    // falls back to OrcaSlicer's 200×200×100 default. They are also OrcaSlicer
    // 2.3.x *multi-variant* profiles: each value is doubled per extruder variant
    // (Direct Drive Standard / High Flow), which crashes the CLI's
    // `update_values_to_printer_extruders_for_multiple_filaments` (SIGSEGV)
    // against a single loaded filament. Normalize every profile into a
    // self-contained, single-variant temp copy first. Best-effort: a profile
    // that can't be normalized passes through unchanged, and an already-flat
    // single-variant user profile is a harmless round-trip (no `inherits` to
    // resolve, `variant_count` < 2 so nothing is collapsed).
    let profile_tmp = make_profile_tmpdir();
    let (settings_profile, filament_profile) = match &profile_tmp {
        Some(dir) => (
            normalize_settings_list(&settings_profile, dir),
            normalize_profile_to(&filament_profile, dir, "filament.json"),
        ),
        None => (settings_profile, filament_profile),
    };

    // Sliced project 3mf lands next to the gcode named after the model
    // (`<stem>.3mf`), so the exported plate matches the source model name.
    let gcode_3mf_path = sliced_3mf_path_for(&mesh_path, &gcode_path);
    let args = build_orcaslicer_args(SlicerInvocation {
        out_dir: &out_dir,
        mesh: &mesh_path,
        settings_profile: &settings_profile,
        filament_profile: &filament_profile,
        export_3mf: &gcode_3mf_path,
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

    let exec_result = spawn_slicer(&slicer_bin, &args).await;
    // The normalized profiles are consumed by the spawn; drop the temp copies
    // however the slice ended (best-effort — they also sit in the OS temp dir).
    if let Some(dir) = &profile_tmp {
        let _ = std::fs::remove_dir_all(dir);
    }
    let exec_result = exec_result?;

    if !exec_result.success {
        // OrcaSlicer often prints its real failure reason to stdout rather than
        // stderr, so summarize stderr when present and fall back to stdout.
        let summary = if exec_result.stderr.iter().any(|b| !b.is_ascii_whitespace()) {
            stderr_summary(&exec_result.stderr)
        } else {
            stderr_summary(&exec_result.stdout)
        };
        return Err(IpcError::new("SLICE_FAILED", summary).with_detail(serde_json::json!({
            "exitCode": exec_result.exit_code,
            "command": format!("{} {}", slicer_bin.display(), args.join(" ")),
            "stderrTail": stderr_tail(&exec_result.stderr, 2_000),
            "stdoutTail": stderr_tail(&exec_result.stdout, 2_000),
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
    // OrcaSlicer names the gcode after the build *plate* (e.g. `plate_1.gcode`),
    // not the input mesh, and there's no CLI flag to override it. Rename it to
    // the model name (`<stem>.gcode`) so the output matches the model — the same
    // name we give the exported `.3mf`. Best-effort: if the rename fails, keep
    // the produced path so the slice still succeeds.
    let produced_gcode = if produced_gcode == gcode_path {
        produced_gcode
    } else {
        match tokio::fs::rename(&produced_gcode, &gcode_path).await {
            Ok(()) => gcode_path.clone(),
            Err(_) => produced_gcode,
        }
    };
    let header_bytes = read_gcode_header(&produced_gcode).await?;
    let parsed = parse_gcode_metadata(&String::from_utf8_lossy(&header_bytes));

    let gcode_relpath = produced_gcode_relpath(&produced_gcode, &req.mesh_file);
    // Best-effort: only advertise the 3mf if the slicer actually wrote it.
    // The 3mf is named after the model (`gcode_3mf_path`), which can differ
    // from the produced gcode's name, so build its relpath from the actual
    // exported filename in the gcode's workspace dir — not by suffixing the
    // gcode relpath.
    let gcode_3mf_file = if gcode_3mf_path.exists() {
        let fname = gcode_3mf_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        let dir = Path::new(&gcode_relpath)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        Some(if dir.is_empty() {
            fname.to_string()
        } else {
            format!("{dir}/{fname}")
        })
    } else {
        None
    };

    let stats = SliceStats {
        duration_seconds: parsed.duration_seconds.unwrap_or(0.0),
        filament_grams: parsed.filament_grams.unwrap_or(0.0),
        filament_meters: parsed.filament_meters.unwrap_or(0.0),
        layer_count: parsed.layer_count.unwrap_or(0),
        supports_used: parsed.supports_used.unwrap_or(false),
        gcode_file: gcode_relpath,
        gcode_3mf_file,
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
// Profile resolution
// ---------------------------------------------------------------------------

/// Resolve the `--load-settings` / `--load-filaments` values for a slice.
///
/// Honors the user's `AppSettings` profiles when set. When *neither* is
/// configured we substitute the bundled Bambu defaults (see
/// `default_bambu_profiles`), because slicing with no profile leaves OrcaSlicer
/// on an invalid internal default (relative-E without `G92 E0`). If the bundled
/// profile tree can't be located we fall back to the (empty) configured values
/// — the slice may still fail, but with the slicer's own message.
fn effective_profiles(
    settings: &AppSettings,
    slicer_bin: &Path,
    filament: FilamentKind,
) -> (String, String) {
    let configured_settings = settings.slicer_settings_profile.trim();
    let configured_filaments = settings.slicer_filament_profile.trim();
    if !configured_settings.is_empty() || !configured_filaments.is_empty() {
        return (
            configured_settings.to_string(),
            configured_filaments.to_string(),
        );
    }
    if let Some(dir) = slicer_profiles_dir(slicer_bin) {
        if let Some(defaults) = default_bambu_profiles(&dir, filament) {
            return (defaults.settings, defaults.filaments);
        }
    }
    (
        configured_settings.to_string(),
        configured_filaments.to_string(),
    )
}

/// Locate the bundled OrcaSlicer profile tree relative to its binary. On macOS
/// OrcaSlicer lives at `<…>.app/Contents/MacOS/OrcaSlicer` with its profiles at
/// `<…>.app/Contents/Resources/profiles` — true for both our shipped sidecar
/// and a drag-to-Applications install. Returns `None` when that layout isn't
/// present (e.g. a bare Linux/Windows sidecar).
fn slicer_profiles_dir(slicer_bin: &Path) -> Option<PathBuf> {
    let macos_dir = slicer_bin.parent()?; // …/Contents/MacOS
    let contents = macos_dir.parent()?; // …/Contents
    let profiles = contents.join("Resources/profiles");
    profiles.is_dir().then_some(profiles)
}

struct DefaultProfiles {
    /// `--load-settings` value: machine + process config, `;`-joined.
    settings: String,
    /// `--load-filaments` value.
    filaments: String,
}

/// Bundled Bambu profile trio to slice against when the user configured none.
/// Targets the Bambu Lab X1 Carbon (0.4 nozzle) with the standard 0.20mm
/// process, matching the filament generic to the request. Returns `None` if any
/// of the three files is missing from the tree (so the caller can fall back).
fn default_bambu_profiles(profiles_dir: &Path, filament: FilamentKind) -> Option<DefaultProfiles> {
    let bbl = profiles_dir.join("BBL");
    let machine = bbl.join("machine/Bambu Lab X1 Carbon 0.4 nozzle.json");
    let process = bbl.join("process/0.20mm Standard @BBL X1C.json");
    let filament_file = bbl.join("filament").join(match filament {
        FilamentKind::Pla => "Generic PLA High Speed @BBL X1C.json",
        FilamentKind::Petg => "Generic PETG HF @BBL X1C.json",
        FilamentKind::Tpu => "Generic TPU for AMS @BBL X1C.json",
    });
    if machine.exists() && process.exists() && filament_file.exists() {
        Some(DefaultProfiles {
            settings: format!("{};{}", machine.display(), process.display()),
            filaments: filament_file.display().to_string(),
        })
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Profile normalization for the OrcaSlicer CLI
//
// The bundled Bambu profiles are inheritance-based, multi-variant OrcaSlicer
// 2.3.x system profiles. Passed raw to `--load-settings`/`--load-filaments`
// they (a) leave the bed at OrcaSlicer's default because `inherits` is never
// resolved and (b) segfault the CLI on their per-extruder-variant arrays. We
// flatten the inherit chain and collapse to a single extruder variant before
// the slice. All functions here are best-effort and pure where possible so the
// behavior is unit-testable without a real slicer.
// ---------------------------------------------------------------------------

/// Create a fresh temp dir to hold normalized profile copies for one slice.
/// `None` if it can't be created (the caller then skips normalization and
/// passes the original profile paths through unchanged).
fn make_profile_tmpdir() -> Option<PathBuf> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "panda-slice-profiles-{}-{}",
        std::process::id(),
        nanos
    ));
    std::fs::create_dir_all(&dir).ok().map(|_| dir)
}

/// Normalize a `;`-joined `--load-settings` value (machine;process), writing a
/// self-contained copy of each entry into `out_dir` and returning the rejoined
/// list. OrcaSlicer keys profile *type* off the JSON `"type"` field, not the
/// filename, so the temp copies use stable generic names.
fn normalize_settings_list(list: &str, out_dir: &Path) -> String {
    list.split(';')
        .filter(|s| !s.trim().is_empty())
        .enumerate()
        .map(|(i, p)| normalize_profile_to(p, out_dir, &format!("settings-{i}.json")))
        .collect::<Vec<_>>()
        .join(";")
}

/// Normalize one profile file into `out_dir/out_name` and return the new path.
/// Empty input returns empty; any read/parse/write failure returns the input
/// path unchanged so the slice still runs against the original.
fn normalize_profile_to(path: &str, out_dir: &Path, out_name: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let src = Path::new(trimmed);
    let Some(normalized) = flatten_and_collapse(src) else {
        return trimmed.to_string();
    };
    let dest = out_dir.join(out_name);
    match serde_json::to_vec_pretty(&Value::Object(normalized)) {
        Ok(bytes) if std::fs::write(&dest, &bytes).is_ok() => dest.display().to_string(),
        _ => trimmed.to_string(),
    }
}

/// Read a profile, resolve its `inherits` chain, then collapse per-variant
/// arrays to the first extruder variant. `None` on any read/parse failure or an
/// unresolvable/cyclic inherit chain (caller falls back to the original path).
fn flatten_and_collapse(src: &Path) -> Option<Map<String, Value>> {
    let mut obj = flatten_inherits(src, &mut Vec::new())?;
    collapse_variants(&mut obj);
    Some(obj)
}

/// Merge a profile with its parents (`"inherits"`), child keys overriding the
/// parent. Parent files live alongside the child as `<name>.json`. Returns
/// `None` if the file (or any ancestor it names) can't be read/parsed, or on an
/// inherit cycle — signaling the caller to use the original file untouched.
fn flatten_inherits(src: &Path, seen: &mut Vec<String>) -> Option<Map<String, Value>> {
    let bytes = std::fs::read(src).ok()?;
    let obj: Map<String, Value> = serde_json::from_slice(&bytes).ok()?;
    let parent = obj.get("inherits").and_then(Value::as_str).map(str::to_owned);
    let mut merged = match parent {
        Some(name) if !name.is_empty() => {
            if seen.iter().any(|s| s == &name) {
                return None; // inherit cycle
            }
            seen.push(name.clone());
            let parent_path = src.parent()?.join(format!("{name}.json"));
            flatten_inherits(&parent_path, seen)? // unresolvable parent → bail
        }
        _ => Map::new(),
    };
    for (k, v) in obj {
        merged.insert(k, v); // child wins
    }
    merged.remove("inherits");
    Some(merged)
}

/// Array fields that hold one entry per *something other than extruder variant*
/// (a compatibility list), so must never be collapsed even when their length
/// happens to equal the variant count.
const NON_VARIANT_LIST_FIELDS: &[&str] = &[
    "compatible_printers",
    "compatible_prints",
    "compatible_printers_condition",
    "compatible_prints_condition",
];

/// Collapse OrcaSlicer 2.3.x per-extruder-variant arrays to their first
/// variant. The bundled Bambu profiles double every value across two variants
/// (Direct Drive Standard / High Flow); against a single loaded filament the
/// CLI's extruder/filament reconciliation segfaults. Keeping only the first
/// variant yields a consistent single-variant config. No-op when the profile
/// isn't multi-variant (so single-extruder user profiles are untouched).
fn collapse_variants(obj: &mut Map<String, Value>) {
    let variants = variant_count(obj);
    if variants < 2 {
        return;
    }
    for (key, value) in obj.iter_mut() {
        // `extruder_variant_list` is a 1-entry array whose element is the
        // comma-joined variant names — keep the first variant's name.
        if key == "extruder_variant_list" {
            if let Some(arr) = value.as_array_mut() {
                for item in arr.iter_mut() {
                    if let Some(first) = item.as_str().and_then(|s| s.split(',').next()) {
                        *item = Value::String(first.to_string());
                    }
                }
            }
            continue;
        }
        if NON_VARIANT_LIST_FIELDS.contains(&key.as_str()) {
            continue;
        }
        if let Some(arr) = value.as_array_mut() {
            if arr.len() == variants {
                arr.truncate(1);
            }
        }
    }
}

/// How many extruder variants a profile encodes. Detected from whichever
/// `*_extruder_variant` field is present (machine/process/filament), falling
/// back to the comma-count in `extruder_variant_list`. `1` means single-variant
/// (nothing to collapse).
fn variant_count(obj: &Map<String, Value>) -> usize {
    for key in [
        "printer_extruder_variant",
        "print_extruder_variant",
        "filament_extruder_variant",
    ] {
        if let Some(arr) = obj.get(key).and_then(Value::as_array) {
            if arr.len() >= 2 {
                return arr.len();
            }
        }
    }
    if let Some(s) = obj
        .get("extruder_variant_list")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(Value::as_str)
    {
        let c = s.split(',').count();
        if c >= 2 {
            return c;
        }
    }
    1
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
    for bundled in bundled_slicer_candidates() {
        if bundled.exists() && file_is_executable(&bundled) {
            return Ok(bundled);
        }
    }
    // Probe the OS install locations OrcaSlicer lands in. On macOS the binary
    // lives inside an `.app` bundle that is never on PATH, so `which` alone
    // can't find a normal drag-to-Applications install — these candidates are
    // what make "I just installed it" work without the user hand-entering a
    // path in Settings.
    for cand in well_known_slicer_paths() {
        if cand.exists() && file_is_executable(&cand) {
            return Ok(cand);
        }
    }
    // Last resort: PATH, under any of the common executable names.
    for name in ["orcaslicer", "OrcaSlicer", "orca-slicer"] {
        if let Ok(p) = which::which(name) {
            return Ok(p);
        }
    }
    Err(IpcError::new(
        "SLICER_NOT_FOUND",
        "no OrcaSlicer binary configured, bundled, in a standard install location, or on PATH",
    ))
}

/// Well-known OrcaSlicer install locations per platform, in priority order.
/// Pure (no filesystem access) so the candidate set is unit testable; the
/// caller filters to the ones that actually exist.
fn well_known_slicer_paths() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut out = Vec::new();

    #[cfg(target_os = "macos")]
    {
        // OrcaSlicer.app, in /Applications and ~/Applications.
        let bundles = [("OrcaSlicer.app", "OrcaSlicer")];
        let roots: Vec<PathBuf> = {
            let mut r = vec![PathBuf::from("/Applications")];
            if let Some(h) = &home {
                r.push(h.join("Applications"));
            }
            r
        };
        for root in &roots {
            for (app, bin) in &bundles {
                out.push(root.join(app).join("Contents/MacOS").join(bin));
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        for dir in ["/usr/bin", "/usr/local/bin", "/var/lib/flatpak/exports/bin"] {
            for bin in ["orca-slicer", "orcaslicer", "OrcaSlicer"] {
                out.push(PathBuf::from(dir).join(bin));
            }
        }
        if let Some(h) = &home {
            out.push(h.join(".local/bin/orca-slicer"));
            out.push(h.join(".local/bin/orcaslicer"));
        }
    }

    #[cfg(target_os = "windows")]
    {
        for root in ["C:/Program Files", "C:/Program Files (x86)"] {
            out.push(PathBuf::from(root).join("OrcaSlicer/orca-slicer.exe"));
            out.push(PathBuf::from(root).join("OrcaSlicer/OrcaSlicer.exe"));
        }
    }

    let _ = &home; // silence unused warning on platforms that don't read it
    out
}

/// Candidate paths for the OrcaSlicer we ship as a Tauri sidecar/resource,
/// resolved relative to the running executable, in priority order.
///
/// macOS is special: OrcaSlicer is a GUI `.app` that crashes (SIGKILL'd by the
/// OS) if its Mach-O binary is run detached from its `Contents/Resources` +
/// `Contents/Frameworks` siblings — so we must point at the binary *inside*
/// `OrcaSlicer.app`, never a bare copy. We ship the whole `.app` under
/// `resources/slicer/`, so we look for that bundle relative to a handful of
/// base dirs that cover both `cargo run` (binary in `target/<profile>/`) and a
/// packaged `.app` (resources land in `Contents/Resources/`).
///
/// On Linux/Windows the externalBin sidecar is a self-contained binary copied
/// next to the exe, so the bare name beside the executable is the candidate.
fn bundled_slicer_candidates() -> Vec<PathBuf> {
    let Some(exe) = std::env::current_exe().ok() else {
        return Vec::new();
    };
    let Some(parent) = exe.parent().map(Path::to_path_buf) else {
        return Vec::new();
    };
    let mut out = Vec::new();

    #[cfg(target_os = "macos")]
    {
        // Base dirs to look for the shipped `resources/slicer/` tree under.
        // `target/<profile>/` → `../../resources/slicer` reaches the repo copy
        // in dev; `Contents/MacOS` → `../Resources` reaches it in the bundle.
        let bases = [
            parent.clone(),
            parent.join(".."),
            parent.join("../.."),
            parent.join("../Resources"),
        ];
        for base in &bases {
            out.push(
                base.join("resources/slicer/OrcaSlicer.app/Contents/MacOS/OrcaSlicer"),
            );
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Tauri strips the target-triple suffix when it stages the sidecar, so
        // the runtime name is just `orcaslicer` next to the executable.
        let exe_suffix = if cfg!(target_os = "windows") {
            "orcaslicer.exe"
        } else {
            "orcaslicer"
        };
        out.push(parent.join(exe_suffix));
        out.push(parent.join("resources/slicer").join(exe_suffix));
    }

    out
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

/// Append an extension to a path, preserving the existing one
/// (`model.gcode` + `3mf` → `model.gcode.3mf`).
fn append_ext(path: &Path, ext: &str) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(".");
    s.push(ext);
    PathBuf::from(s)
}

fn gcode_path_for(mesh: &Path) -> PathBuf {
    let stem = mesh
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "model".to_string());
    let dir = mesh.parent().unwrap_or_else(|| Path::new(""));
    dir.join(format!("{stem}.gcode"))
}

/// Path for the sliced project `.3mf`. Named after the model (`<stem>.3mf`,
/// derived from the gcode path so it sits in the same output dir) so the
/// exported plate matches the source model name. Falls back to
/// `<stem>.gcode.3mf` when that would collide with the input mesh (e.g. the
/// model is itself a `.3mf`), so a slice never overwrites its own source.
fn sliced_3mf_path_for(mesh: &Path, gcode: &Path) -> PathBuf {
    let candidate = gcode.with_extension("3mf");
    if candidate == mesh {
        return append_ext(gcode, "3mf");
    }
    candidate
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
    /// `--load-settings` value: OrcaSlicer machine+process config path(s),
    /// `;`-joined. Empty = omit the flag.
    settings_profile: &'a str,
    /// `--load-filaments` value: OrcaSlicer filament config path(s). Empty =
    /// omit the flag.
    filament_profile: &'a str,
    /// Where to also write the sliced project `.3mf` (consumed by the cloud
    /// print path). Best-effort: if the slicer build ignores `--export-3mf`
    /// the gcode still lands and the cloud path simply has no 3mf to upload.
    export_3mf: &'a Path,
}

fn build_orcaslicer_args(inv: SlicerInvocation<'_>) -> Vec<String> {
    // OrcaSlicer's real CLI per `skills/gcode/references/slicer-backends.md`:
    //
    //   OrcaSlicer --load-settings "machine.json;process.json" \
    //              --load-filaments filament.json --outputdir /tmp/out \
    //              --slice 0 --export-3mf out.3mf input.stl
    //
    // There is NO `--filament-profile` flag — that crashed OrcaSlicer with an
    // unknown-option error. Profiles are passed as config files via
    // `--load-settings`/`--load-filaments`. v1 ships no bundled Bambu
    // profiles, so those come from `AppSettings` (`slicerSettingsProfile` /
    // `slicerFilamentProfile`); when unset we omit them and let OrcaSlicer
    // fall back to its own default/last-used config. `--orient 1` auto-orients
    // for the consumer flow.
    let mut args = vec!["--orient".to_string(), "1".to_string()];
    if !inv.settings_profile.trim().is_empty() {
        args.push("--load-settings".to_string());
        args.push(inv.settings_profile.trim().to_string());
    }
    if !inv.filament_profile.trim().is_empty() {
        args.push("--load-filaments".to_string());
        args.push(inv.filament_profile.trim().to_string());
    }
    args.extend([
        "--outputdir".to_string(),
        inv.out_dir.display().to_string(),
        "--slice".to_string(),
        "0".to_string(),
        // Also export the sliced project as a `.3mf` for the cloud upload
        // path (gcode is embedded). Comes after `--slice` so the plate is
        // sliced first; the positional mesh stays last.
        //
        // CRITICAL: OrcaSlicer resolves `--export-3mf` *relative to
        // `--outputdir`* — it prepends the output dir to whatever value we
        // pass. An absolute path therefore gets doubled
        // (`<outdir>/<outdir>/file.3mf`), which the slicer cannot open: it
        // slices the gcode fine but then aborts on the failed 3mf export and
        // exits non-zero, so the whole job is reported as SLICE_FAILED even
        // though the gcode landed. Pass only the basename; since `export_3mf`
        // always lives in `out_dir` it resolves to the intended location.
        // (Verified by hand: relative basename succeeds, absolute path fails.)
        "--export-3mf".to_string(),
        export_3mf_arg(inv.out_dir, inv.export_3mf),
        inv.mesh.display().to_string(),
    ]);
    args.shrink_to_fit();
    args
}

/// Value to pass to `--export-3mf`. OrcaSlicer resolves it relative to
/// `--outputdir`, so we strip `out_dir` from `export_3mf` (the 3mf always lives
/// there) and pass the remainder. Falls back to the bare file name if for some
/// reason the path isn't under `out_dir`, and to the full string only if it has
/// no file name at all — never an absolute path under `out_dir`, which would
/// double the directory and make the slicer fail the export.
fn export_3mf_arg(out_dir: &Path, export_3mf: &Path) -> String {
    if let Ok(rel) = export_3mf.strip_prefix(out_dir) {
        return rel.display().to_string();
    }
    export_3mf
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| export_3mf.display().to_string())
}

// ---------------------------------------------------------------------------
// Subprocess driver
// ---------------------------------------------------------------------------

struct SlicerOutcome {
    success: bool,
    exit_code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

async fn spawn_slicer(bin: &Path, args: &[String]) -> Result<SlicerOutcome, IpcError> {
    // Log the exact slicer invocation so it's visible in the terminal running
    // the app — quote each arg so paths with spaces are copy-pasteable.
    eprintln!(
        "[panda] executing slicer: {} {}",
        bin.display(),
        args.iter()
            .map(|a| format!("{a:?}"))
            .collect::<Vec<_>>()
            .join(" ")
    );

    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    // Reap the child if this future is dropped (caller cancelled / panicked)
    // so a half-run slice can't outlive the request as an orphan process.
    cmd.kill_on_drop(true);
    // OrcaSlicer runs headless in `--slice` mode (verified: it never registers
    // as a GUI/Dock app), so we inherit env unchanged and rely on the user's
    // profile path.

    let mut child = cmd.spawn().map_err(|e| {
        IpcError::new(
            "SLICE_FAILED",
            format!("failed to spawn slicer {}: {e}", bin.display()),
        )
    })?;

    let mut stdout_buf = Vec::new();
    let mut stderr_buf = Vec::new();
    let stdout_handle = child.stdout.take();
    let stderr_handle = child.stderr.take();
    // Drain BOTH pipes concurrently, then wait for exit under one deadline.
    // OrcaSlicer's `--slice` mode is verbose on stdout; leaving that pipe unread
    // lets it fill the OS pipe buffer (~64 KB on macOS), at which point the
    // slicer blocks forever on its next stdout write — a deadlock where the
    // process never exits, so stderr never reaches EOF and the only symptom is
    // a SLICE_TIMEOUT with the real cause lost. We capture stdout too because
    // OrcaSlicer prints genuine error diagnostics there, not only to stderr.
    // `read_to_end` completes when each pipe closes (process exit), so this
    // resolves as soon as the slicer is done.
    let run = async {
        let stdout_fut = async {
            if let Some(mut stdout) = stdout_handle {
                let _ = stdout.read_to_end(&mut stdout_buf).await;
            }
        };
        let stderr_fut = async {
            if let Some(mut stderr) = stderr_handle {
                let _ = stderr.read_to_end(&mut stderr_buf).await;
            }
        };
        tokio::join!(stdout_fut, stderr_fut);
        child.wait().await
    };

    let waited = tokio::time::timeout(SLICE_TIMEOUT, run).await;
    match waited {
        Ok(Ok(status)) => Ok(SlicerOutcome {
            success: status.success(),
            exit_code: status.code(),
            stdout: stdout_buf,
            stderr: stderr_buf,
        }),
        Ok(Err(e)) => Err(IpcError::new("SLICE_FAILED", e.to_string())),
        Err(_elapsed) => {
            // Wedged: signal the child to die. Use `start_kill` (send SIGKILL,
            // do NOT await the reap) rather than `kill().await`. We have seen
            // OrcaSlicer wedge in *uninterruptible* (`U`) wait, where the OS can
            // never reap the process — `kill().await` (which awaits `wait()`)
            // would then block forever, so `slice_run` never returns and the UI
            // spinner spins with no error ever surfacing. `start_kill` returns
            // immediately so SLICE_TIMEOUT propagates to the frontend; the
            // (possibly unreapable) child is left for `kill_on_drop` / the OS.
            let _ = child.start_kill();
            Err(IpcError::new(
                "SLICE_TIMEOUT",
                format!(
                    "slicer did not finish within {}s and was killed",
                    SLICE_TIMEOUT.as_secs()
                ),
            ))
        }
    }
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
    fn argv_uses_orcaslicer_flags_and_omits_profiles_when_unset() {
        let out = PathBuf::from("/tmp/slice-out");
        let mesh = PathBuf::from("/tmp/in.stl");
        let three_mf = PathBuf::from("/tmp/slice-out/in.gcode.3mf");
        let args = build_orcaslicer_args(SlicerInvocation {
            out_dir: &out,
            mesh: &mesh,
            settings_profile: "",
            filament_profile: "",
            export_3mf: &three_mf,
        });
        let outdir_idx = args.iter().position(|a| a == "--outputdir").unwrap();
        assert_eq!(args[outdir_idx + 1], "/tmp/slice-out");
        assert!(args.iter().any(|a| a == "--orient"));
        // The bogus flag is gone; with no profiles configured we pass neither.
        assert!(!args.contains(&"--filament-profile".to_string()));
        assert!(!args.contains(&"--load-settings".to_string()));
        assert!(!args.contains(&"--load-filaments".to_string()));
        assert_eq!(args.last().unwrap(), "/tmp/in.stl");
        let slice_idx = args.iter().position(|a| a == "--slice").unwrap();
        assert_eq!(args[slice_idx + 1], "0");
        let export_idx = args.iter().position(|a| a == "--export-3mf").unwrap();
        // Relative to --outputdir: OrcaSlicer prepends the output dir, so an
        // absolute path here would double the dir and fail the export.
        assert_eq!(args[export_idx + 1], "in.gcode.3mf");
    }

    #[test]
    fn argv_passes_configured_profiles_via_load_flags() {
        let out = PathBuf::from("/tmp/slice-out");
        let mesh = PathBuf::from("/tmp/in.stl");
        let three_mf = PathBuf::from("/tmp/slice-out/in.gcode.3mf");
        let args = build_orcaslicer_args(SlicerInvocation {
            out_dir: &out,
            mesh: &mesh,
            settings_profile: "/p/machine.json;/p/process.json",
            filament_profile: "/p/filament.json",
            export_3mf: &three_mf,
        });
        let s_idx = args.iter().position(|a| a == "--load-settings").unwrap();
        assert_eq!(args[s_idx + 1], "/p/machine.json;/p/process.json");
        let f_idx = args.iter().position(|a| a == "--load-filaments").unwrap();
        assert_eq!(args[f_idx + 1], "/p/filament.json");
        // Positional mesh still last; no bogus flag.
        assert_eq!(args.last().unwrap(), "/tmp/in.stl");
        assert!(!args.contains(&"--filament-profile".to_string()));
        // --export-3mf stays relative to --outputdir.
        let export_idx = args.iter().position(|a| a == "--export-3mf").unwrap();
        assert_eq!(args[export_idx + 1], "in.gcode.3mf");
    }

    #[test]
    fn export_3mf_arg_is_relative_to_outputdir() {
        // The 3mf lives under out_dir: pass only the part below it, never the
        // absolute path (which OrcaSlicer would prepend out_dir to and fail).
        assert_eq!(
            export_3mf_arg(
                Path::new("/tmp/slice-out"),
                Path::new("/tmp/slice-out/in.gcode.3mf"),
            ),
            "in.gcode.3mf"
        );
        // Not under out_dir (shouldn't happen, but be safe): fall back to the
        // bare file name rather than a doubling absolute path.
        assert_eq!(
            export_3mf_arg(
                Path::new("/tmp/slice-out"),
                Path::new("/elsewhere/in.gcode.3mf"),
            ),
            "in.gcode.3mf"
        );
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

    #[cfg(target_os = "macos")]
    #[test]
    fn well_known_paths_include_applications_app_bundle() {
        let cands = well_known_slicer_paths();
        // A standard drag-to-Applications OrcaSlicer install must be a
        // candidate, since its binary is never on PATH.
        assert!(cands.iter().any(|p| p
            == &PathBuf::from("/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer")));
    }

    #[test]
    fn gcode_path_relpath_preserves_workspace_directory() {
        let produced = PathBuf::from("/abs/projects/parts/lid.gcode");
        assert_eq!(produced_gcode_relpath(&produced, "parts/lid.stl"), "parts/lid.gcode");
        assert_eq!(produced_gcode_relpath(&produced, "model.stl"), "lid.gcode");
    }

    #[test]
    fn sliced_3mf_matches_model_name() {
        // The exported plate is named after the model, not `<stem>.gcode.3mf`.
        let mesh = PathBuf::from("/abs/projects/parts/lid.stl");
        let gcode = gcode_path_for(&mesh);
        assert_eq!(
            sliced_3mf_path_for(&mesh, &gcode),
            PathBuf::from("/abs/projects/parts/lid.3mf")
        );
    }

    #[test]
    fn sliced_3mf_falls_back_when_input_is_3mf() {
        // A `.3mf` input would collide with `<stem>.3mf`; keep the source intact.
        let mesh = PathBuf::from("/abs/projects/parts/lid.3mf");
        let gcode = gcode_path_for(&mesh);
        assert_eq!(
            sliced_3mf_path_for(&mesh, &gcode),
            PathBuf::from("/abs/projects/parts/lid.gcode.3mf")
        );
    }

    #[test]
    fn effective_profiles_honor_configured_values() {
        let mut settings = AppSettings::default();
        settings.slicer_settings_profile = "/p/machine.json;/p/process.json".into();
        settings.slicer_filament_profile = "/p/filament.json".into();
        // Configured profiles must pass through untouched, regardless of binary.
        let (s, f) = effective_profiles(
            &settings,
            Path::new("/nope/OrcaSlicer"),
            FilamentKind::Pla,
        );
        assert_eq!(s, "/p/machine.json;/p/process.json");
        assert_eq!(f, "/p/filament.json");
    }

    #[test]
    fn effective_profiles_empty_when_no_config_and_no_bundle() {
        // No configured profiles and a binary whose tree has no profiles dir:
        // we return empty (let the slicer surface its own message) rather than
        // inventing paths.
        let settings = AppSettings::default();
        let (s, f) = effective_profiles(
            &settings,
            Path::new("/nope/Contents/MacOS/OrcaSlicer"),
            FilamentKind::Pla,
        );
        assert_eq!(s, "");
        assert_eq!(f, "");
    }

    #[test]
    fn default_bambu_profiles_maps_filament_kind() {
        // Build a fake profile tree with the three expected files present.
        let tmp = std::env::temp_dir().join(format!(
            "panda-slicer-prof-{}",
            std::process::id()
        ));
        let bbl = tmp.join("BBL");
        for (sub, name) in [
            ("machine", "Bambu Lab X1 Carbon 0.4 nozzle.json"),
            ("process", "0.20mm Standard @BBL X1C.json"),
            ("filament", "Generic PLA High Speed @BBL X1C.json"),
            ("filament", "Generic PETG HF @BBL X1C.json"),
            ("filament", "Generic TPU for AMS @BBL X1C.json"),
        ] {
            let dir = bbl.join(sub);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(name), "{}").unwrap();
        }

        let pla = default_bambu_profiles(&tmp, FilamentKind::Pla).unwrap();
        assert!(pla.settings.contains("Bambu Lab X1 Carbon 0.4 nozzle.json"));
        assert!(pla.settings.contains("0.20mm Standard @BBL X1C.json"));
        assert!(pla.settings.contains(';'));
        assert!(pla.filaments.ends_with("Generic PLA High Speed @BBL X1C.json"));

        let petg = default_bambu_profiles(&tmp, FilamentKind::Petg).unwrap();
        assert!(petg.filaments.ends_with("Generic PETG HF @BBL X1C.json"));

        let tpu = default_bambu_profiles(&tmp, FilamentKind::Tpu).unwrap();
        assert!(tpu.filaments.ends_with("Generic TPU for AMS @BBL X1C.json"));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn default_bambu_profiles_none_when_files_missing() {
        let tmp = std::env::temp_dir().join(format!(
            "panda-slicer-empty-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(default_bambu_profiles(&tmp, FilamentKind::Pla).is_none());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn stderr_summary_picks_last_nonempty_line() {
        let stderr = b"warning: blah\nerror: profile not loaded\n";
        assert_eq!(stderr_summary(stderr), "error: profile not loaded");
        assert_eq!(stderr_summary(b""), "slicer exited non-zero with no stderr");
    }

    // --- Profile normalization -------------------------------------------

    #[test]
    fn flatten_inherits_merges_parent_then_child() {
        let tmp = std::env::temp_dir().join(format!("panda-prof-inh-{}", std::process::id()));
        let dir = tmp.join("machine");
        std::fs::create_dir_all(&dir).unwrap();
        // Parent holds the bed; leaf overrides nozzle and points at the parent.
        std::fs::write(
            dir.join("base.json"),
            r#"{"type":"machine","printable_area":["0x0","256x0","256x256","0x256"],"nozzle_diameter":["0.4"]}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("leaf.json"),
            r#"{"type":"machine","inherits":"base","name":"leaf","nozzle_diameter":["0.6"]}"#,
        )
        .unwrap();

        let merged = flatten_inherits(&dir.join("leaf.json"), &mut Vec::new()).unwrap();
        // Inherited field is now present...
        assert_eq!(
            merged["printable_area"],
            serde_json::json!(["0x0", "256x0", "256x256", "0x256"])
        );
        // ...child overrides the parent...
        assert_eq!(merged["nozzle_diameter"], serde_json::json!(["0.6"]));
        // ...and `inherits` is stripped from the output.
        assert!(!merged.contains_key("inherits"));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn flatten_inherits_none_when_parent_unresolvable() {
        let tmp = std::env::temp_dir().join(format!("panda-prof-miss-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("leaf.json"), r#"{"inherits":"nope","name":"x"}"#).unwrap();
        // Missing parent → None so the caller falls back to the original path.
        assert!(flatten_inherits(&tmp.join("leaf.json"), &mut Vec::new()).is_none());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn variant_count_detects_multi_variant() {
        let two: Map<String, Value> = serde_json::from_str(
            r#"{"printer_extruder_variant":["Direct Drive Standard","Direct Drive High Flow"]}"#,
        )
        .unwrap();
        assert_eq!(variant_count(&two), 2);

        let from_list: Map<String, Value> = serde_json::from_str(
            r#"{"extruder_variant_list":["Direct Drive Standard,Direct Drive High Flow"]}"#,
        )
        .unwrap();
        assert_eq!(variant_count(&from_list), 2);

        let single: Map<String, Value> =
            serde_json::from_str(r#"{"nozzle_diameter":["0.4"]}"#).unwrap();
        assert_eq!(variant_count(&single), 1);
    }

    #[test]
    fn collapse_variants_keeps_first_variant_only() {
        let mut obj: Map<String, Value> = serde_json::from_str(
            r#"{
                "printer_extruder_variant": ["Direct Drive Standard","Direct Drive High Flow"],
                "extruder_variant_list": ["Direct Drive Standard,Direct Drive High Flow"],
                "nozzle_volume": ["107","107"],
                "nozzle_diameter": ["0.4"],
                "machine_max_acceleration_e": ["5000","5000","5000","5000"],
                "compatible_printers": ["X1C 0.4","X1C 0.6"]
            }"#,
        )
        .unwrap();
        collapse_variants(&mut obj);

        // Per-variant arrays drop to the first variant.
        assert_eq!(
            obj["printer_extruder_variant"],
            serde_json::json!(["Direct Drive Standard"])
        );
        assert_eq!(
            obj["extruder_variant_list"],
            serde_json::json!(["Direct Drive Standard"])
        );
        assert_eq!(obj["nozzle_volume"], serde_json::json!(["107"]));
        // Single-entry and non-variant-length arrays are untouched.
        assert_eq!(obj["nozzle_diameter"], serde_json::json!(["0.4"]));
        assert_eq!(obj["machine_max_acceleration_e"].as_array().unwrap().len(), 4);
        // A compatibility list is never collapsed even at the variant length.
        assert_eq!(obj["compatible_printers"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn collapse_variants_noop_for_single_variant_profile() {
        // No `*_extruder_variant` field → variant_count 1 → leave pairs alone.
        let mut obj: Map<String, Value> =
            serde_json::from_str(r#"{"some_pair":["a","b"],"nozzle_diameter":["0.4"]}"#).unwrap();
        collapse_variants(&mut obj);
        assert_eq!(obj["some_pair"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn normalize_profile_to_writes_self_contained_single_variant() {
        let tmp = std::env::temp_dir().join(format!("panda-prof-norm-{}", std::process::id()));
        let mdir = tmp.join("machine");
        std::fs::create_dir_all(&mdir).unwrap();
        std::fs::write(
            mdir.join("base.json"),
            r#"{"type":"machine","printable_area":["0x0","256x256"]}"#,
        )
        .unwrap();
        std::fs::write(
            mdir.join("leaf.json"),
            r#"{"type":"machine","inherits":"base","name":"leaf","printer_extruder_variant":["A","B"],"nozzle_volume":["1","1"]}"#,
        )
        .unwrap();
        let out = tmp.join("out");
        std::fs::create_dir_all(&out).unwrap();

        let leaf = mdir.join("leaf.json").display().to_string();
        let result = normalize_profile_to(&leaf, &out, "settings-0.json");
        assert!(result.ends_with("settings-0.json"));

        let written: Map<String, Value> =
            serde_json::from_slice(&std::fs::read(&result).unwrap()).unwrap();
        assert!(written.contains_key("printable_area")); // inherited bed resolved
        assert!(!written.contains_key("inherits")); // chain stripped
        assert_eq!(written["printer_extruder_variant"], serde_json::json!(["A"])); // collapsed
        assert_eq!(written["nozzle_volume"], serde_json::json!(["1"]));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn normalize_profile_to_empty_input_is_empty() {
        let out = std::env::temp_dir();
        assert_eq!(normalize_profile_to("", &out, "x.json"), "");
        assert_eq!(normalize_profile_to("   ", &out, "x.json"), "");
    }
}
