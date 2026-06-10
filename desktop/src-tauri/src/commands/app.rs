//! `app_*` IPC commands: app metadata, prereq check, settings I/O.

use crate::ipc::types::{
    AppInfo, AppSettings, ClaudeAuthStatus, ClaudeCliStatus, ClaudeInstallProgress,
    ClaudeLoginProgress, InstalledClaude, InstalledSlicer, PandaLoginProgress, PandaLoginResult,
    PrereqCheck, PythonStatus, SlicerInstallProgress, SlicerStatus,
};
use crate::ipc::{IpcError, IpcResult};
use crate::paths;
use crate::state::{AppState, PendingPandaLogin};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::process::Stdio;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, BufReader};
// Used by `download_slicer_asset`, which now runs on every platform (Windows
// gained a real OrcaSlicer auto-installer).
use tokio::io::AsyncWriteExt;

/// Tauri event channel for `claude_install_progress` payloads.
pub const CLAUDE_INSTALL_PROGRESS_EVENT: &str = "claude_install_progress";

/// Tauri event channel for `claude_login_progress` payloads.
pub const CLAUDE_LOGIN_PROGRESS_EVENT: &str = "claude_login_progress";

/// Tauri event channel for `panda_login_progress` payloads.
pub const PANDA_LOGIN_PROGRESS_EVENT: &str = "panda_login_progress";

/// How long to wait for the user to finish the browser OAuth flow before
/// giving up and killing `claude setup-token`. Generous: the user has to
/// switch to a browser, sign in, approve, then copy the authorization code
/// back into the app (`setup-token` uses the paste-the-code flow).
const LOGIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

/// Tauri event channel for `slicer_install_progress` payloads.
pub const SLICER_INSTALL_PROGRESS_EVENT: &str = "slicer_install_progress";

/// Pinned OrcaSlicer release, embedded at compile time so the runtime
/// auto-installer downloads exactly the version the bundled sidecar build
/// targets. Looks like `v2.3.2`.
const SLICER_VERSION_PIN: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../scripts/build/SLICER_VERSION.txt"));

/// Upstream installer script (macOS + Linux). 302-redirects to
/// `https://downloads.claude.ai/claude-code-releases/bootstrap.sh`.
#[cfg(not(target_os = "windows"))]
const CLAUDE_INSTALLER_URL: &str = "https://claude.ai/install.sh";

/// Upstream installer script (Windows). 302-redirects to
/// `https://downloads.claude.ai/claude-code-releases/bootstrap.ps1`. The
/// `param([ValidatePattern...] $Target)` script is invoked via PowerShell's
/// `-File <script> stable`, then delegates to `claude.exe install`, which
/// (as of installer 2.1.x) places the binary at `~/.local/bin/claude.exe`
/// and updates PATH. Both that dir and `%LOCALAPPDATA%\Programs\claude` are
/// on `augmented_path`, so detection finds it regardless of which the
/// installer picks.
#[cfg(target_os = "windows")]
const CLAUDE_INSTALLER_URL_WINDOWS: &str = "https://claude.ai/install.ps1";

/// Hard size cap for the installer body. The real script is ~6 KB today;
/// 100 KB is a generous ceiling that still rejects anything pathological
/// (HTML error page, redirect chain to a 1 GB payload, etc.).
const INSTALLER_MAX_BYTES: u64 = 100 * 1024;

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

#[tauri::command]
pub async fn app_info() -> IpcResult<AppInfo> {
    let root = paths::projects_root();
    tokio::fs::create_dir_all(&root).await.ok();
    Ok(AppInfo {
        root_path: root.display().to_string(),
        app_version: APP_VERSION.to_string(),
        pid: std::process::id(),
    })
}

#[tauri::command]
pub async fn app_prereq_check() -> IpcResult<PrereqCheck> {
    let claude_cli = detect_claude_cli();
    let python = detect_python();
    let slicer = detect_slicer();
    Ok(PrereqCheck {
        claude_cli,
        python,
        slicer,
    })
}

fn detect_claude_cli() -> ClaudeCliStatus {
    // Resolve `claude` exactly the way the chat driver does, so the
    // onboarding gate and the turn driver never disagree. `resolve_claude`
    // searches an *augmented* PATH that includes the usual user bin dirs
    // (npm global on Windows / ~/.local/bin / Homebrew) regardless of the
    // PATH the GUI process happened to inherit at launch — the bare
    // `which::which("claude")` we used before only saw the inherited PATH,
    // and its Unix-only fallback could never find a Windows npm install
    // (`%APPDATA%\npm\claude.cmd`). See claude_driver::augmented_path.
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let resolved = crate::commands::claude_driver::resolve_claude(&cwd);
    let found = resolved.is_some();
    let version = resolved.as_deref().and_then(claude_version);
    ClaudeCliStatus { found, version }
}

/// Run `<claude> --version` and return the trimmed output, or `None` if it
/// can't be executed. Detection treats only `found` as authoritative, so a
/// failed probe just leaves the version blank — it never blocks onboarding.
/// `path` is the resolved binary (an npm `claude.cmd` on Windows); std runs
/// batch wrappers directly, so no `cmd /C` wrapper is needed — see
/// `claude_driver::resolve_claude`.
fn claude_version(path: &Path) -> Option<String> {
    Command::new(path)
        .arg("--version")
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// The pinned sidecar build, embedded at compile time so the runtime version
/// check can never drift from what we actually ship. Looks like
/// `3.11.15+20260510` (CPython semver `+` python-build-standalone tag).
const PYTHON_VERSION_PIN: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../scripts/build/PYTHON_VERSION.txt"));

/// Smoke import that proves the interpreter can actually drive the cadpy
/// pipeline — mirrors the gate in `scripts/build/build-python-sidecar.sh`, so
/// "healthy" here means the same thing the build verified.
const PYTHON_SMOKE_IMPORT: &str = "import cadpy, cadquery, numpy, PIL, trimesh, vtk";

/// Resolve the interpreter we'd actually run, matching how the cadcode skill's
/// `python …/cad` resolves at turn time: the bundled CPython sidecar's `bin/`
/// (prepended to the driver's child PATH by `claude_driver::augmented_path`),
/// else a system `python3` so prereq UX is non-empty before the sidecar exists.
fn resolve_python() -> Option<PathBuf> {
    crate::commands::claude_driver::bundled_python_bin_dir()
        .map(|dir| dir.join("python3"))
        .filter(|p| p.exists())
        .or_else(|| which::which("python3").ok())
}

/// `major.minor` from the embedded pin: `3.11.15+20260510` -> `3.11`.
fn expected_py_minor() -> String {
    let semver = PYTHON_VERSION_PIN.trim().split('+').next().unwrap_or("");
    let mut parts = semver.split('.');
    match (parts.next(), parts.next()) {
        (Some(major), Some(minor)) => format!("{major}.{minor}"),
        _ => semver.to_string(),
    }
}

/// `<py> -c "print version"` → trimmed `major.minor.patch`, or `None` if the
/// probe can't run. Version is informational, so a failed probe just leaves it
/// blank rather than blocking onboarding.
fn python_version(py: &Path) -> Option<String> {
    Command::new(py)
        .args(["-c", "import sys;print('%d.%d.%d' % sys.version_info[:3])"])
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Does the interpreter import the full cadpy stack? This is the authoritative
/// "usable" check — version alone doesn't prove the vendored deps are intact.
fn python_smoke_ok(py: &Path) -> bool {
    Command::new(py)
        .args(["-c", PYTHON_SMOKE_IMPORT])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn detect_python() -> PythonStatus {
    let Some(py) = resolve_python() else {
        return PythonStatus {
            found: false,
            version: None,
            healthy: false,
        };
    };
    let version = python_version(&py);
    // Pin to major.minor: patch releases of the same line are drop-in, and the
    // smoke import catches anything the version tolerance lets through.
    let version_ok = version
        .as_deref()
        .map(|v| v == expected_py_minor() || v.starts_with(&format!("{}.", expected_py_minor())))
        .unwrap_or(false);
    let healthy = version_ok && python_smoke_ok(&py);
    PythonStatus {
        found: true,
        version,
        healthy,
    }
}

/// Cheap existence probe shared with `generation_status_read`, which polls it
/// often — it deliberately skips the version/smoke checks in `detect_python`
/// (those spawn the interpreter). Use `detect_python` for the full health view.
pub fn python_available_for_status() -> bool {
    resolve_python().is_some()
}

fn detect_slicer() -> SlicerStatus {
    // Reuse the exact resolution the slice path uses, so the onboarding gate
    // and the slicer command can never disagree — mirrors how
    // `detect_claude_cli` defers to `resolve_claude`. An empty `configured`
    // means "probe the bundled sidecar, then well-known install locations
    // (e.g. ~/Applications/OrcaSlicer.app on macOS), then PATH".
    match crate::commands::slicer::resolve_slicer_binary("") {
        Ok(path) => SlicerStatus {
            found: true,
            binary_path: path.display().to_string(),
        },
        Err(_) => SlicerStatus {
            found: false,
            binary_path: String::new(),
        },
    }
}

#[tauri::command]
pub async fn app_settings_read() -> IpcResult<AppSettings> {
    load_settings().await
}

/// Read persisted settings (or defaults) without going through the IPC
/// command wrapper. Shared by `app_settings_read` and the startup
/// auto-update check, which needs `auto_update` before any window exists.
pub async fn load_settings() -> IpcResult<AppSettings> {
    let path = paths::settings_path();
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let bytes = tokio::fs::read(&path).await.map_err(IpcError::from)?;
    if bytes.is_empty() {
        return Ok(AppSettings::default());
    }
    let settings: AppSettings = serde_json::from_slice(&bytes)
        .map_err(|e| IpcError::new("SETTINGS_PARSE_ERROR", e.to_string()))?;
    Ok(settings)
}

#[tauri::command]
pub async fn app_settings_write(settings: AppSettings) -> IpcResult<()> {
    let path = paths::settings_path();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(IpcError::from)?;
    }
    let bytes = serde_json::to_vec_pretty(&settings).map_err(IpcError::from)?;
    tokio::fs::write(&path, bytes).await.map_err(IpcError::from)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// app_install_claude_code (Track I)
// ---------------------------------------------------------------------------

/// One-click Claude Code installer. Fetches Anthropic's official
/// bootstrap script over HTTPS, runs it through `/bin/sh`, then re-runs
/// `detect_claude_cli` to confirm the binary landed on the user's PATH /
/// known install locations. Progress streams via the
/// `claude_install_progress` Tauri event.
///
/// Platform support: macOS + Linux run Anthropic's `install.sh` through
/// `/bin/sh`; Windows runs `install.ps1` through PowerShell (see the
/// `cfg(target_os = "windows")` variant below). Both verify via the same
/// `detect_claude_cli` probe `app_prereq_check` uses.
///
/// Windows one-click installer. Fetches Anthropic's official `install.ps1`
/// bootstrap over HTTPS (same size/scheme guards as the Unix path), writes
/// it to a temp `.ps1`, and runs it through Windows PowerShell with
/// `-ExecutionPolicy Bypass -File <script> stable`. The script downloads the
/// release and delegates to `claude.exe install`, which lands the binary at
/// `~/.local/bin/claude.exe` (already on `augmented_path`, so the verify
/// step finds it even though this process's PATH wasn't refreshed) and
/// updates the user PATH. Progress streams via `claude_install_progress`.
#[tauri::command]
#[cfg(target_os = "windows")]
pub async fn app_install_claude_code(app: tauri::AppHandle) -> IpcResult<InstalledClaude> {
    use std::os::windows::process::CommandExt;
    // Don't flash a console window when the GUI app spawns PowerShell.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let emit = |progress: ClaudeInstallProgress| {
        let _ = app.emit(CLAUDE_INSTALL_PROGRESS_EVENT, &progress);
    };

    // 1. Fetch the installer script (https + size-cap enforced, same as Unix).
    emit(ClaudeInstallProgress::Downloading {
        received_bytes: None,
        total_bytes: None,
    });

    let script = match fetch_installer(CLAUDE_INSTALLER_URL_WINDOWS).await {
        Ok(bytes) => bytes,
        Err(err) => {
            emit(ClaudeInstallProgress::Error {
                message: err.message.clone(),
            });
            return Err(err);
        }
    };

    emit(ClaudeInstallProgress::Downloading {
        received_bytes: Some(script.len() as u64),
        total_bytes: Some(script.len() as u64),
    });

    // 2. The bootstrap is a `param(...)` script, so it must be invoked via
    //    `-File <path> <Target>` (positional args don't survive piping to
    //    `-Command -`). Write it to a temp `.ps1`, keyed by PID so concurrent
    //    installs (there shouldn't be any, but be safe) don't collide.
    let script_path =
        std::env::temp_dir().join(format!("panda-claude-install-{}.ps1", std::process::id()));
    if let Err(err) = tokio::fs::write(&script_path, &script).await {
        let msg = format!("Failed to write installer script: {err}");
        emit(ClaudeInstallProgress::Error {
            message: msg.clone(),
        });
        return Err(IpcError::new("INSTALL_FAILED", msg));
    }

    emit(ClaudeInstallProgress::Running);

    // 3. Spawn PowerShell on the temp script. `-NoProfile -NonInteractive`
    //    keep it hermetic; `-ExecutionPolicy Bypass` lets the unsigned temp
    //    script run; `stable` pins the release channel (matching the Unix
    //    `sh -s -- stable`).
    let mut std_cmd = std::process::Command::new("powershell");
    std_cmd
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&script_path)
        .arg("stable")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);
    let mut cmd = tokio::process::Command::from(std_cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(err) => {
            let _ = tokio::fs::remove_file(&script_path).await;
            let msg = format!("Failed to spawn PowerShell installer: {err}");
            emit(ClaudeInstallProgress::Error {
                message: msg.clone(),
            });
            return Err(IpcError::new("INSTALL_FAILED", msg));
        }
    };

    let mut stdout_reader = BufReader::new(child.stdout.take().expect("stdout piped")).lines();
    let mut stderr_reader = BufReader::new(child.stderr.take().expect("stderr piped")).lines();

    let stderr_tail = std::sync::Arc::new(parking_lot::Mutex::new(Vec::<String>::new()));

    let stderr_tail_clone = stderr_tail.clone();
    let app_for_stderr = app.clone();
    let stderr_task = tokio::spawn(async move {
        while let Ok(Some(line)) = stderr_reader.next_line().await {
            if let Some(stage) = parse_progress_line(&line) {
                let _ = app_for_stderr.emit(CLAUDE_INSTALL_PROGRESS_EVENT, &stage);
            }
            let mut tail = stderr_tail_clone.lock();
            tail.push(line);
            if tail.len() > 20 {
                let drop_count = tail.len() - 20;
                tail.drain(0..drop_count);
            }
        }
    });

    let app_for_stdout = app.clone();
    let stdout_task = tokio::spawn(async move {
        while let Ok(Some(line)) = stdout_reader.next_line().await {
            if let Some(stage) = parse_progress_line(&line) {
                let _ = app_for_stdout.emit(CLAUDE_INSTALL_PROGRESS_EVENT, &stage);
            }
        }
    });

    let status = match child.wait().await {
        Ok(s) => s,
        Err(err) => {
            let _ = tokio::fs::remove_file(&script_path).await;
            let msg = format!("Installer subprocess errored: {err}");
            emit(ClaudeInstallProgress::Error {
                message: msg.clone(),
            });
            return Err(IpcError::new("INSTALL_FAILED", msg));
        }
    };

    let _ = stdout_task.await;
    let _ = stderr_task.await;
    let _ = tokio::fs::remove_file(&script_path).await;

    let stderr_lines = stderr_tail.lock().clone();

    if !status.success() {
        // Deep-dive aid: dump the full record to stderr (visible when the app
        // is launched from a terminal). The user-facing message is the
        // distilled reason — never PowerShell's `+ FullyQualifiedErrorId`
        // trailer, which the old "last non-empty line" heuristic surfaced.
        eprintln!(
            "[claude-install] PowerShell installer failed ({status}); stderr tail:\n{}",
            stderr_lines.join("\n")
        );
        let message = installer_error_message(&stderr_lines)
            .unwrap_or_else(|| format!("installer exited with {status}"));
        emit(ClaudeInstallProgress::Error {
            message: message.clone(),
        });
        return Err(IpcError::new("INSTALL_FAILED", message).with_detail(serde_json::json!({
            "exitCode": status.code(),
            "stderrTail": stderr_lines,
        })));
    }

    // 4. Verify post-install via the same probe `app_prereq_check` uses.
    emit(ClaudeInstallProgress::Verifying);

    let claude = detect_claude_cli();
    if !claude.found {
        let msg = "Installer exited cleanly but Claude CLI was not detected".to_string();
        emit(ClaudeInstallProgress::Error {
            message: msg.clone(),
        });
        return Err(
            IpcError::new("INSTALL_VERIFIED_MISSING", msg).with_detail(serde_json::json!({
                "stderrTail": stderr_lines,
            })),
        );
    }

    let version = claude.version.unwrap_or_default();
    let binary_path = resolve_claude_binary_path().unwrap_or_default();

    emit(ClaudeInstallProgress::Done {
        version: version.clone(),
        binary_path: binary_path.clone(),
    });

    Ok(InstalledClaude {
        version,
        binary_path,
    })
}

