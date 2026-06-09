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
    SliceStatus, SliceValidation,
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
    // Pre-slice gate (ported from the `gcode` skill's `inspect`): reject inputs
    // OrcaSlicer can't usefully slice — non-mesh formats, mesh formats this flow
    // doesn't convert, and already-sliced Bambu `.3mf` plates — with a clear
    // message instead of letting the slicer fail opaquely minutes later.
    inspect_mesh_input(&mesh_path)?;

    let settings = read_app_settings_for_slice().await;
    let slicer_bin = resolve_or_install_slicer(app, settings.slicer_binary_path.as_str()).await?;

    let gcode_path = gcode_path_for(&mesh_path);
    let out_dir = gcode_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir());
    tokio::fs::create_dir_all(&out_dir).await.ok();

    // Clear this model's prior gcode before slicing so a stale file can't shadow
    // the fresh result. `pick_produced_gcode` returns an existing `<stem>.gcode`
    // as-is, and OrcaSlicer always writes a *new* `plate_N.gcode` (never
    // `<stem>.gcode`), so without this a re-slice keeps returning the FIRST
    // slice's gcode — e.g. one made before support was enabled — while the freshly
    // produced `plate_N.gcode` is orphaned and never used. Removing it first makes
    // the `<stem>.gcode` shortcut valid again (it then only exists if OrcaSlicer,
    // or our rename, wrote it *this* run).
    remove_stale_gcode_outputs(&out_dir, &gcode_path).await;

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

    // Read the on-disk `--load-settings` files back and print their support keys
    // before they're deleted post-slice, so the actual JSON handed to OrcaSlicer
    // is visible (proves `enable_support` persisted into the process profile).
    log_loaded_support_settings(&settings_profile);

    // Pull the bed's printable area out of the (now inherit-resolved) machine
    // profile so the post-slice validator can bounds-check the toolpath. Read it
    // here, while the normalized temp copies still exist — they are removed right
    // after the spawn below. `None` (e.g. an un-normalized inheritance profile
    // with no resolved `printable_area`) just skips bounds checks.
    let motion_bounds = bounds_from_settings_profile(&settings_profile);

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
    // `PANDA_KEEP_SLICE_PROFILES=1` keeps them and logs the dir so the exact
    // `settings-*.json` handed to OrcaSlicer can be inspected (e.g. to confirm
    // `enable_support` was injected into the process profile).
    if let Some(dir) = &profile_tmp {
        if keep_slice_profiles() {
            eprintln!("[panda] kept slice profiles for inspection: {}", dir.display());
        } else {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
    let exec_result = exec_result?;

    if !exec_result.success {
        let summary = friendly_slice_failure(&exec_result.stdout, &exec_result.stderr);
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

    // Best-effort static validation of the produced toolpath (ported from the
    // `gcode` skill's `validate`). Non-fatal: findings are attached for the UI to
    // surface, but never turn a successful slice into a failure.
    let validation = run_gcode_validation(&produced_gcode, motion_bounds).await;

    // OrcaSlicer logs actionable findings about the *model* (floating regions,
    // unsupported overhangs, …) to stdout tagged `[warning]` even when the slice
    // succeeds — the same notices its GUI shows ("re-orient or enable support
    // generation"). The success path otherwise discards stdout, so pull them out
    // here for the UI to surface.
    let slicer_warnings = extract_slicer_warnings(&exec_result.stdout, &exec_result.stderr);

    let stats = SliceStats {
        duration_seconds: parsed.duration_seconds.unwrap_or(0.0),
        filament_grams: parsed.filament_grams.unwrap_or(0.0),
        filament_meters: parsed.filament_meters.unwrap_or(0.0),
        layer_count: parsed.layer_count.unwrap_or(0),
        supports_used: parsed.supports_used.unwrap_or(false),
        gcode_file: gcode_relpath,
        gcode_3mf_file,
        validation,
        slicer_warnings,
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

/// Locate the bundled OrcaSlicer profile tree relative to its binary, across
/// every packaging layout — so a fresh install slices against real Bambu
/// profiles on *all* platforms, not just macOS. Without this the CLI falls back
/// to OrcaSlicer's internal default config, which fails validation with
/// "Relative extruder addressing requires resetting the extruder position …
/// Add G92 E0 to layer_gcode" → `Slic3r::CLI::run found error`.
///
/// Layouts checked, in order:
///   - Windows/Linux portable: `<install>/resources/profiles` (exe at the tree
///     root, beside its `resources/`),
///   - macOS `.app`: `<…>/Contents/Resources/profiles` (binary in
///     `Contents/MacOS`, profiles a sibling under `Contents/Resources`).
///
/// Both lowercase (`resources`, Linux is case-sensitive) and capitalized
/// (`Resources`, the macOS bundle) spellings are covered. Returns `None` only
/// when no profile tree is present.
fn slicer_profiles_dir(slicer_bin: &Path) -> Option<PathBuf> {
    let bin_dir = slicer_bin.parent()?;
    let mut candidates = vec![
        bin_dir.join("resources/profiles"),
        bin_dir.join("Resources/profiles"),
    ];
    // macOS: the binary sits in `Contents/MacOS`, so the profile tree is one
    // level up under `Contents/Resources`.
    if let Some(contents) = bin_dir.parent() {
        candidates.push(contents.join("Resources/profiles"));
        candidates.push(contents.join("resources/profiles"));
    }
    candidates.into_iter().find(|p| p.is_dir())
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

/// `PANDA_KEEP_SLICE_PROFILES=1` (or any non-empty value other than `0`) keeps
/// the normalized profile temp dir after a slice instead of deleting it, so the
/// `settings-*.json` actually loaded by OrcaSlicer can be inspected. Off by
/// default. Note: a `.app` launched via Finder/`open` won't inherit the var —
/// run the binary (or `scripts/dev.sh`) from a shell that exports it.
fn keep_slice_profiles() -> bool {
    std::env::var("PANDA_KEEP_SLICE_PROFILES")
        .map(|v| !v.is_empty() && v != "0")
        .unwrap_or(false)
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
    force_enable_support(&mut obj);
    Some(obj)
}

/// Force support generation on for the slice by setting `enable_support` on the
/// *process* profile. OrcaSlicer has no safe `--enable-support` CLI flag (unknown
/// flags crash it — see `build_orcaslicer_args`), so we mutate the normalized
/// process JSON instead, the same way the bed/variant fixes are applied. Booleans
/// in OrcaSlicer config are the strings `"0"`/`"1"`. Gated on `"type":"process"`
/// so the machine and filament profiles (which also pass through here) are never
/// touched. Default Bambu/system process profiles inherit `enable_support: "0"`;
/// this overrides that to `"1"` and leaves `support_type` at the profile default
/// (`normal(auto)` / `tree(auto)`), so support is added only where the geometry
/// needs it.
fn force_enable_support(obj: &mut Map<String, Value>) {
    // Only the process profile gets support turned on; machine/filament profiles
    // pass through here too but must not gain an `enable_support` key.
    let profile_type = obj
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("<none>")
        .to_string();
    if profile_type == "process" {
        obj.insert("enable_support".to_string(), Value::String("1".to_string()));
    }
    // Force-print the resolved support settings for EVERY normalized profile.
    // Support is a key inside the loaded JSON, not a CLI flag (OrcaSlicer has
    // none — an unknown flag crashes it), so it never shows in the logged
    // `--load-settings` invocation. Printing unconditionally proves which file is
    // `type:process` and that `enable_support=1` actually landed on it; if no
    // line reads `type=process enable_support=1`, support is not being injected.
    let enable_support = obj
        .get("enable_support")
        .and_then(Value::as_str)
        .unwrap_or("-");
    let support_type = obj
        .get("support_type")
        .and_then(Value::as_str)
        .unwrap_or("-");
    eprintln!(
        "[panda] normalized profile: type={profile_type} enable_support={enable_support} support_type={support_type}"
    );
}

/// Read each `;`-joined `--load-settings` file from disk and print its
/// support-related keys (`type` + every key containing `support`, e.g.
/// `enable_support`, `support_type`, `tree_support_*`). Ground-truth dump of the
/// on-disk JSON OrcaSlicer is about to load — unlike `force_enable_support`,
/// which logs the in-memory map, this confirms the value actually persisted to
/// the temp file. Best-effort: an unreadable/non-JSON entry is noted and skipped.
fn log_loaded_support_settings(settings_profile: &str) {
    for path in settings_profile
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let Ok(bytes) = std::fs::read(path) else {
            eprintln!("[panda] settings file unreadable: {path}");
            continue;
        };
        let Ok(obj) = serde_json::from_slice::<Map<String, Value>>(&bytes) else {
            eprintln!("[panda] settings file not JSON: {path}");
            continue;
        };
        let mut keys: Vec<String> = obj
            .iter()
            .filter(|(k, _)| k.as_str() == "type" || k.contains("support"))
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        keys.sort();
        eprintln!(
            "[panda] support settings in {path}:\n    {}",
            keys.join("\n    ")
        );
    }
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

/// Resolve OrcaSlicer, installing it on first use if the machine has none.
///
/// This is what makes slicing work out of the box on *every* machine rather
/// than per-machine hand-holding: the bundle ships only a tiny placeholder
/// sidecar (the real slicer is ~150 MB — too large to embed), and a user may
/// have finished onboarding before the in-app installer existed. So "no slicer
/// yet" is an expected, recoverable state on a fresh install, not a hard error.
/// We download + install OrcaSlicer into the managed dir, then retry the
/// resolve exactly once. The placeholder sidecar can never be mistaken for a
/// real binary (`file_is_executable` requires the PE `MZ` magic on Windows), so
/// a stub install reliably surfaces as `SLICER_NOT_FOUND` and triggers this.
///
/// Install progress streams over `slicer_install_progress`; we also emit one
/// coarse `slice_progress` frame so the Slice button reads "Installing slicer…"
/// instead of hanging silently through a multi-minute first-run download.
async fn resolve_or_install_slicer(app: &AppHandle, configured: &str) -> Result<PathBuf, IpcError> {
    match resolve_slicer_binary(configured) {
        Ok(bin) => Ok(bin),
        Err(e) if e.code == "SLICER_NOT_FOUND" => {
            let _ = app.emit(
                SLICE_PROGRESS_EVENT,
                SliceProgressEvent {
                    stage: "installing_slicer".to_string(),
                    progress: 0.1,
                },
            );
            crate::commands::app::app_install_orcaslicer(app.clone()).await?;
            resolve_slicer_binary(configured)
        }
        Err(e) => Err(e),
    }
}

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
        // Panda's own managed install (the portable zip we extract during
        // onboarding) lives here — checked first so a Panda-installed slicer
        // is found without the user touching Settings.
        if let Some(dir) = managed_slicer_dir() {
            out.push(dir.join("orca-slicer.exe"));
            out.push(dir.join("OrcaSlicer.exe"));
        }
        for root in ["C:/Program Files", "C:/Program Files (x86)"] {
            out.push(PathBuf::from(root).join("OrcaSlicer/orca-slicer.exe"));
            out.push(PathBuf::from(root).join("OrcaSlicer/OrcaSlicer.exe"));
        }
    }

    let _ = &home; // silence unused warning on platforms that don't read it
    out
}

/// Directory Panda extracts its managed OrcaSlicer into on Windows. The
/// upstream Windows release is a portable zip with no installer, so Panda owns
/// the install location: `%LOCALAPPDATA%\Panda\OrcaSlicer`. Shared by
/// `well_known_slicer_paths()` (resolution) and the auto-installer in
/// `commands::app` so the two never disagree. `None` only if `LOCALAPPDATA` is
/// unset (effectively never on a real Windows session).
#[cfg(target_os = "windows")]
pub(crate) fn managed_slicer_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(|base| PathBuf::from(base).join("Panda").join("OrcaSlicer"))
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
        Ok(m) if m.is_file() && m.len() > 0 => {
            // On Windows the staged `externalBin` sidecar is a tiny *text*
            // placeholder (the 4-byte literal "stub") when no real OrcaSlicer
            // was bundled. A non-empty file isn't enough: require the DOS "MZ"
            // PE magic so a stub can never shadow a real install and get
            // spawned — Windows rejects a non-PE with os error 216
            // (ERROR_EXE_MACHINE_TYPE_MISMATCH), which is opaque to the user.
            #[cfg(target_os = "windows")]
            {
                file_starts_with_mz(p)
            }
            #[cfg(not(target_os = "windows"))]
            {
                true
            }
        }
        _ => false,
    }
}

/// True when `p` begins with the DOS `MZ` magic (`0x4D 0x5A`) — the first two
/// bytes of every Windows PE executable. Used to reject non-executable
/// placeholders during slicer resolution.
#[cfg(target_os = "windows")]
fn file_starts_with_mz(p: &Path) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(p) else {
        return false;
    };
    let mut magic = [0u8; 2];
    f.read_exact(&mut magic).is_ok() && &magic == b"MZ"
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

/// Remove this model's prior gcode output from `out_dir` before a slice: the
/// renamed `<stem>.gcode` and any orphaned `plate_*.gcode` OrcaSlicer left from a
/// previous run. Keeps `pick_produced_gcode` from returning a stale slice's
/// output. Best-effort — missing files / unreadable dir are ignored.
async fn remove_stale_gcode_outputs(out_dir: &Path, gcode_path: &Path) {
    let _ = tokio::fs::remove_file(gcode_path).await;
    if let Ok(mut rd) = tokio::fs::read_dir(out_dir).await {
        while let Ok(Some(entry)) = rd.next_entry().await {
            let p = entry.path();
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if name.starts_with("plate_") && name.ends_with(".gcode") {
                let _ = tokio::fs::remove_file(&p).await;
            }
        }
    }
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

/// Turn a failed OrcaSlicer run into a clear, actionable message. The CLI's own
/// last stderr line is usually the opaque `Slic3r::CLI::run found error, exit`;
/// the real, human-meaningful reason is an `[error]` line buried earlier in
/// stdout. Recognize the common ones and explain what to do; otherwise fall back
/// to the raw last line so nothing is hidden (the full tails ride in the IPC
/// error detail regardless).
fn friendly_slice_failure(stdout: &[u8], stderr: &[u8]) -> String {
    let haystack = format!(
        "{}\n{}",
        String::from_utf8_lossy(stdout),
        String::from_utf8_lossy(stderr)
    )
    .to_lowercase();

    // Model larger than the build volume, or positioned off the plate, so the
    // slicer finds nothing inside the printable area. This is the cryptic one:
    // its only stderr line is `Slic3r::CLI::run found error, exit`.
    if haystack.contains("no object is fully inside the print volume")
        || haystack.contains("nothing to be sliced")
    {
        return "This model doesn't fit the printer bed — it's larger than the build area or sits off the plate. Scale it down or split it into smaller parts, then slice again.".to_string();
    }

    // OrcaSlicer often prints its real failure reason to stdout rather than
    // stderr, so summarize stderr when present and fall back to stdout.
    if stderr.iter().any(|b| !b.is_ascii_whitespace()) {
        stderr_summary(stderr)
    } else {
        stderr_summary(stdout)
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

/// Marker OrcaSlicer prints ahead of its per-plate model warnings. Both the
/// non-critical and critical variants share it:
///   `… [warning] plate 1: found NON_CRITICAL slicing warnings: <message>`
///   `… [warning] plate 1: found slicing warnings: <message>, no_check=<n>`
const SLICING_WARNINGS_MARKER: &str = "slicing warnings:";

/// Extract OrcaSlicer's own model warnings from a *successful* run's captured
/// output. On a clean (exit 0) slice OrcaSlicer still logs actionable findings —
/// floating regions, unsupported overhangs, geometry outside the bed — to stdout
/// tagged `[warning]`, in the form above. These are exactly the "re-orient or
/// enable supports" notices the GUI surfaces; the CLI buries them in stdout,
/// which the success path otherwise drops on the floor.
///
/// We take the human message after the last [`SLICING_WARNINGS_MARKER`] on a line
/// (so the `[timestamp] [thread] [warning] plate N: found …` prefix is shed
/// regardless of its exact shape), drop the critical variant's trailing
/// `, no_check=<n>` bookkeeping, and de-duplicate. Scans stderr too, in case a
/// future build routes them there. Returns the messages in first-seen order.
fn extract_slicer_warnings(stdout: &[u8], stderr: &[u8]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in [stdout, stderr] {
        let text = String::from_utf8_lossy(raw);
        for line in text.lines() {
            let Some(idx) = line.rfind(SLICING_WARNINGS_MARKER) else {
                continue;
            };
            let tail = line[idx + SLICING_WARNINGS_MARKER.len()..].trim();
            // The critical-warning log line appends `, no_check=<n>`; strip it so
            // only the user-facing sentence survives.
            let msg = match tail.rfind(", no_check=") {
                Some(pos) => tail[..pos].trim(),
                None => tail,
            };
            if !msg.is_empty() && !out.iter().any(|m| m == msg) {
                out.push(msg.to_string());
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Pre-slice input inspection (ported from skills/gcode `inspect`)
// ---------------------------------------------------------------------------

/// Mesh extensions OrcaSlicer slices directly (no conversion).
const DIRECT_MESH_EXTENSIONS: &[&str] = &["stl", "obj", "3mf"];
/// Mesh extensions the `gcode` skill converts to STL via trimesh — this native
/// flow has no converter, so we reject them with guidance rather than feed an
/// unreadable input to OrcaSlicer.
const CONVERT_TO_STL_EXTENSIONS: &[&str] = &["ply", "glb", "gltf"];
/// Formats that are out of scope for slicing entirely (CAD/vector/robot).
const UNSUPPORTED_MESH_EXTENSIONS: &[&str] = &["step", "stp", "dxf", "svg", "urdf", "sdf"];

/// Classify a mesh input before slicing. Returns `Ok` only for a format
/// OrcaSlicer can slice as-is; otherwise an `IpcError` whose code the frontend
/// maps to actionable copy (`MESH_UNSUPPORTED` / `ALREADY_SLICED`).
fn inspect_mesh_input(mesh: &Path) -> Result<(), IpcError> {
    let ext = mesh
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if ext.is_empty() || UNSUPPORTED_MESH_EXTENSIONS.contains(&ext.as_str()) {
        let what = if ext.is_empty() {
            "files without an extension".to_string()
        } else {
            format!(".{ext} files")
        };
        return Err(IpcError::new(
            "MESH_UNSUPPORTED",
            format!("{what} can't be sliced. Provide a printable mesh (.stl)."),
        ));
    }
    if CONVERT_TO_STL_EXTENSIONS.contains(&ext.as_str()) {
        return Err(IpcError::new(
            "MESH_UNSUPPORTED",
            format!(".{ext} meshes must be converted to STL before slicing."),
        ));
    }
    if !DIRECT_MESH_EXTENSIONS.contains(&ext.as_str()) {
        return Err(IpcError::new(
            "MESH_UNSUPPORTED",
            format!("Unsupported mesh type .{ext}. Provide an STL."),
        ));
    }
    if ext == "3mf" && is_sliced_bambu_3mf(mesh) {
        return Err(IpcError::new(
            "ALREADY_SLICED",
            "This .3mf is already a sliced plate. Open it to print directly instead of re-slicing it.",
        ));
    }
    Ok(())
}

/// True when a `.3mf` is an already-sliced Bambu/OrcaSlicer project (it embeds
/// `Metadata/plate_<n>.gcode` toolpath entries) rather than a plain model.
///
/// A `.3mf` is a ZIP; rather than add a zip dependency we scan the file's tail,
/// where the ZIP central directory — which lists every entry name verbatim —
/// always lives. A model `.3mf` has no `Metadata/plate_*.gcode` entry.
fn is_sliced_bambu_3mf(path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    const NEEDLE: &[u8] = b"Metadata/plate_";
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if len == 0 {
        return false;
    }
    let window = len.min(512 * 1024);
    if file.seek(SeekFrom::Start(len - window)).is_err() {
        return false;
    }
    let mut buf = Vec::with_capacity(window as usize);
    if file.take(window).read_to_end(&mut buf).is_err() {
        return false;
    }
    buf.windows(NEEDLE.len()).enumerate().any(|(i, w)| {
        if w != NEEDLE {
            return false;
        }
        let rest = &buf[i + NEEDLE.len()..];
        let digits = rest.iter().take_while(|b| b.is_ascii_digit()).count();
        digits > 0 && rest.get(digits..digits + 6) == Some(&b".gcode"[..])
    })
}

// ---------------------------------------------------------------------------
// Post-slice G-code validation (ported from skills/gcode `validate`)
// ---------------------------------------------------------------------------

/// G-code commands the skill's validator recognizes. Anything else is reported
/// (as a warning) as "unrecognized" — not an error, since vendor firmware emits
/// many non-standard M-codes.
const SUPPORTED_GCODE_COMMANDS: &[&str] = &[
    "G0", "G1", "G2", "G3", "G4", "G21", "G28", "G29", "G90", "G91", "G92", "M18", "M73", "M82",
    "M83", "M84", "M104", "M106", "M107", "M109", "M117", "M118", "M140", "M190", "M201", "M203",
    "M204", "M205", "M220", "M221", "M400", "M500", "M501", "M900",
];

/// Bed/printer travel limits the validator bounds-checks absolute moves against.
#[derive(Debug, Clone, Copy)]
struct MotionBounds {
    x: (f64, f64),
    y: (f64, f64),
    z: (f64, f64),
}

/// Read the printable area from the first profile in a `--load-settings` list
/// that declares one (the machine profile). `None` when none do.
fn bounds_from_settings_profile(settings_profile: &str) -> Option<MotionBounds> {
    settings_profile
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .find_map(|p| bounds_from_profile_file(Path::new(p)))
}

/// Parse `printable_area` (`["0x0","256x0","256x256","0x256"]`) and
/// `printable_height` out of an OrcaSlicer machine profile into travel limits.
/// Z is unbounded (`INFINITY`) when `printable_height` is absent so we never
/// false-flag tall prints; X/Y default to `0..max(corner)`.
fn bounds_from_profile_file(path: &Path) -> Option<MotionBounds> {
    let bytes = std::fs::read(path).ok()?;
    let obj: Map<String, Value> = serde_json::from_slice(&bytes).ok()?;
    let area = obj.get("printable_area")?.as_array()?;
    let (mut x_max, mut y_max) = (0.0_f64, 0.0_f64);
    let mut saw = false;
    for corner in area {
        let s = corner.as_str()?;
        let mut parts = s.split('x');
        let x: f64 = parts.next()?.trim().parse().ok()?;
        let y: f64 = parts.next()?.trim().parse().ok()?;
        x_max = x_max.max(x);
        y_max = y_max.max(y);
        saw = true;
    }
    if !saw || x_max <= 0.0 || y_max <= 0.0 {
        return None;
    }
    let z_max = obj
        .get("printable_height")
        .and_then(profile_number)
        .filter(|z| *z > 0.0)
        .unwrap_or(f64::INFINITY);
    Some(MotionBounds {
        x: (0.0, x_max),
        y: (0.0, y_max),
        z: (0.0, z_max),
    })
}

/// A JSON value that may be a number or a numeric string (`"256"`).
fn profile_number(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
}

/// Read a produced `.gcode` and run the static validator. Best-effort: `None`
/// if the file can't be read (never fails the slice).
async fn run_gcode_validation(gcode: &Path, bounds: Option<MotionBounds>) -> Option<SliceValidation> {
    let bytes = tokio::fs::read(gcode).await.ok()?;
    Some(validate_gcode_text(&String::from_utf8_lossy(&bytes), bounds))
}

/// Static analysis of a sliced `.gcode`, ported from the `gcode` skill's
/// `validate_gcode_file`. `ok` is driven only by structural integrity (non-empty
/// + has movement + has extrusion) so it never false-fails real Bambu output;
/// bed-bounds, missing-temperature, and unrecognized-command findings are
/// warnings the caller can choose to surface.
fn validate_gcode_text(text: &str, bounds: Option<MotionBounds>) -> SliceValidation {
    let mut errors: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut unknown: Vec<(String, usize)> = Vec::new();
    let mut movement = 0u32;
    let mut extrusion = 0u32;
    let mut temperature = 0u32;
    let mut absolute = true;
    let mut warned_relative = false;
    let mut oob_count = 0u32;
    let mut oob_example: Option<String> = None;

    if text.trim().is_empty() {
        errors.push("G-code file is empty.".into());
    }

    for (idx, line) in text.lines().enumerate() {
        let line_no = idx + 1;
        let Some(command) = parse_gcode_command(line) else {
            continue;
        };
        let tokens = parse_gcode_axes(line);

        let is_tool = command.len() > 1
            && command.starts_with('T')
            && command[1..].bytes().all(|b| b.is_ascii_digit());
        if !SUPPORTED_GCODE_COMMANDS.contains(&command.as_str())
            && !is_tool
            && !unknown.iter().any(|(c, _)| c == &command)
        {
            unknown.push((command.clone(), line_no));
        }

        match command.as_str() {
            "G90" => absolute = true,
            "G91" => {
                absolute = false;
                if !warned_relative {
                    warned_relative = true;
                    warnings.push(
                        "Relative positioning (G91) is used; bed-bounds checks are skipped while it is active."
                            .into(),
                    );
                }
            }
            _ => {}
        }

        if matches!(command.as_str(), "G0" | "G1" | "G2" | "G3") {
            movement += 1;
            if command == "G1" && tokens.iter().any(|(k, _)| *k == 'E') {
                extrusion += 1;
            }
            if absolute {
                if let Some(b) = bounds {
                    for (axis, lo, hi) in
                        [('X', b.x.0, b.x.1), ('Y', b.y.0, b.y.1), ('Z', b.z.0, b.z.1)]
                    {
                        if let Some((_, v)) = tokens.iter().find(|(k, _)| *k == axis) {
                            if *v < lo || *v > hi {
                                oob_count += 1;
                                oob_example.get_or_insert_with(|| {
                                    format!("line {line_no}: {axis}={v} outside {lo}..{hi} mm")
                                });
                            }
                        }
                    }
                }
            }
        }
        if matches!(command.as_str(), "M104" | "M109" | "M140" | "M190") {
            temperature += 1;
        }
    }

    if movement == 0 {
        errors.push("No G0/G1/G2/G3 movement commands found.".into());
    }
    if extrusion == 0 {
        errors.push("No extrusion moves (a G1 with an E value) found.".into());
    }
    if temperature == 0 {
        // Detection is firmware-sensitive, so this is a heads-up, not a failure:
        // a profile may set temperatures via custom start G-code we don't model.
        warnings.push(
            "No standard temperature commands (M104/M109/M140/M190) detected; the profile may set them in custom start G-code."
                .into(),
        );
    }
    if oob_count > 0 {
        // Bounds are the profile's printable_area. Bambu firmware legitimately
        // moves outside it (purge/flush, nozzle wipe), so this is a heads-up,
        // not a failure.
        let example = oob_example.unwrap_or_default();
        warnings.push(format!(
            "{oob_count} move(s) fall outside the bed's printable area ({example}). Often normal for Bambu purge/wipe moves; verify the model fits the plate."
        ));
    }
    if !unknown.is_empty() {
        let sample = unknown
            .iter()
            .take(12)
            .map(|(c, l)| format!("{c} (line {l})"))
            .collect::<Vec<_>>()
            .join(", ");
        warnings.push(format!("Unrecognized G-code commands left unchanged: {sample}."));
    }

    SliceValidation {
        ok: errors.is_empty(),
        errors,
        warnings,
        movement_commands: movement,
        extrusion_moves: extrusion,
        temperature_commands: temperature,
    }
}

/// First token of a G-code line (comment stripped, uppercased). For a
/// `[GMT]<digits>(.<digits>)?` command the fractional part is dropped
/// (`G1.0` → `G1`). `None` for blank/comment-only lines.
fn parse_gcode_command(line: &str) -> Option<String> {
    let code = line.split(';').next().unwrap_or("").trim();
    if code.is_empty() {
        return None;
    }
    let first = code.split_whitespace().next()?.to_ascii_uppercase();
    Some(canonical_gmt_command(&first).unwrap_or(first))
}

/// If `tok` matches `[GMT]\d+(\.\d+)?`, return it with any fraction stripped;
/// otherwise `None` (caller keeps the raw token).
fn canonical_gmt_command(tok: &str) -> Option<String> {
    let mut chars = tok.chars();
    let head = chars.next()?;
    if !matches!(head, 'G' | 'M' | 'T') {
        return None;
    }
    let body: String = chars.collect();
    let (int_part, frac) = match body.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (body.as_str(), None),
    };
    if int_part.is_empty() || !int_part.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if let Some(f) = frac {
        if f.is_empty() || !f.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
    }
    Some(format!("{head}{int_part}"))
}

/// Extract `(letter, value)` pairs (`X12.3`, `E-0.5`, `.5`) from a G-code line,
/// comment stripped and uppercased — mirrors the skill's token regex.
fn parse_gcode_axes(line: &str) -> Vec<(char, f64)> {
    let code = line.split(';').next().unwrap_or("").to_ascii_uppercase();
    let bytes = code.as_bytes();
    let mut out: Vec<(char, f64)> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if !(bytes[i] as char).is_ascii_alphabetic() {
            i += 1;
            continue;
        }
        let letter = bytes[i] as char;
        let mut j = i + 1;
        let start = j;
        if j < bytes.len() && (bytes[j] == b'+' || bytes[j] == b'-') {
            j += 1;
        }
        let mut saw_digit = false;
        let mut saw_dot = false;
        while j < bytes.len() {
            let b = bytes[j];
            if b.is_ascii_digit() {
                saw_digit = true;
                j += 1;
            } else if b == b'.' && !saw_dot {
                saw_dot = true;
                j += 1;
            } else {
                break;
            }
        }
        if saw_digit {
            // Rust's f64 parser rejects a trailing dot (`12.`); trim it.
            let num = code[start..j].trim_end_matches('.');
            if let Ok(v) = num.parse::<f64>() {
                out.push((letter, v));
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out
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

    #[cfg(target_os = "windows")]
    #[test]
    fn file_is_executable_rejects_text_stub_accepts_pe() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("panda-exec-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        // The exact placeholder Tauri stages when no real sidecar was bundled.
        let stub = dir.join("orcaslicer-stub.exe");
        std::fs::File::create(&stub).unwrap().write_all(b"stub").unwrap();
        assert!(
            !file_is_executable(&stub),
            "a 4-byte text stub must not be treated as executable"
        );

        // A file that begins with the DOS MZ magic looks like a real PE.
        let pe = dir.join("orcaslicer-pe.exe");
        std::fs::File::create(&pe).unwrap().write_all(b"MZ\x90\x00rest").unwrap();
        assert!(
            file_is_executable(&pe),
            "a file with the MZ PE magic must be treated as executable"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn well_known_paths_include_managed_install_dir() {
        // Whatever LOCALAPPDATA is on the test host, the managed OrcaSlicer
        // path must be a resolution candidate so a Panda-installed slicer is
        // found with no configured path.
        let Some(dir) = managed_slicer_dir() else {
            return; // no LOCALAPPDATA in this env — nothing to assert
        };
        let cands = well_known_slicer_paths();
        assert!(
            cands.iter().any(|p| p == &dir.join("orca-slicer.exe")),
            "managed install dir must be a well-known candidate"
        );
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
    fn slicer_profiles_dir_finds_windows_linux_portable_layout() {
        // Regression: on Windows/Linux the exe sits at the install root beside
        // `resources/profiles`. The resolver used to only know the macOS
        // `.app/Contents/Resources/profiles` layout, so a fresh install passed
        // NO profiles and OrcaSlicer's default config failed CLI validation
        // ("Add G92 E0 to layer_gcode" → Slic3r::CLI::run found error).
        let root = std::env::temp_dir().join(format!("panda-prof-win-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let profiles = root.join("resources/profiles");
        std::fs::create_dir_all(&profiles).unwrap();
        let exe = root.join("orca-slicer.exe");
        std::fs::write(&exe, b"MZ").unwrap();

        assert_eq!(slicer_profiles_dir(&exe).as_deref(), Some(profiles.as_path()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn slicer_profiles_dir_finds_macos_app_layout() {
        // macOS: binary in Contents/MacOS, profiles under Contents/Resources.
        let root = std::env::temp_dir().join(format!("panda-prof-mac-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let macos = root.join("Contents/MacOS");
        let profiles = root.join("Contents/Resources/profiles");
        std::fs::create_dir_all(&macos).unwrap();
        std::fs::create_dir_all(&profiles).unwrap();
        let exe = macos.join("OrcaSlicer");
        std::fs::write(&exe, b"\x7fELF").unwrap();

        assert_eq!(slicer_profiles_dir(&exe).as_deref(), Some(profiles.as_path()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn slicer_profiles_dir_none_without_tree() {
        let root = std::env::temp_dir().join(format!("panda-prof-none-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let exe = root.join("orca-slicer.exe");
        std::fs::write(&exe, b"MZ").unwrap();
        assert!(slicer_profiles_dir(&exe).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// End-to-end smoke test of the real slice pipeline (profile resolution →
    /// normalization → CLI spawn) against an actually-installed OrcaSlicer.
    /// `#[ignore]`d because it needs the ~150 MB slicer present and takes tens of
    /// seconds; run manually after a slicer install with:
    ///   cargo test -- --ignored slice_pipeline_e2e
    /// Verifies the Windows profile-dir fix actually yields gcode (no
    /// "Slic3r::CLI::run found error"). Skips cleanly if no slicer/mesh is found.
    #[cfg(target_os = "windows")]
    #[tokio::test]
    #[ignore]
    async fn slice_pipeline_e2e_produces_gcode() {
        let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else {
            eprintln!("skip: LOCALAPPDATA unset");
            return;
        };
        let slicer_bin = local.join("Panda/OrcaSlicer/orca-slicer.exe");
        if !slicer_bin.exists() {
            eprintln!("skip: no installed slicer at {}", slicer_bin.display());
            return;
        }
        // Deterministic input: a 20 mm cube centered well inside the X1C bed, so
        // the test exercises the profile pipeline (the bug) and never the
        // separate "object doesn't fit the plate" condition.
        let mesh = std::env::temp_dir().join(format!("panda-e2e-cube-{}.stl", std::process::id()));
        std::fs::write(&mesh, cube_stl_ascii(118.0, 118.0, 0.0, 20.0)).unwrap();

        let settings = AppSettings::default();
        let (settings_profile, filament_profile) =
            effective_profiles(&settings, &slicer_bin, FilamentKind::Pla);
        assert!(
            !settings_profile.is_empty(),
            "the profile-dir fix must resolve bundled Bambu profiles; got empty"
        );

        let tmp = make_profile_tmpdir().expect("temp profile dir");
        let settings_profile = normalize_settings_list(&settings_profile, &tmp);
        let filament_profile = normalize_profile_to(&filament_profile, &tmp, "filament.json");

        let out_dir = std::env::temp_dir().join(format!("panda-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&out_dir).unwrap();
        let export_3mf = out_dir.join("plate.3mf");
        let args = build_orcaslicer_args(SlicerInvocation {
            out_dir: &out_dir,
            mesh: &mesh,
            settings_profile: &settings_profile,
            filament_profile: &filament_profile,
            export_3mf: &export_3mf,
        });

        let outcome = spawn_slicer(&slicer_bin, &args).await.expect("spawn ok");
        let gcode_count = std::fs::read_dir(&out_dir)
            .map(|rd| {
                rd.flatten()
                    .filter(|e| {
                        e.path()
                            .extension()
                            .and_then(|x| x.to_str())
                            .map(|x| x.eq_ignore_ascii_case("gcode"))
                            .unwrap_or(false)
                    })
                    .count()
            })
            .unwrap_or(0);
        let last_line = String::from_utf8_lossy(&outcome.stdout)
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .to_string();
        let _ = std::fs::remove_dir_all(&tmp);
        let _ = std::fs::remove_dir_all(&out_dir);
        let _ = std::fs::remove_file(&mesh);

        assert!(outcome.success, "slice failed: {last_line}");
        assert!(gcode_count > 0, "no gcode produced");
    }

    /// Minimal ASCII STL of an axis-aligned cube with its low corner at
    /// (`x`, `y`, `z`) and edge length `s`. Enough for a slice smoke test.
    #[cfg(target_os = "windows")]
    fn cube_stl_ascii(x: f64, y: f64, z: f64, s: f64) -> String {
        let v = [
            [x, y, z],
            [x + s, y, z],
            [x + s, y + s, z],
            [x, y + s, z],
            [x, y, z + s],
            [x + s, y, z + s],
            [x + s, y + s, z + s],
            [x, y + s, z + s],
        ];
        // 12 triangles (2 per face), winding outward (normals left zeroed —
        // slicers recompute them).
        let faces = [
            [0, 3, 2],
            [0, 2, 1], // bottom
            [4, 5, 6],
            [4, 6, 7], // top
            [0, 1, 5],
            [0, 5, 4], // front
            [1, 2, 6],
            [1, 6, 5], // right
            [2, 3, 7],
            [2, 7, 6], // back
            [3, 0, 4],
            [3, 4, 7], // left
        ];
        let mut s_out = String::from("solid cube\n");
        for f in faces {
            s_out.push_str("facet normal 0 0 0\nouter loop\n");
            for idx in f {
                let p = v[idx];
                s_out.push_str(&format!("vertex {} {} {}\n", p[0], p[1], p[2]));
            }
            s_out.push_str("endloop\nendfacet\n");
        }
        s_out.push_str("endsolid cube\n");
        s_out
    }

    #[test]
    fn stderr_summary_picks_last_nonempty_line() {
        let stderr = b"warning: blah\nerror: profile not loaded\n";
        assert_eq!(stderr_summary(stderr), "error: profile not loaded");
        assert_eq!(stderr_summary(b""), "slicer exited non-zero with no stderr");
    }

    #[test]
    fn friendly_slice_failure_explains_off_bed_model() {
        // The real "model too big / off plate" failure: the human reason is an
        // [error] line in stdout, while stderr only has the opaque CLI line.
        let stdout = b"best:-0.0 -0.0 1.0, costs:...\n[2026-06-09 14:57:22] [error]   plate 1: Nothing to be sliced, Either the print is empty or no object is fully inside the print volume before apply.\n";
        let stderr = b"\nSlic3r::CLI::run found error, exit\n";
        let msg = friendly_slice_failure(stdout, stderr);
        assert!(msg.contains("doesn't fit the printer bed"), "got: {msg}");
        assert!(!msg.contains("Slic3r::CLI"), "must not leak the opaque line");
    }

    #[test]
    fn friendly_slice_failure_falls_back_to_raw_summary() {
        // Unknown failure: surface the raw last line rather than a wrong guess.
        let stdout = b"";
        let stderr = b"error: something unexpected went wrong\n";
        assert_eq!(
            friendly_slice_failure(stdout, stderr),
            "error: something unexpected went wrong"
        );
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

    #[test]
    fn normalize_forces_support_on_process_profile_only() {
        let tmp = std::env::temp_dir().join(format!("panda-prof-support-{}", std::process::id()));
        let pdir = tmp.join("process");
        std::fs::create_dir_all(&pdir).unwrap();
        // A process profile inheriting the common's `enable_support: "0"`.
        std::fs::write(
            pdir.join("base.json"),
            r#"{"type":"process","enable_support":"0","support_type":"normal(auto)"}"#,
        )
        .unwrap();
        std::fs::write(
            pdir.join("leaf.json"),
            r#"{"type":"process","inherits":"base","name":"leaf"}"#,
        )
        .unwrap();
        let out = tmp.join("out");
        std::fs::create_dir_all(&out).unwrap();

        // Process profile: inherited disable is overridden to "1"; the profile's
        // own support_type is left untouched.
        let process = pdir.join("leaf.json").display().to_string();
        let res = normalize_profile_to(&process, &out, "settings-1.json");
        let written: Map<String, Value> =
            serde_json::from_slice(&std::fs::read(&res).unwrap()).unwrap();
        assert_eq!(written["enable_support"], serde_json::json!("1"));
        assert_eq!(written["support_type"], serde_json::json!("normal(auto)"));

        // A machine profile is never given an enable_support key.
        std::fs::write(
            pdir.join("machine.json"),
            r#"{"type":"machine","printable_area":["0x0","256x256"]}"#,
        )
        .unwrap();
        let machine = pdir.join("machine.json").display().to_string();
        let mres = normalize_profile_to(&machine, &out, "settings-0.json");
        let mwritten: Map<String, Value> =
            serde_json::from_slice(&std::fs::read(&mres).unwrap()).unwrap();
        assert!(!mwritten.contains_key("enable_support"));

        std::fs::remove_dir_all(&tmp).ok();
    }

    // --- Pre-slice input inspection --------------------------------------

    #[test]
    fn inspect_rejects_non_mesh_and_accepts_stl() {
        // Extension-only checks don't touch the filesystem.
        assert_eq!(
            inspect_mesh_input(Path::new("/x/part.step")).unwrap_err().code,
            "MESH_UNSUPPORTED"
        );
        assert_eq!(
            inspect_mesh_input(Path::new("/x/part.ply")).unwrap_err().code,
            "MESH_UNSUPPORTED"
        );
        assert_eq!(
            inspect_mesh_input(Path::new("/x/noext")).unwrap_err().code,
            "MESH_UNSUPPORTED"
        );
        // A plain STL passes (no `.3mf` content scan needed).
        assert!(inspect_mesh_input(Path::new("/x/part.stl")).is_ok());
        assert!(inspect_mesh_input(Path::new("/x/PART.STL")).is_ok());
    }

    #[test]
    fn inspect_rejects_already_sliced_3mf() {
        let tmp = std::env::temp_dir().join(format!("panda-3mf-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        // A model `.3mf` (no sliced-plate entry) is accepted...
        let model = tmp.join("model.3mf");
        std::fs::write(&model, b"PK\x03\x043D/3dmodel.model and other zip bytes").unwrap();
        assert!(inspect_mesh_input(&model).is_ok());
        // ...a sliced project `.3mf` (carries a `Metadata/plate_N.gcode` entry
        // name in its zip directory) is refused.
        let sliced = tmp.join("plate.3mf");
        std::fs::write(&sliced, b"PK\x03\x04....Metadata/plate_1.gcode....PK\x05\x06").unwrap();
        assert_eq!(
            inspect_mesh_input(&sliced).unwrap_err().code,
            "ALREADY_SLICED"
        );
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn is_sliced_bambu_3mf_matches_plate_entry_only() {
        let tmp = std::env::temp_dir().join(format!("panda-3mf-scan-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let plain = tmp.join("a.3mf");
        std::fs::write(&plain, b"Metadata/model_settings.config").unwrap();
        assert!(!is_sliced_bambu_3mf(&plain)); // "Metadata/plate_" prefix absent
        let with_letter = tmp.join("b.3mf");
        std::fs::write(&with_letter, b"Metadata/plate_no.gcode").unwrap();
        assert!(!is_sliced_bambu_3mf(&with_letter)); // needs a digit after the underscore
        let sliced = tmp.join("c.3mf");
        std::fs::write(&sliced, b"...Metadata/plate_12.gcode...").unwrap();
        assert!(is_sliced_bambu_3mf(&sliced));
        std::fs::remove_dir_all(&tmp).ok();
    }

    // --- Bed-bounds extraction -------------------------------------------

    #[test]
    fn bounds_parse_printable_area_and_height() {
        let tmp = std::env::temp_dir().join(format!("panda-bounds-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let machine = tmp.join("machine.json");
        std::fs::write(
            &machine,
            r#"{"printable_area":["0x0","256x0","256x256","0x256"],"printable_height":"250"}"#,
        )
        .unwrap();
        let b = bounds_from_profile_file(&machine).unwrap();
        assert_eq!(b.x, (0.0, 256.0));
        assert_eq!(b.y, (0.0, 256.0));
        assert_eq!(b.z, (0.0, 250.0));

        // A `;`-joined settings list: the first file with a printable_area wins.
        let process = tmp.join("process.json");
        std::fs::write(&process, r#"{"type":"process"}"#).unwrap();
        let list = format!("{};{}", process.display(), machine.display());
        assert!(bounds_from_settings_profile(&list).is_some());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn bounds_height_absent_leaves_z_unbounded() {
        let tmp = std::env::temp_dir().join(format!("panda-bounds-z-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let machine = tmp.join("m.json");
        std::fs::write(&machine, r#"{"printable_area":["0x0","180x180"]}"#).unwrap();
        let b = bounds_from_profile_file(&machine).unwrap();
        assert_eq!(b.x, (0.0, 180.0));
        assert!(b.z.1.is_infinite());
        std::fs::remove_dir_all(&tmp).ok();
    }

    // --- G-code token parsing --------------------------------------------

    #[test]
    fn parse_command_strips_fraction_and_skips_comments() {
        assert_eq!(parse_gcode_command("G1 X0 Y0").as_deref(), Some("G1"));
        assert_eq!(parse_gcode_command("g28").as_deref(), Some("G28")); // uppercased
        assert_eq!(parse_gcode_command("G1.0 X1").as_deref(), Some("G1")); // fraction dropped
        assert_eq!(parse_gcode_command("  ; just a comment").as_deref(), None);
        assert_eq!(parse_gcode_command("").as_deref(), None);
        // Non-GMT first token is returned verbatim (flagged as unknown later).
        assert_eq!(parse_gcode_command("FOO 1").as_deref(), Some("FOO"));
    }

    #[test]
    fn parse_axes_extracts_signed_and_decimal_values() {
        let t = parse_gcode_axes("G1 X12.3 Y-0.5 E.25 ; move");
        assert_eq!(t.iter().find(|(k, _)| *k == 'X').unwrap().1, 12.3);
        assert_eq!(t.iter().find(|(k, _)| *k == 'Y').unwrap().1, -0.5);
        assert_eq!(t.iter().find(|(k, _)| *k == 'E').unwrap().1, 0.25);
        // Trailing-dot form parses too (`Z12.` → 12.0).
        let t2 = parse_gcode_axes("G1 Z12.");
        assert_eq!(t2.iter().find(|(k, _)| *k == 'Z').unwrap().1, 12.0);
    }

    // --- G-code validation -----------------------------------------------

    fn bed(x: f64, y: f64, z: f64) -> MotionBounds {
        MotionBounds {
            x: (0.0, x),
            y: (0.0, y),
            z: (0.0, z),
        }
    }

    #[test]
    fn validate_accepts_well_formed_gcode() {
        let g = "\
; header\n\
M140 S60\n\
M104 S210\n\
G90\n\
G28\n\
G1 X10 Y10 Z0.2 E0.5\n\
G1 X20 Y20 E1.0\n";
        let v = validate_gcode_text(g, Some(bed(256.0, 256.0, 250.0)));
        assert!(v.ok, "errors: {:?}", v.errors);
        assert_eq!(v.movement_commands, 2);
        assert_eq!(v.extrusion_moves, 2);
        assert_eq!(v.temperature_commands, 2);
    }

    #[test]
    fn validate_flags_structural_failures_as_errors() {
        // Empty file.
        assert!(!validate_gcode_text("", None).ok);
        // Movement but no extrusion (E never appears).
        let no_extrude = "M104 S200\nG1 X10 Y10\nG1 X20 Y20\n";
        let v = validate_gcode_text(no_extrude, None);
        assert!(!v.ok);
        assert!(v.errors.iter().any(|e| e.contains("extrusion")));
        // Only temperature, no movement.
        let no_move = "M104 S200\nM140 S60\n";
        assert!(!validate_gcode_text(no_move, None).ok);
    }

    #[test]
    fn validate_missing_temperature_is_warning_not_error() {
        // Has movement + extrusion but no temp commands: still structurally ok.
        let g = "G1 X10 Y10 E0.5\nG1 X20 Y20 E1.0\n";
        let v = validate_gcode_text(g, None);
        assert!(v.ok);
        assert!(v.warnings.iter().any(|w| w.contains("temperature")));
    }

    #[test]
    fn validate_out_of_bounds_is_warning_not_error() {
        // X=500 exceeds a 256 bed, but the slice is still structurally valid —
        // bounds violations are warnings (Bambu purge/wipe moves are normal).
        let g = "M104 S200\nG90\nG1 X500 Y10 E0.5\n";
        let v = validate_gcode_text(g, Some(bed(256.0, 256.0, 250.0)));
        assert!(v.ok);
        assert!(v.warnings.iter().any(|w| w.contains("printable area")));
    }

    #[test]
    fn validate_skips_bounds_in_relative_mode() {
        // After G91 the big coordinate is a relative delta, not an absolute
        // position, so it must not be bounds-checked.
        let g = "M104 S200\nG91\nG1 X500 Y0 E0.5\n";
        let v = validate_gcode_text(g, Some(bed(256.0, 256.0, 250.0)));
        assert!(v.ok);
        assert!(v.warnings.iter().any(|w| w.contains("Relative positioning")));
        assert!(!v.warnings.iter().any(|w| w.contains("printable area")));
    }

    #[test]
    fn validate_reports_unknown_commands_as_warning() {
        let g = "M104 S200\nG1 X1 Y1 E0.1\nM9999 special\nT0\n";
        let v = validate_gcode_text(g, None);
        assert!(v.ok); // structurally fine
        // M9999 is unrecognized; T0 (tool change) is allowed.
        let unknown_warn = v
            .warnings
            .iter()
            .find(|w| w.contains("Unrecognized"))
            .expect("expected an unrecognized-command warning");
        assert!(unknown_warn.contains("M9999"));
        assert!(!unknown_warn.contains("T0"));
    }

    #[test]
    fn extracts_orcaslicer_floating_warning_from_stdout() {
        // Verbatim line OrcaSlicer 2.3.x prints on a *successful* slice (captured
        // from the bundled CLI): the `[timestamp] [thread] [warning] plate N:
        // found … slicing warnings:` prefix must be shed, leaving the message.
        let stdout = b"[2026-06-08 18:07:55.406089] [0x00000001f94c4240] [warning] plate 1: found NON_CRITICAL slicing warnings: It seems object float.stl has floating cantilever. Please re-orient the object or enable support generation.\n[2026-06-08 18:07:55.4] [0x1] [warning] no filament colors found in projects\n";
        let warnings = extract_slicer_warnings(stdout, b"");
        assert_eq!(
            warnings,
            vec![
                "It seems object float.stl has floating cantilever. Please re-orient the object or enable support generation."
                    .to_string()
            ]
        );
    }

    #[test]
    fn extracts_critical_warning_and_strips_no_check_suffix() {
        // The critical-warning variant appends `, no_check=<n>` bookkeeping; only
        // the user-facing sentence should survive.
        let stdout =
            b"[ts] [t] [warning] plate 1: found slicing warnings: Object exceeds the bed., no_check=0\n";
        let warnings = extract_slicer_warnings(stdout, b"");
        assert_eq!(warnings, vec!["Object exceeds the bed.".to_string()]);
    }

    #[test]
    fn extracts_slicer_warnings_dedups_and_ignores_noise() {
        // Duplicate plates report the same finding once; lines without the marker
        // (the version banner / orient cost dump) are ignored.
        let stdout = b"[ts] [t] [warning] cli mode, Current OrcaSlicer Version 2.3.2\norientation:0 0 1, cost:1600\n[ts] [t] [warning] plate 1: found NON_CRITICAL slicing warnings: Floating regions detected.\n[ts] [t] [warning] plate 2: found NON_CRITICAL slicing warnings: Floating regions detected.\n";
        let warnings = extract_slicer_warnings(stdout, b"");
        assert_eq!(warnings, vec!["Floating regions detected.".to_string()]);
    }

    #[test]
    fn extracts_no_warnings_from_clean_output() {
        let stdout = b"[ts] [t] [warning] cli mode, Current OrcaSlicer Version 2.3.2\n[ts] [t] [info] slicing complete\n";
        assert!(extract_slicer_warnings(stdout, b"").is_empty());
    }
}