#[tauri::command]
#[cfg(not(target_os = "windows"))]
pub async fn app_install_claude_code(app: tauri::AppHandle) -> IpcResult<InstalledClaude> {
    let emit = |progress: ClaudeInstallProgress| {
        let _ = app.emit(CLAUDE_INSTALL_PROGRESS_EVENT, &progress);
    };

    // 1. Fetch the installer script. Emit a single Downloading marker at
    //    start so the React side can render "Downloading…" immediately;
    //    the script is small (~6 KB) so per-chunk streaming would just
    //    flicker.
    emit(ClaudeInstallProgress::Downloading {
        received_bytes: None,
        total_bytes: None,
    });

    let script = match fetch_installer(CLAUDE_INSTALLER_URL).await {
        Ok(bytes) => bytes,
        Err(err) => {
            emit(ClaudeInstallProgress::Error {
                message: err.message.clone(),
            });
            return Err(err);
        }
    };

    emit(ClaudeInstallProgress::Downloading {
        received_bytes: Some(script.len() as u64),
        total_bytes: Some(script.len() as u64),
    });

    // 2. Spawn `/bin/sh -s -- stable` with the script piped to stdin.
    //    Stream stdout + stderr line-by-line so we can map known phrases
    //    onto richer progress stages.
    emit(ClaudeInstallProgress::Running);

    let mut cmd = tokio::process::Command::new("/bin/sh");
    cmd.args(["-s", "--", "stable"]);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(err) => {
            let msg = format!("Failed to spawn installer: {err}");
            emit(ClaudeInstallProgress::Error {
                message: msg.clone(),
            });
            return Err(IpcError::new("INSTALL_FAILED", msg));
        }
    };

    // Write the script body into the child's stdin then drop the handle
    // so `sh` sees EOF.
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(err) = stdin.write_all(&script).await {
            let msg = format!("Failed to write installer to sh stdin: {err}");
            emit(ClaudeInstallProgress::Error {
                message: msg.clone(),
            });
            return Err(IpcError::new("INSTALL_FAILED", msg));
        }
        // Drop on exit of this block flushes + closes stdin.
        drop(stdin);
    }

    let mut stdout_reader = BufReader::new(child.stdout.take().expect("stdout piped")).lines();
    let mut stderr_reader = BufReader::new(child.stderr.take().expect("stderr piped")).lines();

    let stderr_tail = std::sync::Arc::new(parking_lot::Mutex::new(Vec::<String>::new()));

    let stderr_tail_clone = stderr_tail.clone();
    let app_for_stderr = app.clone();
    let stderr_task = tokio::spawn(async move {
        while let Ok(Some(line)) = stderr_reader.next_line().await {
            if let Some(stage) = parse_progress_line(&line) {
                let _ = app_for_stderr.emit(CLAUDE_INSTALL_PROGRESS_EVENT, &stage);
            }
            let mut tail = stderr_tail_clone.lock();
            tail.push(line);
            // Bound memory — keep only the last 20 stderr lines.
            if tail.len() > 20 {
                let drop_count = tail.len() - 20;
                tail.drain(0..drop_count);
            }
        }
    });

    let app_for_stdout = app.clone();
    let stdout_task = tokio::spawn(async move {
        while let Ok(Some(line)) = stdout_reader.next_line().await {
            if let Some(stage) = parse_progress_line(&line) {
                let _ = app_for_stdout.emit(CLAUDE_INSTALL_PROGRESS_EVENT, &stage);
            }
        }
    });

    let status = match child.wait().await {
        Ok(s) => s,
        Err(err) => {
            let msg = format!("Installer subprocess errored: {err}");
            emit(ClaudeInstallProgress::Error {
                message: msg.clone(),
            });
            return Err(IpcError::new("INSTALL_FAILED", msg));
        }
    };

    let _ = stdout_task.await;
    let _ = stderr_task.await;

    let stderr_lines = stderr_tail.lock().clone();

    if !status.success() {
        let last_line = stderr_lines
            .iter()
            .rev()
            .find(|l| !l.trim().is_empty())
            .cloned()
            .unwrap_or_else(|| format!("installer exited with {status}"));
        emit(ClaudeInstallProgress::Error {
            message: last_line.clone(),
        });
        return Err(IpcError::new("INSTALL_FAILED", last_line).with_detail(serde_json::json!({
            "exitCode": status.code(),
            "stderrTail": stderr_lines,
        })));
    }

    // 3. Verify post-install via the same probe `app_prereq_check` uses.
    emit(ClaudeInstallProgress::Verifying);

    let claude = detect_claude_cli();
    if !claude.found {
        let msg = "Installer exited cleanly but Claude CLI was not detected".to_string();
        emit(ClaudeInstallProgress::Error {
            message: msg.clone(),
        });
        return Err(IpcError::new("INSTALL_VERIFIED_MISSING", msg).with_detail(
            serde_json::json!({
                "stderrTail": stderr_lines,
            }),
        ));
    }

    let version = claude.version.unwrap_or_default();
    // `detect_claude_cli` reports `found` but doesn't expose the resolved
    // path — re-resolve it the same way for the response payload.
    let binary_path = resolve_claude_binary_path().unwrap_or_default();

    emit(ClaudeInstallProgress::Done {
        version: version.clone(),
        binary_path: binary_path.clone(),
    });

    Ok(InstalledClaude {
        version,
        binary_path,
    })
}

/// Pure helper: pull the installer body from `url`, enforcing the
/// https + size constraints. Kept module-public so tests can hit it
/// without spinning Tauri.
pub(crate) async fn fetch_installer(url: &str) -> IpcResult<Vec<u8>> {
    if !url.starts_with("https://") {
        return Err(IpcError::new(
            "INSTALLER_INSECURE_URL",
            format!("installer URL must be https, got {url}"),
        ));
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|e| IpcError::new("INSTALLER_CLIENT_ERROR", e.to_string()))?;
    fetch_installer_with(&client, url).await
}

/// Internal helper: do the HTTP fetch + size-cap enforcement against
/// an arbitrary `reqwest::Client` and `url`. Tests pass a plain-HTTP
/// client + a local mock-server URL so they can exercise the size cap
/// without standing up a TLS terminator.
async fn fetch_installer_with(client: &reqwest::Client, url: &str) -> IpcResult<Vec<u8>> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| IpcError::new("INSTALLER_FETCH_FAILED", e.to_string()))?;
    if !resp.status().is_success() {
        return Err(IpcError::new(
            "INSTALLER_FETCH_FAILED",
            format!("installer request returned HTTP {}", resp.status()),
        ));
    }
    if let Some(len) = resp.content_length() {
        if len > INSTALLER_MAX_BYTES {
            return Err(IpcError::new(
                "INSTALLER_TOO_LARGE",
                format!(
                    "installer body advertised {len} bytes (cap {INSTALLER_MAX_BYTES})"
                ),
            ));
        }
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| IpcError::new("INSTALLER_FETCH_FAILED", e.to_string()))?;
    if bytes.len() as u64 > INSTALLER_MAX_BYTES {
        return Err(IpcError::new(
            "INSTALLER_TOO_LARGE",
            format!(
                "installer body was {} bytes (cap {INSTALLER_MAX_BYTES})",
                bytes.len()
            ),
        ));
    }
    Ok(bytes.to_vec())
}

/// Pure helper: map a line of installer stdout/stderr onto a richer
/// progress stage when we can recognize it. Returns `None` for lines we
/// don't classify — the surrounding `Running` emission already covered
/// those.
pub(crate) fn parse_progress_line(line: &str) -> Option<ClaudeInstallProgress> {
    let lower = line.to_lowercase();
    // Anthropic's bootstrap.sh phases (as of 2026-05):
    //   "Downloading ..." while pulling the release tarball
    //   "Verifying ..." during checksum check
    //   "Installing ..." while running `claude install`
    if lower.contains("download") {
        return Some(ClaudeInstallProgress::Downloading {
            received_bytes: None,
            total_bytes: None,
        });
    }
    if lower.contains("verify") || lower.contains("checksum") {
        return Some(ClaudeInstallProgress::Verifying);
    }
    if lower.contains("install") || lower.contains("extract") {
        return Some(ClaudeInstallProgress::Running);
    }
    None
}

/// Pick the human-meaningful line out of a failed PowerShell installer's
/// stderr. The upstream `install.ps1` sets `$ErrorActionPreference = "Stop"`,
/// so every `Write-Error` becomes a terminating error that PowerShell renders
/// as a multi-line record:
///
/// ```text
/// C:\…\panda-claude-install-4236.ps1 : Installation failed (exit code 1)
///     + CategoryInfo          : NotSpecified: (:) [Write-Error], WriteErrorException
///     + FullyQualifiedErrorId : Microsoft.PowerShell.Commands.WriteErrorException,panda-claude-install-4236.ps1
/// ```
///
/// The naive "last non-empty line" surfaces the `+ FullyQualifiedErrorId`
/// trailer — pure noise. The real reason is the first line, prefixed with
/// `<script>.ps1 : ` (and possibly wrapped across the next few lines before
/// the first `+ …` frame). Extract that; fall back to the last line that
/// isn't an error-record frame for non-PowerShell stderr.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn installer_error_message(stderr_lines: &[String]) -> Option<String> {
    let is_frame = |l: &str| l.trim_start().starts_with('+');

    if let Some(start) = stderr_lines.iter().position(|l| l.contains(".ps1 : ")) {
        let head = stderr_lines[start]
            .split_once(".ps1 : ")
            .map(|(_, rest)| rest)
            .unwrap_or(&stderr_lines[start])
            .trim();
        let mut parts = vec![head.to_string()];
        // Fold wrapped continuation lines until the first `+ …` record frame.
        for line in &stderr_lines[start + 1..] {
            if is_frame(line) {
                break;
            }
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                parts.push(trimmed.to_string());
            }
        }
        let msg = parts.join(" ").trim().to_string();
        if !msg.is_empty() {
            return Some(msg);
        }
    }

    // No recognizable PowerShell error record — surface the last meaningful
    // line, skipping any `+ …` record frames.
    stderr_lines
        .iter()
        .rev()
        .map(|l| l.trim())
        .find(|l| !l.is_empty() && !l.starts_with('+'))
        .map(|l| l.to_string())
}

/// Same resolver as `detect_claude_cli`, but returns the resolved path
/// string. Pulled out so the post-install verify step doesn't need to
/// re-derive it from the `ClaudeCliStatus` (which intentionally hides the
/// path). Goes through `resolve_claude` (augmented PATH) so it finds the
/// npm-global / `~/.local/bin` / `%LOCALAPPDATA%\Programs\claude` install
/// the GUI process didn't inherit on PATH — on Windows it also follows a
/// `claude.cmd` shim to the real `claude.exe`.
fn resolve_claude_binary_path() -> Option<String> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    crate::commands::claude_driver::resolve_claude(&cwd).map(|p| p.display().to_string())
}

// ---------------------------------------------------------------------------
// Claude Code sign-in (setup-token OAuth) — Track I follow-up
// ---------------------------------------------------------------------------
//
// Why a separate flow from install: a freshly *installed* `claude` is not
// *authenticated*. The chat runs `claude -p` headless, where the interactive
// `/login` slash command does not exist ("/login isn't available in this
// environment"). Headless turns can only *read* credentials that already
// exist. So we drive `claude setup-token` — the official non-interactive
// auth path — which opens a browser OAuth flow (Claude Pro/Max subscription)
// and prints a 1-year token. We capture that token, persist it, and export it
// as `CLAUDE_CODE_OAUTH_TOKEN`; every spawned `claude` child inherits the
// parent process env, so subsequent turns authenticate transparently.

/// The user's home dir, honoring `HOME` then `USERPROFILE` (Windows). Matches
/// `claude_driver::home_dir`'s resolution so we look where the CLI actually
/// stores credentials.
fn user_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

/// Path to Claude Code's persisted credential file, honoring the
/// `CLAUDE_CONFIG_DIR` override the CLI itself respects. Used only to *detect*
/// that the user logged in interactively elsewhere — we never read its
/// contents.
fn claude_credentials_path() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(dir).join(".credentials.json"));
    }
    user_home().map(|h| h.join(".claude").join(".credentials.json"))
}

/// On macOS, Claude Code stores its OAuth credentials in the login **Keychain**
/// (generic-password service `Claude Code-credentials`), NOT in
/// `~/.claude/.credentials.json` (the Linux/Windows location, also used by macOS
/// only as a fallback when the Keychain is unavailable, e.g. headless SSH). So a
/// user who ran `claude` and signed in on macOS has *no* credentials file — the
/// file-only check reports "not signed in" and the welcome screen wrongly
/// disables "Use my own Claude Code". Probe the Keychain item's existence to
/// detect them.
///
/// We do an attribute-only lookup (no `-w`/`-g`): it returns exit 0 when the
/// item exists and, crucially, does **not** read the secret, so macOS shows no
/// "Panda wants to access the keychain" prompt. `security` lives at
/// `/usr/bin/security`, on the minimal launchd PATH, so a Finder-launched app
/// finds it.
#[cfg(target_os = "macos")]
fn claude_keychain_login() -> bool {
    std::process::Command::new("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn claude_keychain_login() -> bool {
    false
}

/// Non-empty env var → `true`. Treats whitespace-only as unset.
fn env_set(key: &str) -> bool {
    std::env::var(key)
        .ok()
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
}

/// Pure decision: given the three independent auth signals, what's the status?
/// Pulled out so the precedence is unit-testable without touching the
/// environment or filesystem. Precedence mirrors Claude Code's own:
/// an explicit API/OAuth token in the environment wins, then a token we
/// stored, then a credentials file from an interactive login.
fn resolve_auth_status(
    env_token: bool,
    stored_token: bool,
    credentials_file: bool,
) -> ClaudeAuthStatus {
    if env_token || stored_token {
        ClaudeAuthStatus {
            authenticated: true,
            source: Some("oauth_token".into()),
        }
    } else if credentials_file {
        ClaudeAuthStatus {
            authenticated: true,
            source: Some("credentials_file".into()),
        }
    } else {
        ClaudeAuthStatus {
            authenticated: false,
            source: None,
        }
    }
}

/// Gather the live auth signals and resolve them. Async only because reading
/// persisted settings is async.
async fn detect_claude_auth() -> ClaudeAuthStatus {
    // An OAuth token or API key already exported into our environment — set by
    // `apply_stored_oauth_token_to_env` at startup, by a just-completed login,
    // or by the user/CI directly.
    let env_token = env_set("CLAUDE_CODE_OAUTH_TOKEN")
        || env_set("ANTHROPIC_API_KEY")
        || env_set("ANTHROPIC_AUTH_TOKEN");
    let stored_token = load_settings()
        .await
        .ok()
        .and_then(|s| s.claude_oauth_token)
        .map(|t| !t.trim().is_empty())
        .unwrap_or(false);
    // An interactive `claude` login elsewhere: the credentials file (Linux/
    // Windows, or the macOS SSH fallback) OR the macOS login Keychain.
    let credentials_present = claude_credentials_path()
        .map(|p| p.is_file())
        .unwrap_or(false)
        || claude_keychain_login();
    resolve_auth_status(env_token, stored_token, credentials_present)
}

/// Is the user authenticated to Claude Code? Onboarding gates the chat on this
/// the same way it gates on the CLI being installed.
#[tauri::command]
pub async fn app_auth_check() -> IpcResult<ClaudeAuthStatus> {
    Ok(detect_claude_auth().await)
}

/// Export a stored OAuth token into this process's environment so every
/// spawned `claude` child inherits it. No-op if the variable is already set
/// (don't clobber an explicit env/CI token) or if nothing is stored. Called
/// once at startup; login also sets it directly so no restart is needed.
pub async fn apply_stored_oauth_token_to_env() {
    if std::env::var_os("CLAUDE_CODE_OAUTH_TOKEN").is_some() {
        return;
    }
    if let Ok(settings) = load_settings().await {
        if let Some(token) = settings.claude_oauth_token {
            if !token.trim().is_empty() {
                std::env::set_var("CLAUDE_CODE_OAUTH_TOKEN", token);
            }
        }
    }
}

/// Persist a captured OAuth token into settings (preserving the rest) and
/// export it immediately.
async fn store_oauth_token(token: &str) -> IpcResult<()> {
    let mut settings = load_settings().await.unwrap_or_default();
    settings.claude_oauth_token = Some(token.to_string());
    app_settings_write(settings).await?;
    std::env::set_var("CLAUDE_CODE_OAUTH_TOKEN", token);
    Ok(())
}

// ---------------------------------------------------------------------------
// app_panda_login — proxy sign-in to Panda's hosted Claude server
// ---------------------------------------------------------------------------
//
// The "Sign in with Panda" path on the welcome screen. It runs the BE's PKCE +
// custom-scheme deep-link OAuth flow (see docs `APP_INTEGRATION`): open the
// hosted login in the system browser, receive the one-time `code` back via the
// `myide://auth/callback` deep link, exchange it for a `ccr-…` key, and
// persist `{panda_token, panda_base_url, use_panda_cloud=true}`. The chat driver
// then routes `claude -p` through the proxy with `ANTHROPIC_BASE_URL` +
// `ANTHROPIC_AUTH_TOKEN` (see `claude_driver::build_env`), so the user runs
// Panda's Claude without a Claude subscription of their own. The local `claude`
// binary is still the runtime — the welcome screen installs it first if missing;
// the proxy only redirects the API. The user never sees the key.

/// Panda hosted sign-in endpoints (BE contract). WEB hosts the login page the
/// browser opens; API exchanges the one-time code for the proxy key; PROXY is
/// the `ANTHROPIC_BASE_URL` the issued key authenticates against (the exchange
/// also returns it as `baseUrl`, which we prefer and persist).
const PANDA_WEB_URL: &str = "https://panda.autonomous.ai";
const PANDA_API_URL: &str = "https://panda-dashboard-api.autonomous.ai";
pub const PANDA_PROXY_URL: &str = "https://api-panda.autonomous.ai";

/// Custom URL scheme the OS routes back to the app so the browser can hand over
/// the OAuth `code`. MUST stay in sync with `tauri.conf.json`
/// (`plugins.deep-link.desktop.schemes`) and the BE redirect allowlist.
const PANDA_SCHEME: &str = "myide://";
const PANDA_REDIRECT_URI: &str = "myide://auth/callback";

/// A URL-safe, unpadded base64 of 32 random bytes (two getrandom-backed v4
/// UUIDs). Used for the PKCE `code_verifier` — avoids pulling in a new RNG dep.
fn random_b64url_32() -> String {
    use base64::Engine as _;
    let mut bytes = Vec::with_capacity(32);
    bytes.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// PKCE S256 challenge: `BASE64URL(SHA256(verifier))`, unpadded.
fn pkce_challenge(verifier: &str) -> String {
    use base64::Engine as _;
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

/// Build the hosted login URL with the PKCE challenge + CSRF state, percent-
/// encoding each value.
fn build_login_url(challenge: &str, state: &str) -> String {
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    let redirect = utf8_percent_encode(PANDA_REDIRECT_URI, NON_ALPHANUMERIC);
    let challenge = utf8_percent_encode(challenge, NON_ALPHANUMERIC);
    let state = utf8_percent_encode(state, NON_ALPHANUMERIC);
    format!(
        "{PANDA_WEB_URL}/login?redirect_uri={redirect}&code_challenge={challenge}\
         &code_challenge_method=S256&state={state}"
    )
}

/// Extract `code` + `state` from a deep-link callback URL like
/// `myide://auth/callback?code=…&state=…`. Tolerant of host/path
/// variants — only the query matters. `None` if either param is absent.
fn parse_panda_callback(url: &str) -> Option<(String, String)> {
    let query = url.split_once('?').map(|(_, q)| q)?;
    let mut code = None;
    let mut state = None;
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            let value = percent_encoding::percent_decode_str(v)
                .decode_utf8_lossy()
                .to_string();
            match k {
                "code" => code = Some(value),
                "state" => state = Some(value),
                _ => {}
            }
        }
    }
    match (code, state) {
        (Some(c), Some(s)) => Some((c, s)),
        _ => None,
    }
}

/// Handle an incoming `myide://auth/callback?…` deep link: match the
/// CSRF `state` against the armed sign-in and deliver the `code` (or an error)
/// to the waiting `app_panda_login` via its oneshot. No-op if the URL isn't our
/// callback or no sign-in is pending. Called from both the deep-link plugin's
/// `on_open_url` (cold start) and the single-instance callback (Windows/Linux
/// warm start, where the URL arrives as a second process's argv).
pub fn handle_panda_deeplink(app: &tauri::AppHandle, url: &str) {
    use tauri::Manager as _;
    if !url.starts_with(PANDA_SCHEME) {
        #[cfg(debug_assertions)]
        eprintln!("[panda deeplink] ignoring non-myide url: {url}");
        return;
    }
    let Some(pending) = app.state::<AppState>().take_pending_panda_login() else {
        #[cfg(debug_assertions)]
        eprintln!("[panda deeplink] got {url} but NO pending login was armed — dropping");
        return;
    };
    let result = match parse_panda_callback(url) {
        Some((code, state)) if state == pending.state => {
            #[cfg(debug_assertions)]
            eprintln!("[panda deeplink] state matched; delivering code (len {})", code.len());
            Ok(code)
        }
        Some((_, state)) => {
            #[cfg(debug_assertions)]
            eprintln!(
                "[panda deeplink] STATE MISMATCH: callback state={state:?} expected={:?}",
                pending.state
            );
            Err(
                "Sign-in response didn't match this request (state mismatch). Please try again."
                    .to_string(),
            )
        }
        None => {
            #[cfg(debug_assertions)]
            eprintln!("[panda deeplink] callback missing code/state: {url}");
            Err("Sign-in response was missing its authorization code.".to_string())
        }
    };
    let _ = pending.tx.send(result);
}

#[derive(serde::Deserialize)]
struct PandaExchangeResponse {
    key: String,
    #[serde(rename = "baseUrl")]
    base_url: String,
}

/// POST the one-time `code` + PKCE `verifier` to the Panda exchange endpoint and
/// return `(key, base_url)`. Maps the documented 400 error codes to friendly
/// copy.
///
/// Retries only on **transient** failures — a transport error (no response) or
/// an HTTP 5xx/429 — with a short exponential backoff. Terminal responses (the
/// documented 4xx codes like `code_expired` / `invalid_or_used_code`) are NOT
/// retried: the `code` is single-use, so re-sending it after the server has
/// already judged it is pointless and could only ever fail the same way. The
/// same code is reused across transient retries because a 5xx/transport error
/// means the server never consumed it.
async fn exchange_code_for_key(code: &str, verifier: &str) -> IpcResult<(String, String)> {
    const MAX_ATTEMPTS: u32 = 3;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(3))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| IpcError::new("PANDA_EXCHANGE_FAILED", e.to_string()))?;
    let body = serde_json::json!({ "code": code, "code_verifier": verifier });
    let url = format!("{PANDA_API_URL}/api/auth/exchange");

    let mut attempt = 0;
    loop {
        attempt += 1;
        let transient_err: String = match client.post(&url).json(&body).send().await {
            Ok(resp) => {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                if status.is_success() {
                    let parsed: PandaExchangeResponse =
                        serde_json::from_str(&text).map_err(|e| {
                            IpcError::new(
                                "PANDA_EXCHANGE_FAILED",
                                format!("unexpected sign-in response: {e}"),
                            )
                        })?;
                    return Ok((parsed.key, parsed.base_url));
                }
                // 5xx / 429 → transient; any other non-2xx (e.g. the 400 codes)
                // is terminal and surfaced immediately.
                let transient = status.is_server_error()
                    || status == reqwest::StatusCode::TOO_MANY_REQUESTS;
                if !transient {
                    return Err(IpcError::new("PANDA_EXCHANGE_FAILED", map_exchange_error(&text)));
                }
                format!("Panda sign-in service returned HTTP {status}")
            }
            Err(e) => format!("could not reach Panda sign-in: {e}"),
        };

        if attempt >= MAX_ATTEMPTS {
            return Err(IpcError::new("PANDA_EXCHANGE_FAILED", transient_err));
        }
        // Exponential backoff: 300ms, then 600ms.
        let delay = std::time::Duration::from_millis(300 * 2u64.pow(attempt - 1));
        tokio::time::sleep(delay).await;
    }
}

/// Friendly copy for the documented exchange error codes. The body looks like
/// `{"error":"code_expired"}`; we match on the code as a substring.
fn map_exchange_error(body: &str) -> String {
    let b = body.to_ascii_lowercase();
    if b.contains("code_expired") {
        "Your sign-in link expired. Please try signing in again.".to_string()
    } else if b.contains("invalid_or_used_code") {
        "That sign-in link was already used. Please try signing in again.".to_string()
    } else if b.contains("pkce_verification_failed") {
        "Sign-in verification failed. Please try again.".to_string()
    } else if b.contains("invalid_redirect_uri") {
        "This app isn't authorized for Panda sign-in yet. Please update the app.".to_string()
    } else {
        "Panda sign-in failed. Please try again.".to_string()
    }
}

/// Persist a Panda proxy session (key + base URL) and enable `use_panda_cloud`,
/// preserving the rest of settings. Mirrors [`store_oauth_token`]. The chat
/// driver reads these to route `claude -p` through Panda's proxy with
/// `ANTHROPIC_AUTH_TOKEN`.
async fn store_panda_session(key: &str, base_url: &str) -> IpcResult<()> {
    let mut settings = load_settings().await.unwrap_or_default();
    settings.panda_token = Some(key.to_string());
    settings.panda_base_url = Some(base_url.to_string());
    settings.use_panda_cloud = true;
    app_settings_write(settings).await
}

/// Switch the active Claude access mode from the chat UI without re-onboarding.
/// `use_panda_cloud = true` routes chat through Panda's proxy; `false` uses the
/// user's own local Claude Code auth. Enabling the proxy requires a stored
/// `panda_token` (the user must have signed in with Panda). Returns the updated
/// settings so the UI can reflect the new mode immediately.
#[tauri::command]
pub async fn app_set_auth_mode(use_panda_cloud: bool) -> IpcResult<AppSettings> {
    let mut settings = load_settings().await.unwrap_or_default();
    let has_token = settings
        .panda_token
        .as_deref()
        .map(|t| !t.trim().is_empty())
        .unwrap_or(false);
    if use_panda_cloud && !has_token {
        return Err(IpcError::new(
            "PANDA_NOT_SIGNED_IN",
            "Sign in with Panda before switching to the Panda proxy.".to_string(),
        ));
    }
    settings.use_panda_cloud = use_panda_cloud;
    app_settings_write(settings.clone()).await?;
    Ok(settings)
}

/// Sign out of the Panda proxy: drop the stored `panda_token` + `panda_base_url`
/// and flip `use_panda_cloud` off, so the next turn falls back to the user's own
/// local Claude Code auth. The inverse of [`store_panda_session`]; the rest of
/// settings is preserved. Idempotent — a no-token state logs out to the same
/// result. Returns the updated settings so the UI can reflect the new mode
/// immediately (matching [`app_set_auth_mode`]).
#[tauri::command]
pub async fn app_panda_logout() -> IpcResult<AppSettings> {
    let mut settings = load_settings().await.unwrap_or_default();
    settings.panda_token = None;
    settings.panda_base_url = None;
    settings.use_panda_cloud = false;
    app_settings_write(settings.clone()).await?;
    Ok(settings)
}

/// Drive the Panda proxy sign-in (PKCE + deep-link OAuth). Opens the browser,
/// waits for the `myide://auth/callback` deep link, exchanges the code,
/// and persists the session. Progress streams via `panda_login_progress`. In
/// debug builds only, setting `PANDA_DEV_TOKEN` skips the browser round-trip and
/// completes against that token (for local testing before the BE is reachable);
/// the bypass is compiled out of release builds.
#[tauri::command]
pub async fn app_panda_login(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> IpcResult<PandaLoginResult> {
    let emit = |progress: PandaLoginProgress| {
        let _ = app.emit(PANDA_LOGIN_PROGRESS_EVENT, &progress);
    };
    let fail = |emit: &dyn Fn(PandaLoginProgress), code: &str, msg: String| -> IpcError {
        emit(PandaLoginProgress::Error { message: msg.clone() });
        IpcError::new(code, msg)
    };

    emit(PandaLoginProgress::Starting);

    // Dev escape hatch: bypass the browser round-trip with a fixed token.
    // Debug-only — `cfg!(debug_assertions)` short-circuits before the env read so
    // this auth bypass cannot be reached in release (production) builds, matching
    // the gating convention used for devtools and `PANDA_DEBUG_CLAUDE`.
    if cfg!(debug_assertions) {
        if let Ok(token) = std::env::var("PANDA_DEV_TOKEN") {
            let token = token.trim();
            if !token.is_empty() {
                emit(PandaLoginProgress::Verifying);
                store_panda_session(token, PANDA_PROXY_URL).await?;
                emit(PandaLoginProgress::Done);
                return Ok(PandaLoginResult { ok: true });
            }
        }
    }

    // 1. PKCE + CSRF state (kept in RAM only, never logged).
    let verifier = random_b64url_32();
    let challenge = pkce_challenge(&verifier);
    let csrf_state = uuid::Uuid::new_v4().to_string();

    // 2. Arm the pending sign-in BEFORE opening the browser so a fast callback
    //    can't race the receiver into existence.
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    state.set_pending_panda_login(PendingPandaLogin {
        state: csrf_state.clone(),
        tx,
    });

    // 3. Open the hosted login page in the system browser.
    let url = build_login_url(&challenge, &csrf_state);
    #[cfg(debug_assertions)]
    eprintln!("[panda login] armed state={csrf_state:?}\n[panda login] opening: {url}");
    if let Err(e) = open::that_detached(&url) {
        state.take_pending_panda_login();
        return Err(fail(
            &emit,
            "PANDA_BROWSER_FAILED",
            format!("could not open your browser to sign in: {e}"),
        ));
    }
    emit(PandaLoginProgress::AwaitingBrowser { url });

    // 4. Wait for the deep-link handler to deliver the one-time code.
    #[cfg(debug_assertions)]
    eprintln!("[panda login] waiting for myide://auth/callback deep link …");
    let code = match tokio::time::timeout(LOGIN_TIMEOUT, rx).await {
        Ok(Ok(Ok(code))) => {
            #[cfg(debug_assertions)]
            eprintln!("[panda login] received code via deep link; exchanging …");
            code
        }
        Ok(Ok(Err(msg))) => return Err(fail(&emit, "PANDA_LOGIN_FAILED", msg)),
        Ok(Err(_recv)) => {
            return Err(fail(
                &emit,
                "PANDA_LOGIN_FAILED",
                "Sign-in was interrupted. Please try again.".to_string(),
            ))
        }
        Err(_elapsed) => {
            // Clear the still-armed slot so a late callback doesn't find a
            // closed receiver.
            state.take_pending_panda_login();
            return Err(fail(
                &emit,
                "PANDA_LOGIN_TIMEOUT",
                "Timed out waiting for you to finish signing in.".to_string(),
            ));
        }
    };

    // 5. Exchange the code for the proxy key.
    emit(PandaLoginProgress::Verifying);
    let (key, base_url) = match exchange_code_for_key(&code, &verifier).await {
        Ok(pair) => pair,
        Err(err) => return Err(fail(&emit, "PANDA_EXCHANGE_FAILED", err.message)),
    };

    // 6. Persist + finish. The key stays Rust-side — only `ok` crosses to JS.
    store_panda_session(&key, &base_url).await?;
    emit(PandaLoginProgress::Done);
    Ok(PandaLoginResult { ok: true })
}

/// Cancel an in-flight Panda sign-in — the user closed the browser tab or chose
/// another path and doesn't want to wait out `LOGIN_TIMEOUT`. Taking the pending
/// slot drops its oneshot sender, which makes the awaiting `app_panda_login`'s
/// receiver resolve immediately (interrupted) instead of blocking for 10 minutes.
/// Also stops a late deep-link callback from silently completing a sign-in the
/// user abandoned (it finds no pending slot → no-op). No-op if nothing pending.
#[tauri::command]
pub async fn app_cancel_panda_login(state: tauri::State<'_, AppState>) -> IpcResult<()> {
    state.take_pending_panda_login();
    Ok(())
}

/// Strip ANSI/VT escape sequences (CSI `ESC [ … final` and OSC
/// `ESC ] … BEL/ST`) from PTY output so URL/token scanning sees clean text.
/// A small hand-rolled scanner — we only need it good enough to recover
/// `https://…` and `sk-ant-…` runs, not a full terminal emulator.
fn strip_ansi(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == 0x1b && i + 1 < bytes.len() {
            match bytes[i + 1] {
                b'[' => {
                    // CSI: consume params until a final byte in 0x40..=0x7e.
                    i += 2;
                    while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                        i += 1;
                    }
                    let final_byte = bytes.get(i).copied();
                    i += 1; // skip the final byte
                    // The Ink TUI we scan renders inter-word spaces as cursor-
                    // forward (`ESC[<n>C`) and positions text via absolute moves
                    // (`ESC[<r>;<c>H`). Dropping those with no replacement fuses
                    // neighbouring text — the scanned OAuth URL would run straight
                    // into the trailing "Paste code here…" prompt and swallow it
                    // into the URL's `state` param. Emit one space for any cursor-
                    // movement final byte so segments stay separated; copyable
                    // values (the URL, the token) print as a single contiguous run
                    // with no interior moves, so they're never split. Color/style
                    // (`m`), erase (`J`/`K`), and private modes (`h`/`l`) carry no
                    // spatial meaning → drop silently.
                    if matches!(
                        final_byte,
                        Some(b'A' | b'B' | b'C' | b'D' | b'E' | b'F' | b'G' | b'H' | b'd' | b'f')
                    ) {
                        out.push(' ');
                    }
                    continue;
                }
                b']' => {
                    // OSC: consume until BEL or ESC\ (ST).
                    i += 2;
                    while i < bytes.len() {
                        if bytes[i] == 0x07 {
                            i += 1;
                            break;
                        }
                        if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                    continue;
                }
                _ => {
                    // Other ESC-prefixed sequence: drop ESC + the next byte.
                    i += 2;
                    continue;
                }
            }
        }
        // Keep printable + whitespace; drop stray control bytes.
        if b == b'\n' || b == b'\t' || b >= 0x20 {
            out.push(b as char);
        }
        i += 1;
    }
    out
}

/// Find the first plausible OAuth sign-in URL in CLI output. We only surface
/// it as a manual fallback (the CLI opens the browser itself), so a loose
/// match is fine: first `https://` run that points at a Claude/Anthropic host.
fn find_login_url(text: &str) -> Option<String> {
    for start in find_all(text, "https://") {
        let rest = &text[start..];
        let end = rest
            .find(|c: char| {
                c.is_whitespace() || c == '"' || c == '\'' || c == ')' || c == '<' || c == '>'
            })
            .unwrap_or(rest.len());
        let url = &rest[..end];
        let lower = url.to_ascii_lowercase();
        if lower.contains("claude.ai")
            || lower.contains("anthropic")
            || lower.contains("oauth")
            || lower.contains("console.")
        {
            return Some(url.to_string());
        }
    }
    None
}

/// True if `url` is the legacy interactive-login *loopback* flow — an
/// `…/oauth/authorize` whose `redirect_uri` points at a `localhost`/`127.0.0.1`
/// callback. Our headless `setup-token` paste-code flow uses a hosted callback
/// (`platform.claude.com/oauth/code/callback`) and prints a code to paste back.
/// A loopback redirect means the resolved `claude` binary is old enough to drive
/// the *interactive* login instead: it expects a browser to hit a local server
/// we never run, so the user is stranded on a link that can't complete. We
/// detect it and fail with a clear "update your CLI" error rather than surfacing
/// the dead link (the bug behind the `claude.ai/oauth/authorize?...localhost...`
/// URL old builds produced).
fn is_loopback_login_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains("/oauth/authorize")
        && (lower.contains("localhost") || lower.contains("127.0.0.1"))
}

/// Byte offsets of every occurrence of `needle` in `hay`.
fn find_all(hay: &str, needle: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = hay[from..].find(needle) {
        let at = from + rel;
        out.push(at);
        from = at + needle.len();
    }
    out
}

/// Extract a Claude OAuth token from `claude setup-token` output. Tokens look
/// like `sk-ant-oat01-<long base64url-ish run>`; we anchor on the documented
/// prefix, fall back to the generic `sk-ant-` family, and take the maximal run
/// of token characters. Returns the longest candidate (the real token dwarfs
/// any incidental `sk-ant-` mention) of at least `MIN_TOKEN_LEN`.
fn parse_setup_token(text: &str) -> Option<String> {
    const MIN_TOKEN_LEN: usize = 24;
    let is_tok = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
    let mut best: Option<String> = None;
    for prefix in ["sk-ant-oat01-", "sk-ant-"] {
        for start in find_all(text, prefix) {
            let rest = &text[start..];
            let end = rest.find(|c: char| !is_tok(c)).unwrap_or(rest.len());
            let candidate = &rest[..end];
            if candidate.len() >= MIN_TOKEN_LEN
                && best.as_ref().map(|b| candidate.len() > b.len()).unwrap_or(true)
            {
                best = Some(candidate.to_string());
            }
        }
        if best.is_some() {
            break; // prefer the more specific prefix
        }
    }
    best
}

/// One-click Claude Code sign-in. Drives `claude setup-token` inside a real
/// pseudo-terminal (it detects a TTY and opens the browser OAuth flow), watches
/// the output for the sign-in URL and the printed token, persists the token,
/// and exports it for subsequent headless turns. Progress streams via the
/// `claude_login_progress` event.
///
/// `setup-token` uses the paste-the-code OAuth variant: after the user approves
/// in the browser, Claude Code prints an authorization code they must paste back
/// into the terminal. We can't type into a hidden PTY for them, so we stash the
/// PTY's writer in [`AppState`] and surface the URL via `AwaitingBrowser`; the
/// onboarding UI then collects the code and calls `app_submit_login_code`, which
/// writes it into this PTY so `setup-token` proceeds to print the token. (If a
/// CLI build instead uses a loopback callback and prints the token directly, the
/// code input simply goes unused and capture still works.)
#[tauri::command]
pub async fn app_login_claude(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> IpcResult<ClaudeAuthStatus> {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::io::Read;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let emit = |progress: ClaudeLoginProgress| {
        let _ = app.emit(CLAUDE_LOGIN_PROGRESS_EVENT, &progress);
    };

    let fail = |emit: &dyn Fn(ClaudeLoginProgress), code: &str, msg: String| -> IpcError {
        emit(ClaudeLoginProgress::Error { message: msg.clone() });
        IpcError::new(code, msg)
    };

    emit(ClaudeLoginProgress::Starting);

    // Resolve `claude` the same way the chat driver does (augmented PATH,
    // following a Windows `.cmd` shim to the real `.exe`).
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let Some(claude) = crate::commands::claude_driver::resolve_claude(&cwd) else {
        return Err(fail(
            &emit,
            "CLAUDE_NOT_INSTALLED",
            "Claude Code is not installed yet".to_string(),
        ));
    };

    let mut cmd = CommandBuilder::new(claude);
    cmd.arg("setup-token");
    cmd.cwd(&cwd);
    cmd.env("PATH", crate::commands::claude_driver::augmented_path());
    // Don't let the CLI rewrite its own binary mid-login (Windows 0xC0000142).
    cmd.env("DISABLE_AUTOUPDATER", "1");

    // Wide terminal so a long token prints on a single unwrapped line — the
    // token scanner reads the merged PTY stream and line-wrapping would split
    // the run.
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 50,
            cols: 512,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| fail(&emit, "LOGIN_PTY_FAILED", e.to_string()))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| fail(&emit, "LOGIN_PTY_FAILED", e.to_string()))?;

    // Writer over the PTY's stdin. `setup-token` prompts for an authorization
    // code after browser approval; `app_submit_login_code` feeds it through here.
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| fail(&emit, "LOGIN_PTY_FAILED", e.to_string()))?;

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| fail(&emit, "LOGIN_SPAWN_FAILED", e.to_string()))?;

    // Keep the master alive for the reader's lifetime; close our slave handle
    // so the reader hits EOF the moment the child exits.
    let _master = pair.master;
    drop(pair.slave);

    // Expose the writer so `app_submit_login_code` can reach this PTY while the
    // sign-in is in flight. Cleared once the reader finishes (below).
    state.set_login_pty_writer(writer);

    // Set if the CLI emits a legacy loopback sign-in URL (outdated `claude`):
    // the reader stops immediately and the main path reports `CLAUDE_OUTDATED`
    // instead of surfacing a link the paste-code flow can never finish.
    let outdated = Arc::new(AtomicBool::new(false));
    let outdated_for_reader = outdated.clone();

    let app_for_reader = app.clone();
    let reader_handle = tokio::task::spawn_blocking(move || -> Option<String> {
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 4096];
        let mut url_emitted = false;
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break, // EOF: child exited
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    if !url_emitted {
                        let text = strip_ansi(&String::from_utf8_lossy(&buf));
                        if let Some(url) = find_login_url(&text) {
                            if is_loopback_login_url(&url) {
                                // Outdated CLI: bail now. The main path turns this
                                // into a clear error; reading on would only block
                                // on a callback that never arrives.
                                outdated_for_reader.store(true, Ordering::SeqCst);
                                break;
                            }
                            url_emitted = true;
                            let _ = app_for_reader.emit(
                                CLAUDE_LOGIN_PROGRESS_EVENT,
                                &ClaudeLoginProgress::AwaitingBrowser { url },
                            );
                        }
                    }
                }
                Err(_) => break,
            }
        }
        let text = strip_ansi(&String::from_utf8_lossy(&buf));
        parse_setup_token(&text)
    });

    let token_result = tokio::time::timeout(LOGIN_TIMEOUT, reader_handle).await;
    // Reading is done (success, panic, or timeout): retire the writer so a
    // stale `app_submit_login_code` can't write into a dead PTY.
    state.clear_login_pty_writer();
    let token = match token_result {
        Ok(Ok(token)) => token,
        Ok(Err(_join_err)) => None, // reader task panicked
        Err(_) => {
            // Timed out — the user never finished. Kill the child; the reader
            // task then hits EOF and ends on its own.
            let _ = child.kill();
            return Err(fail(
                &emit,
                "LOGIN_TIMEOUT",
                "Timed out waiting for browser sign-in".to_string(),
            ));
        }
    };

    // Outdated CLI produced a loopback link we bailed on: the child is still
    // waiting on a callback that will never arrive, so kill it before reaping.
    if outdated.load(Ordering::SeqCst) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(fail(
            &emit,
            "CLAUDE_OUTDATED",
            "Your installed Claude Code CLI is outdated and produced a sign-in \
             link this app can't complete. Update it (run `claude update`, or \
             reinstall Claude Code) and try signing in again."
                .to_string(),
        ));
    }

    // Reap the child so it doesn't linger.
    let _ = child.wait();

    let Some(token) = token else {
        return Err(fail(
            &emit,
            "LOGIN_NO_TOKEN",
            "Sign-in did not return a token. Please try again.".to_string(),
        ));
    };

    emit(ClaudeLoginProgress::Verifying);
    store_oauth_token(&token)
        .await
        .map_err(|e| fail(&emit, "LOGIN_STORE_FAILED", e.message))?;

    let status = detect_claude_auth().await;
    if !status.authenticated {
        return Err(fail(
            &emit,
            "LOGIN_VERIFY_FAILED",
            "Captured a token but could not confirm authentication".to_string(),
        ));
    }
    emit(ClaudeLoginProgress::Done);
    Ok(status)
}

/// Feed a user-pasted authorization code into the in-flight `claude setup-token`
/// PTY. `app_login_claude` surfaces the OAuth URL via `AwaitingBrowser`; after
/// the user approves in the browser, Claude Code prints a code they must paste
/// back. The onboarding UI collects it and calls this, which writes it (plus
/// Enter) into the PTY so `setup-token` can finish and print the token.
///
/// Errors with `LOGIN_NO_ACTIVE_SESSION` if no sign-in is currently awaiting a
/// code (e.g. it already timed out), or `LOGIN_EMPTY_CODE` for blank input.
#[tauri::command]
pub async fn app_submit_login_code(
    code: String,
    state: tauri::State<'_, AppState>,
) -> IpcResult<()> {
    if code.trim().is_empty() {
        return Err(IpcError::new(
            "LOGIN_EMPTY_CODE",
            "Authorization code is empty".to_string(),
        ));
    }
    state
        .write_login_code(&code)
        .map_err(|msg| IpcError::new("LOGIN_NO_ACTIVE_SESSION", msg))
}

// ---------------------------------------------------------------------------
// app_install_orcaslicer
// ---------------------------------------------------------------------------

/// One-click OrcaSlicer installer. Downloads the pinned OrcaSlicer release for
/// the host platform from GitHub, installs it into a user-writable location
/// (`~/Applications/OrcaSlicer.app` on macOS, `~/.local/bin/orcaslicer` on
/// Linux, portable-zip extract on Windows), then re-runs `detect_slicer` to
/// confirm the binary is resolvable by the same probe the slice path uses.
/// Progress streams via the `slicer_install_progress` Tauri event.
#[tauri::command]
pub async fn app_install_orcaslicer(app: tauri::AppHandle) -> IpcResult<InstalledSlicer> {
    let emit = |progress: SlicerInstallProgress| {
        let _ = app.emit(SLICER_INSTALL_PROGRESS_EVENT, &progress);
    };

    let version = SLICER_VERSION_PIN.trim().to_string();

    // Asset name follows the convention in scripts/build/build-slicer-sidecar.sh.
    #[cfg(target_os = "macos")]
    let asset = format!("OrcaSlicer_Mac_universal_{version}.dmg");
    #[cfg(target_os = "linux")]
    let asset = format!("OrcaSlicer_Linux_AppImage_Ubuntu2404_{version}.AppImage");
    #[cfg(target_os = "windows")]
    let asset = windows_portable_asset_name(&version);
    let url =
        format!("https://github.com/SoftFever/OrcaSlicer/releases/download/{version}/{asset}");

    // 1. Download into a per-process temp dir.
    emit(SlicerInstallProgress::Downloading {
        received_bytes: None,
        total_bytes: None,
    });

    let tmp_dir = std::env::temp_dir().join(format!("panda-slicer-{}", std::process::id()));
    if let Err(err) = tokio::fs::create_dir_all(&tmp_dir).await {
        let msg = format!("Failed to create temp dir: {err}");
        emit(SlicerInstallProgress::Error {
            message: msg.clone(),
        });
        return Err(IpcError::new("INSTALL_FAILED", msg));
    }
    let download = tmp_dir.join(&asset);

    if let Err(err) = download_slicer_asset(&app, &url, &download).await {
        emit(SlicerInstallProgress::Error {
            message: err.message.clone(),
        });
        let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
        return Err(err);
    }

    // 2. Install (platform-specific), always cleaning up the temp dir.
    let install_result = install_downloaded_slicer(&app, &download).await;
    let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
    if let Err(err) = install_result {
        emit(SlicerInstallProgress::Error {
            message: err.message.clone(),
        });
        return Err(err);
    }

    // 3. Verify via the same probe `app_prereq_check` uses.
    emit(SlicerInstallProgress::Verifying);
    let slicer = detect_slicer();
    if !slicer.found {
        let msg = "Installer finished but OrcaSlicer was not detected".to_string();
        emit(SlicerInstallProgress::Error {
            message: msg.clone(),
        });
        return Err(IpcError::new("INSTALL_VERIFIED_MISSING", msg));
    }

    emit(SlicerInstallProgress::Done {
        version: version.clone(),
        binary_path: slicer.binary_path.clone(),
    });

    Ok(InstalledSlicer {
        version,
        binary_path: slicer.binary_path,
    })
}

/// Stream `url` to `dest`, emitting `Downloading` progress every ~4 MB. Kept a
/// free function so the platform install helpers can share it.
async fn download_slicer_asset(
    app: &tauri::AppHandle,
    url: &str,
    dest: &Path,
) -> IpcResult<()> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| IpcError::new("INSTALLER_CLIENT_ERROR", e.to_string()))?;
    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| IpcError::new("INSTALLER_FETCH_FAILED", e.to_string()))?;
    if !resp.status().is_success() {
        return Err(IpcError::new(
            "INSTALLER_FETCH_FAILED",
            format!("OrcaSlicer download returned HTTP {}", resp.status()),
        ));
    }

    let total = resp.content_length();
    let mut file = tokio::fs::File::create(dest).await.map_err(IpcError::from)?;
    let mut received: u64 = 0;
    let mut next_emit: u64 = 0;
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| IpcError::new("INSTALLER_FETCH_FAILED", e.to_string()))?
    {
        file.write_all(&chunk).await.map_err(IpcError::from)?;
        received += chunk.len() as u64;
        if received >= next_emit {
            next_emit = received + 4 * 1024 * 1024;
            let _ = app.emit(
                SLICER_INSTALL_PROGRESS_EVENT,
                &SlicerInstallProgress::Downloading {
                    received_bytes: Some(received),
                    total_bytes: total,
                },
            );
        }
    }
    file.flush().await.map_err(IpcError::from)?;
    Ok(())
}

/// macOS: mount the DMG, copy `OrcaSlicer.app` into `~/Applications`, detach.
#[cfg(target_os = "macos")]
async fn install_downloaded_slicer(app: &tauri::AppHandle, dmg: &Path) -> IpcResult<()> {
    use tokio::process::Command as TokioCommand;
    let emit = |progress: SlicerInstallProgress| {
        let _ = app.emit(SLICER_INSTALL_PROGRESS_EVENT, &progress);
    };

    emit(SlicerInstallProgress::Extracting);
    let mount = dmg.with_extension("mnt");
    tokio::fs::create_dir_all(&mount).await.map_err(IpcError::from)?;

    let attach = TokioCommand::new("hdiutil")
        .arg("attach")
        .arg(dmg)
        .arg("-mountpoint")
        .arg(&mount)
        .args(["-nobrowse", "-quiet"])
        .status()
        .await
        .map_err(|e| IpcError::new("INSTALL_FAILED", format!("hdiutil attach failed: {e}")))?;
    if !attach.success() {
        return Err(IpcError::new(
            "INSTALL_FAILED",
            "hdiutil could not mount the OrcaSlicer DMG",
        ));
    }

    // Always detach, even if the copy fails.
    let copied = copy_macos_app_from_mount(app, &mount).await;
    let _ = TokioCommand::new("hdiutil")
        .arg("detach")
        .arg(&mount)
        .arg("-quiet")
        .status()
        .await;
    copied
}

#[cfg(target_os = "macos")]
async fn copy_macos_app_from_mount(app: &tauri::AppHandle, mount: &Path) -> IpcResult<()> {
    use tokio::process::Command as TokioCommand;
    let emit = |progress: SlicerInstallProgress| {
        let _ = app.emit(SLICER_INSTALL_PROGRESS_EVENT, &progress);
    };

    let src_app = mount.join("OrcaSlicer.app");
    if !src_app.exists() {
        return Err(IpcError::new(
            "INSTALL_FAILED",
            "OrcaSlicer.app was not found inside the downloaded DMG",
        ));
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| IpcError::new("INSTALL_FAILED", "HOME is not set"))?;
    let apps_dir = home.join("Applications");
    tokio::fs::create_dir_all(&apps_dir)
        .await
        .map_err(IpcError::from)?;
    let dst_app = apps_dir.join("OrcaSlicer.app");

    emit(SlicerInstallProgress::Installing);
    // Replace any prior copy so a re-run is idempotent.
    let _ = tokio::fs::remove_dir_all(&dst_app).await;
    // `ditto` preserves code signatures, symlinks, and resource forks inside
    // the bundle — a plain recursive copy would break the signed .app.
    let copy = TokioCommand::new("ditto")
        .arg(&src_app)
        .arg(&dst_app)
        .status()
        .await
        .map_err(|e| IpcError::new("INSTALL_FAILED", format!("ditto failed: {e}")))?;
    if !copy.success() {
        return Err(IpcError::new(
            "INSTALL_FAILED",
            "ditto could not copy OrcaSlicer.app into ~/Applications",
        ));
    }
    Ok(())
}

/// Linux: drop the AppImage into `~/.local/bin/orcaslicer` and mark it
/// executable. `~/.local/bin` is one of `well_known_slicer_paths()`.
#[cfg(target_os = "linux")]
async fn install_downloaded_slicer(app: &tauri::AppHandle, appimage: &Path) -> IpcResult<()> {
    use std::os::unix::fs::PermissionsExt;
    let _ = app.emit(
        SLICER_INSTALL_PROGRESS_EVENT,
        &SlicerInstallProgress::Installing,
    );

    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| IpcError::new("INSTALL_FAILED", "HOME is not set"))?;
    let bin_dir = home.join(".local/bin");
    tokio::fs::create_dir_all(&bin_dir)
        .await
        .map_err(IpcError::from)?;
    let dst = bin_dir.join("orcaslicer");
    tokio::fs::copy(appimage, &dst).await.map_err(IpcError::from)?;
    let mut perms = tokio::fs::metadata(&dst)
        .await
        .map_err(IpcError::from)?
        .permissions();
    perms.set_mode(0o755);
    tokio::fs::set_permissions(&dst, perms)
        .await
        .map_err(IpcError::from)?;
    Ok(())
}

/// Release-asset filename for the Windows portable zip. The release *tag* is
/// lowercase (`v2.3.2`) but the asset *filename* capitalizes the version
/// (`OrcaSlicer_Windows_V2.3.2_portable.zip`), so normalize the pin's leading
/// `v`/`V` to an uppercase `V`. Getting this wrong is a silent 404.
#[cfg(target_os = "windows")]
fn windows_portable_asset_name(version: &str) -> String {
    let ver = version.trim().trim_start_matches(['v', 'V']);
    format!("OrcaSlicer_Windows_V{ver}_portable.zip")
}

/// Windows: extract the portable zip and move its tree (the `orca-slicer.exe`
/// plus its sibling DLLs/resources) into the Panda-managed install dir, which
/// is one of `well_known_slicer_paths()`.
#[cfg(target_os = "windows")]
async fn install_downloaded_slicer(app: &tauri::AppHandle, zip: &Path) -> IpcResult<()> {
    let emit = |progress: SlicerInstallProgress| {
        let _ = app.emit(SLICER_INSTALL_PROGRESS_EVENT, &progress);
    };

    emit(SlicerInstallProgress::Extracting);
    let extract_dir = zip.with_extension("extract");
    let _ = tokio::fs::remove_dir_all(&extract_dir).await; // clear any stale run
    tokio::fs::create_dir_all(&extract_dir)
        .await
        .map_err(IpcError::from)?;
    extract_zip(zip, &extract_dir).await?;

    let dest = crate::commands::slicer::managed_slicer_dir()
        .ok_or_else(|| IpcError::new("INSTALL_FAILED", "LOCALAPPDATA is not set"))?;

    emit(SlicerInstallProgress::Installing);
    // Recursive walk + directory move — run off the async runtime.
    let from = extract_dir.clone();
    let to = dest.clone();
    let result = tokio::task::spawn_blocking(move || install_portable_tree(&from, &to))
        .await
        .map_err(|e| IpcError::new("INSTALL_FAILED", format!("install task failed: {e}")))?;
    let _ = tokio::fs::remove_dir_all(&extract_dir).await;
    result
}

/// Unzip `zip` into `dest`. Prefers Windows' bundled bsdtar
/// (`%SystemRoot%\System32\tar.exe`) — fast and zip-capable — invoked by
/// absolute path so a GNU `tar` earlier on PATH (which cannot read zips) can't
/// shadow it. Falls back to PowerShell `Expand-Archive`.
#[cfg(target_os = "windows")]
async fn extract_zip(zip: &Path, dest: &Path) -> IpcResult<()> {
    use tokio::process::Command as TokioCommand;

    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let bsdtar = PathBuf::from(&system_root)
        .join("System32")
        .join("tar.exe");
    if bsdtar.exists() {
        if let Ok(status) = TokioCommand::new(&bsdtar)
            .arg("-xf")
            .arg(zip)
            .arg("-C")
            .arg(dest)
            .status()
            .await
        {
            if status.success() {
                return Ok(());
            }
        }
    }

    let status = TokioCommand::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command"])
        .arg(format!(
            "Expand-Archive -Force -LiteralPath '{}' -DestinationPath '{}'",
            zip.display(),
            dest.display()
        ))
        .status()
        .await
        .map_err(|e| IpcError::new("INSTALL_FAILED", format!("Expand-Archive failed to start: {e}")))?;
    if !status.success() {
        return Err(IpcError::new(
            "INSTALL_FAILED",
            "could not extract the OrcaSlicer portable zip",
        ));
    }
    Ok(())
}

/// Locate `orca-slicer.exe` inside the extracted tree and move its containing
/// directory into `dest`, replacing any prior managed install. Synchronous —
/// invoked via `spawn_blocking`.
#[cfg(target_os = "windows")]
fn install_portable_tree(extracted: &Path, dest: &Path) -> IpcResult<()> {
    let exe = find_slicer_exe(extracted, 5).ok_or_else(|| {
        IpcError::new(
            "INSTALL_FAILED",
            "orca-slicer.exe was not found inside the portable zip",
        )
    })?;
    let src_dir = exe.parent().ok_or_else(|| {
        IpcError::new("INSTALL_FAILED", "extracted slicer binary has no parent dir")
    })?;

    // `dest` may already exist as a stale install *directory* OR as a leftover
    // placeholder *file* — e.g. the 4-byte "stub" a prior build/install dropped
    // at the managed slicer path. `remove_dir_all` errors on a non-directory on
    // Windows, which would abort the install and leave the user with no slicer,
    // so branch on the actual type (without following a symlink) and clear it.
    remove_path_any(dest)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(IpcError::from)?;
    }
    // Fast path is a rename (temp dir + LOCALAPPDATA share the system drive);
    // fall back to a recursive copy if that crosses a volume.
    match std::fs::rename(src_dir, dest) {
        Ok(()) => Ok(()),
        Err(_) => copy_dir_recursive(src_dir, dest),
    }
}

/// Remove whatever exists at `path` — a directory tree, a regular file, or a
/// symlink — and treat "already absent" as success. `std::fs::remove_dir_all`
/// alone is insufficient on Windows because it errors when the target is a
/// file, so we dispatch on the (non-followed) metadata.
#[cfg(target_os = "windows")]
fn remove_path_any(path: &Path) -> IpcResult<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path).map_err(IpcError::from),
        Ok(_) => std::fs::remove_file(path).map_err(IpcError::from),
        Err(_) => Ok(()), // nothing there
    }
}

/// Shallowest-first search for `orca-slicer.exe` / `OrcaSlicer.exe` under
/// `root`, bounded to `max_depth` directory levels.
#[cfg(target_os = "windows")]
fn find_slicer_exe(root: &Path, max_depth: usize) -> Option<PathBuf> {
    let mut frontier = vec![(root.to_path_buf(), 0usize)];
    while !frontier.is_empty() {
        let mut next = Vec::new();
        for (dir, depth) in frontier {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let Ok(ft) = entry.file_type() else { continue };
                let path = entry.path();
                if ft.is_file() {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        let lower = name.to_ascii_lowercase();
                        if lower == "orca-slicer.exe" || lower == "orcaslicer.exe" {
                            return Some(path);
                        }
                    }
                } else if ft.is_dir() && depth < max_depth {
                    next.push((path, depth + 1));
                }
            }
        }
        frontier = next; // process a full depth level before descending
    }
    None
}

/// Recursively copy `src` into `dest` (cross-volume fallback for a rename).
#[cfg(target_os = "windows")]
fn copy_dir_recursive(src: &Path, dest: &Path) -> IpcResult<()> {
    std::fs::create_dir_all(dest).map_err(IpcError::from)?;
    for entry in std::fs::read_dir(src).map_err(IpcError::from)? {
        let entry = entry.map_err(IpcError::from)?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if entry.file_type().map_err(IpcError::from)?.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(IpcError::from)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn app_info_returns_pid_and_version() {
        let info = app_info().await.unwrap();
        assert_eq!(info.pid, std::process::id());
        assert_eq!(info.app_version, APP_VERSION);
        assert!(!info.root_path.is_empty());
    }

    #[test]
    fn installer_error_message_extracts_real_reason_from_powershell_record() {
        // PowerShell renders Write-Error (under `$ErrorActionPreference=Stop`)
        // as a multi-line record whose LAST line is the useless
        // `+ FullyQualifiedErrorId` trailer the user reported seeing. The real
        // reason is the first line, prefixed with `<script>.ps1 : `.
        let stderr = vec![
            "C:\\Users\\PC\\AppData\\Local\\Temp\\panda-claude-install-4236.ps1 : Installation failed (exit code 1)".to_string(),
            "    + CategoryInfo          : NotSpecified: (:) [Write-Error], WriteErrorException".to_string(),
            "    + FullyQualifiedErrorId : Microsoft.PowerShell.Commands.WriteErrorException,panda-claude-install-4236.ps1".to_string(),
        ];
        assert_eq!(
            installer_error_message(&stderr).as_deref(),
            Some("Installation failed (exit code 1)"),
        );
    }

    #[test]
    fn installer_error_message_folds_wrapped_message_lines() {
        // PowerShell wraps a long message across stderr lines before the first
        // `+ …` frame; fold them back into one message.
        let stderr = vec![
            "C:\\Temp\\panda-claude-install-99.ps1 : Failed to download binary: The remote name".to_string(),
            "could not be resolved".to_string(),
            "    + CategoryInfo          : NotSpecified: (:) [Write-Error], WriteErrorException".to_string(),
            "    + FullyQualifiedErrorId : Microsoft.PowerShell.Commands.WriteErrorException,panda-claude-install-99.ps1".to_string(),
        ];
        assert_eq!(
            installer_error_message(&stderr).as_deref(),
            Some("Failed to download binary: The remote name could not be resolved"),
        );
    }

    #[test]
    fn installer_error_message_falls_back_to_last_non_frame_line() {
        // Non-PowerShell stderr (e.g. native output from claude.exe) has no
        // `.ps1 :` record — surface the last meaningful line, never a `+` frame
        // and never a blank line.
        let stderr = vec![
            "warning: something".to_string(),
            "fatal: could not write to disk".to_string(),
            "".to_string(),
        ];
        assert_eq!(
            installer_error_message(&stderr).as_deref(),
            Some("fatal: could not write to disk"),
        );
        assert_eq!(installer_error_message(&[]), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_portable_asset_capitalizes_version() {
        // The pin is lowercase (`v2.3.2`) but the real GitHub asset filename
        // uses a capital `V` — a mismatch is a silent 404.
        assert_eq!(
            windows_portable_asset_name("v2.3.2"),
            "OrcaSlicer_Windows_V2.3.2_portable.zip"
        );
        assert_eq!(
            windows_portable_asset_name("V2.3.2"),
            "OrcaSlicer_Windows_V2.3.2_portable.zip"
        );
        assert_eq!(
            windows_portable_asset_name(" 2.3.2\n"),
            "OrcaSlicer_Windows_V2.3.2_portable.zip"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn find_slicer_exe_locates_nested_binary() {
        use std::io::Write;
        let root = std::env::temp_dir().join(format!("panda-find-exe-{}", std::process::id()));
        let nested = root.join("OrcaSlicer").join("bin");
        std::fs::create_dir_all(&nested).unwrap();
        let exe = nested.join("orca-slicer.exe");
        std::fs::File::create(&exe).unwrap().write_all(b"MZ").unwrap();

        let found = find_slicer_exe(&root, 5);
        assert_eq!(found.as_deref(), Some(exe.as_path()));
        // A shallow depth bound must not reach it.
        assert!(find_slicer_exe(&root, 1).is_none());

        let _ = std::fs::remove_dir_all(&root);
    }

    // Regression: a stale 4-byte "stub" *file* sitting at the managed slicer
    // path used to abort the install (`remove_dir_all` errors on a file on
    // Windows). The portable tree must overwrite a file destination, not just a
    // directory one.
    #[cfg(target_os = "windows")]
    #[test]
    fn install_portable_tree_overwrites_stub_file_destination() {
        use std::io::Write;
        let root = std::env::temp_dir().join(format!("panda-install-stub-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);

        // Extracted portable zip: flat tree with the exe at its root.
        let extracted = root.join("extracted");
        std::fs::create_dir_all(&extracted).unwrap();
        std::fs::File::create(extracted.join("orca-slicer.exe"))
            .unwrap()
            .write_all(b"MZ\x90\x00")
            .unwrap();
        std::fs::File::create(extracted.join("libfoo.dll"))
            .unwrap()
            .write_all(b"MZ\x90\x00")
            .unwrap();

        // Destination already exists as a 4-byte stub FILE (the bug trigger).
        let dest = root.join("OrcaSlicer");
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::File::create(&dest).unwrap().write_all(b"stub").unwrap();
        assert!(dest.is_file(), "precondition: dest is a stub file");

        install_portable_tree(&extracted, &dest).expect("install must overwrite a stub file");

        assert!(dest.is_dir(), "dest is now the installed directory");
        assert!(dest.join("orca-slicer.exe").is_file());
        assert!(dest.join("libfoo.dll").is_file());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn remove_path_any_handles_file_dir_and_absent() {
        use std::io::Write;
        let root = std::env::temp_dir().join(format!("panda-rm-any-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let file = root.join("a-file");
        std::fs::File::create(&file).unwrap().write_all(b"x").unwrap();
        remove_path_any(&file).unwrap();
        assert!(!file.exists());

        let dir = root.join("a-dir");
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        remove_path_any(&dir).unwrap();
        assert!(!dir.exists());

        // Absent path is a no-op success.
        remove_path_any(&root.join("missing")).unwrap();

        let _ = std::fs::remove_dir_all(&root);
    }

    // -----------------------------------------------------------------
    // Panda sign-in: PKCE + deep-link parsing
    // -----------------------------------------------------------------

    #[test]
    fn pkce_challenge_is_base64url_sha256_of_verifier() {
        // RFC 7636 Appendix B test vector: verifier → S256 challenge.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            pkce_challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn random_verifier_is_unpadded_and_unique() {
        let a = random_b64url_32();
        let b = random_b64url_32();
        assert_ne!(a, b, "two verifiers must differ");
        assert!(!a.contains('='), "no base64 padding");
        assert!(!a.contains('+') && !a.contains('/'), "url-safe alphabet");
        // 32 bytes → 43 base64url chars (no padding).
        assert_eq!(a.len(), 43);
    }

    #[test]
    fn build_login_url_encodes_params() {
        let url = build_login_url("chal-_123", "state-abc");
        assert!(url.starts_with(&format!("{PANDA_WEB_URL}/login?")));
        // redirect_uri is fully percent-encoded (no raw scheme/colon/slash).
        assert!(url.contains("redirect_uri=myide%3A%2F%2Fauth%2Fcallback"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=state%2Dabc"));
    }

    #[test]
    fn parse_panda_callback_extracts_code_and_state() {
        let (code, state) =
            parse_panda_callback("myide://auth/callback?code=abc123&state=xyz")
                .expect("both params present");
        assert_eq!(code, "abc123");
        assert_eq!(state, "xyz");
    }

    #[test]
    fn parse_panda_callback_percent_decodes_and_ignores_extras() {
        let (code, state) = parse_panda_callback(
            "myide://auth/callback?state=a%2Db&foo=bar&code=one%20time",
        )
        .unwrap();
        assert_eq!(code, "one time");
        assert_eq!(state, "a-b");
    }

    #[test]
    fn parse_panda_callback_rejects_missing_params() {
        assert!(parse_panda_callback("myide://auth/callback?code=only").is_none());
        assert!(parse_panda_callback("myide://auth/callback").is_none());
    }

    // -----------------------------------------------------------------
    // Claude sign-in: pure helpers
    // -----------------------------------------------------------------

    #[test]
    fn resolve_auth_status_precedence() {
        // Env or stored token → authenticated as oauth_token.
        let s = resolve_auth_status(true, false, false);
        assert!(s.authenticated);
        assert_eq!(s.source.as_deref(), Some("oauth_token"));
        let s = resolve_auth_status(false, true, true);
        assert_eq!(s.source.as_deref(), Some("oauth_token"));
        // Only a credentials file → authenticated as credentials_file.
        let s = resolve_auth_status(false, false, true);
        assert!(s.authenticated);
        assert_eq!(s.source.as_deref(), Some("credentials_file"));
        // Nothing → unauthenticated, no source.
        let s = resolve_auth_status(false, false, false);
        assert!(!s.authenticated);
        assert!(s.source.is_none());
    }

    #[test]
    fn strip_ansi_removes_csi_and_osc() {
        // Colored text + an OSC title sequence.
        let raw = "\x1b[32mhello\x1b[0m \x1b]0;title\x07world\n";
        assert_eq!(strip_ansi(raw), "hello world\n");
    }

    #[test]
    fn strip_ansi_keeps_cursor_moves_as_spaces_but_not_color() {
        // Claude Code's Ink TUI renders inter-word spaces as cursor-forward
        // (`ESC[1C`), so dropping CSI silently fused words. Movement → space.
        assert_eq!(
            strip_ansi("Welcome\x1b[1Cto\x1b[1CClaude\x1b[1CCode"),
            "Welcome to Claude Code",
        );
        // Absolute positioning (`ESC[r;cH`) also separates segments.
        assert_eq!(strip_ansi("end\x1b[23;2HPaste"), "end Paste");
        // SGR color/style must NOT inject a space (would split colored runs).
        assert_eq!(strip_ansi("\x1b[38;2;1;2;3mred\x1b[mtext"), "redtext");
    }

    #[test]
    fn find_login_url_not_fused_with_paste_prompt() {
        // Faithful to captured `claude setup-token` output: the URL is one
        // contiguous run placed via CUP, then `ESC[m`, then the prompt on a new
        // line (CUP) whose spaces are CUF moves. Before the strip_ansi fix this
        // yielded `...state=ABC123Pastecodehereifprompted>`.
        let raw = "\x1b[20;1Hhttps://claude.com/cai/oauth/authorize?code=true&state=ABC123\
\x1b[m\x1b[23;2HPaste\x1b[1Ccode\x1b[1Chere\x1b[1Cif\x1b[1Cprompted\x1b[1C>";
        let stripped = strip_ansi(raw);
        let url = find_login_url(&stripped).expect("url found");
        assert_eq!(
            url,
            "https://claude.com/cai/oauth/authorize?code=true&state=ABC123",
        );
        assert!(!url.contains("Paste"), "url fused with prompt text: {url}");
    }

    #[test]
    fn find_login_url_picks_anthropic_host() {
        let text = "Visit https://example.com first, then \
                    open https://claude.ai/oauth/authorize?code=abc to sign in.";
        assert_eq!(
            find_login_url(text).as_deref(),
            Some("https://claude.ai/oauth/authorize?code=abc"),
        );
        assert!(find_login_url("no urls here").is_none());
    }

    #[test]
    fn is_loopback_login_url_flags_legacy_interactive_flow() {
        // Legacy interactive login: claude.ai authorize with a localhost
        // loopback callback (URL-encoded) — the dead-link our paste-code flow
        // can't complete. The encoded `http%3A%2F%2Flocalhost` still contains
        // the literal "localhost".
        let legacy = "https://claude.ai/oauth/authorize?code=true&\
            redirect_uri=http%3A%2F%2Flocalhost%3A56317%2Fcallback&scope=user%3Ainference";
        assert!(is_loopback_login_url(legacy));
        assert!(is_loopback_login_url(
            "https://claude.ai/oauth/authorize?redirect_uri=http://127.0.0.1:8080/callback"
        ));

        // Current setup-token paste-code flow: hosted callback, no loopback.
        let modern = "https://claude.com/cai/oauth/authorize?code=true&\
            redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&\
            scope=org%3Acreate_api_key+user%3Ainference";
        assert!(!is_loopback_login_url(modern));
        // A non-authorize URL that merely mentions localhost must not trip it.
        assert!(!is_loopback_login_url("https://localhost:1234/health"));
    }

    #[test]
    fn parse_setup_token_extracts_oat_prefix() {
        let text = "Success! Your token:\n  \
                    sk-ant-oat01-AbC123_def-456XyZ7890ABCDEF\n\
                    Set CLAUDE_CODE_OAUTH_TOKEN to use it.";
        assert_eq!(
            parse_setup_token(text).as_deref(),
            Some("sk-ant-oat01-AbC123_def-456XyZ7890ABCDEF"),
        );
    }

    #[test]
    fn parse_setup_token_survives_ansi_and_trailing_punctuation() {
        let raw = "token=\x1b[1msk-ant-oat01-LONGtokenVALUE1234567890abcXYZ\x1b[0m.\n";
        let cleaned = strip_ansi(raw);
        assert_eq!(
            parse_setup_token(&cleaned).as_deref(),
            Some("sk-ant-oat01-LONGtokenVALUE1234567890abcXYZ"),
        );
    }

    #[test]
    fn parse_setup_token_rejects_short_noise() {
        // A short `sk-ant-` mention that isn't a real token.
        assert!(parse_setup_token("sk-ant-x and other words").is_none());
        assert!(parse_setup_token("no token at all").is_none());
    }

    #[tokio::test]
    async fn prereq_check_returns_struct() {
        let check = app_prereq_check().await.unwrap();
        // We can't assert values (depends on machine) but the shape must
        // round-trip through serde.
        let json = serde_json::to_value(&check).unwrap();
        assert!(json.get("claudeCli").is_some());
        assert!(json.get("python").is_some());
        assert!(json.get("slicer").is_some());
    }

    // -----------------------------------------------------------------
    // Track I: auto-install Claude Code
    // -----------------------------------------------------------------

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn installer_url_uses_https() {
        assert!(
            CLAUDE_INSTALLER_URL.starts_with("https://"),
            "installer must be fetched over HTTPS",
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn installer_rejects_non_https_url() {
        let err = fetch_installer("http://example.com/install.sh")
            .await
            .unwrap_err();
        assert_eq!(err.code, "INSTALLER_INSECURE_URL");
    }

    /// Run a one-shot in-process HTTP server that serves the given body
    /// on first connection. Returns `http://127.0.0.1:<port>/` once the
    /// listener is bound.
    #[cfg(not(target_os = "windows"))]
    async fn spawn_oneshot_server(body: Vec<u8>) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            // Accept one connection.
            let (mut socket, _) = listener.accept().await.unwrap();
            // Drain request headers (best-effort — installer fetch is GET).
            let mut buf = [0u8; 1024];
            let _ = socket.read(&mut buf).await;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.write_all(&body).await;
            let _ = socket.shutdown().await;
        });
        format!("http://127.0.0.1:{}/", addr.port())
    }

    /// Same as `spawn_oneshot_server`, but the response advertises a
    /// `Content-Length` of `claimed_size` regardless of how many bytes
    /// we actually send. Lets us hit the size cap without actually
    /// allocating 200 KB.
    #[cfg(not(target_os = "windows"))]
    async fn spawn_lying_server(claimed_size: u64) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = socket.read(&mut buf).await;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {claimed_size}\r\nConnection: close\r\n\r\n"
            );
            let _ = socket.write_all(response.as_bytes()).await;
            // Don't send any body — reqwest will fail when we read it but
            // the size-cap check fires off Content-Length first.
            let _ = socket.shutdown().await;
        });
        format!("http://127.0.0.1:{}/", addr.port())
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn installer_size_cap_rejects_oversized() {
        // Spin a local mock server that advertises a huge Content-Length
        // and call the internal helper directly (so we don't trip the
        // https gate). The size cap must reject the body.
        let url = spawn_lying_server(INSTALLER_MAX_BYTES + 1).await;
        let client = reqwest::Client::new();
        let err = fetch_installer_with(&client, &url).await.unwrap_err();
        assert_eq!(err.code, "INSTALLER_TOO_LARGE");
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn installer_fetches_small_body_verbatim() {
        // Happy-path companion to the size-cap test: a body well under
        // the cap is returned verbatim.
        let body = b"#!/bin/sh\necho hi\n".to_vec();
        let url = spawn_oneshot_server(body.clone()).await;
        let client = reqwest::Client::new();
        let fetched = fetch_installer_with(&client, &url).await.unwrap();
        assert_eq!(fetched, body);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn progress_mapping_sequence() {
        // Feed a small stdout fixture and assert each recognized line
        // maps to the expected stage. Unknown lines stay None.
        let fixture = [
            ("Downloading bootstrap.sh", Some("downloading")),
            ("...working...", None),
            ("Verifying checksum", Some("verifying")),
            ("Installing claude into ~/.local/bin", Some("running")),
            ("Extracting payload", Some("running")),
            ("done", None),
        ];

        let mut stages = Vec::new();
        for (line, _expected) in fixture.iter() {
            stages.push(parse_progress_line(line));
        }

        let stage_label = |p: &Option<ClaudeInstallProgress>| -> Option<&'static str> {
            match p {
                Some(ClaudeInstallProgress::Downloading { .. }) => Some("downloading"),
                Some(ClaudeInstallProgress::Verifying) => Some("verifying"),
                Some(ClaudeInstallProgress::Running) => Some("running"),
                Some(ClaudeInstallProgress::Done { .. }) => Some("done"),
                Some(ClaudeInstallProgress::Error { .. }) => Some("error"),
                None => None,
            }
        };
        let observed: Vec<Option<&str>> = stages.iter().map(stage_label).collect();
        let expected: Vec<Option<&str>> = fixture.iter().map(|(_, e)| *e).collect();
        assert_eq!(observed, expected);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_installer_url_uses_https() {
        // The Windows path runs install.ps1 through PowerShell. Like the
        // Unix script it must be fetched over HTTPS — `fetch_installer`
        // rejects anything else, but pin the constant here so a typo can't
        // ship an http:// URL that only fails at runtime.
        assert!(
            CLAUDE_INSTALLER_URL_WINDOWS.starts_with("https://"),
            "Windows installer must be fetched over HTTPS",
        );
        assert!(CLAUDE_INSTALLER_URL_WINDOWS.ends_with(".ps1"));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn install_failed_carries_exit_code() {
        // Assemble the IpcError shape the install path produces on
        // non-zero exit. We can't easily drive the full subprocess in a
        // unit test, but we can lock down the error contract — code,
        // detail keys.
        let err = IpcError::new("INSTALL_FAILED", "boom").with_detail(serde_json::json!({
            "exitCode": 42,
            "stderrTail": ["one", "two"],
        }));
        assert_eq!(err.code, "INSTALL_FAILED");
        let detail = err.detail.expect("detail present");
        assert_eq!(detail["exitCode"], 42);
        assert_eq!(detail["stderrTail"][0], "one");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn progress_unknown_line_returns_none() {
        assert!(parse_progress_line("hello, world").is_none());
        assert!(parse_progress_line("").is_none());
    }

    #[test]
    fn expected_py_minor_strips_patch_and_pbs_tag() {
        // Derived from the embedded pin; whatever PYTHON_VERSION.txt holds, the
        // result must be a bare `major.minor` with no patch and no `+tag`.
        let minor = expected_py_minor();
        assert!(!minor.contains('+'), "pbs tag leaked: {minor}");
        assert_eq!(minor.split('.').count(), 2, "not major.minor: {minor}");
        assert!(minor.split('.').all(|p| p.parse::<u32>().is_ok()), "non-numeric: {minor}");
    }
}
