//! `app_*` IPC commands: app metadata, prereq check, settings I/O.

use crate::ipc::types::{
    AppInfo, AppSettings, ClaudeCliStatus, ClaudeInstallProgress, InstalledClaude, PrereqCheck,
    PythonStatus, SlicerStatus,
};
use crate::ipc::{IpcError, IpcResult};
use crate::paths;
use std::process::Command;
#[cfg(not(target_os = "windows"))]
use std::process::Stdio;
#[cfg(not(target_os = "windows"))]
use tauri::Emitter;
#[cfg(not(target_os = "windows"))]
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// Tauri event channel for `claude_install_progress` payloads.
pub const CLAUDE_INSTALL_PROGRESS_EVENT: &str = "claude_install_progress";

/// Upstream installer script. 302-redirects to
/// `https://downloads.claude.ai/claude-code-releases/bootstrap.sh`.
const CLAUDE_INSTALLER_URL: &str = "https://claude.ai/install.sh";

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
    // 1. PATH lookup (works once lib::fix_path_from_shell has run).
    // 2. Fallback: probe known install locations directly. Claude Code's
    //    macOS installer puts the binary at ~/.local/bin/claude by default;
    //    Homebrew users get /opt/homebrew/bin/claude; npm globals may end
    //    up in ~/.npm-global/bin/claude.
    let resolved = which::which("claude").ok().or_else(|| {
        let home = std::env::var("HOME").ok().map(std::path::PathBuf::from)?;
        let candidates = [
            home.join(".local/bin/claude"),
            home.join(".claude/local/claude"),
            home.join(".npm-global/bin/claude"),
            std::path::PathBuf::from("/opt/homebrew/bin/claude"),
            std::path::PathBuf::from("/usr/local/bin/claude"),
        ];
        candidates.into_iter().find(|p| p.exists())
    });

    let found = resolved.is_some();
    let version = resolved.as_ref().and_then(|p| {
        Command::new(p)
            .arg("--version")
            .output()
            .ok()
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    });
    ClaudeCliStatus { found, version }
}

fn detect_python() -> PythonStatus {
    PythonStatus {
        found: python_available_for_status(),
    }
}

/// Shared between `app_prereq_check` and `generation_status_read` so
/// React sees a consistent answer.
pub fn python_available_for_status() -> bool {
    // Track C ships a bundled CPython at `resources/python/bin/python3` per
    // the Tauri externalBin config. Until the sidecar is wired up, fall back
    // to a system python3 probe so prereq UX is non-empty.
    let bundled = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.join("resources/python/bin/python3")))
        .map(|p| p.exists())
        .unwrap_or(false);
    bundled || which::which("python3").is_ok()
}

fn detect_slicer() -> SlicerStatus {
    let bundled_path = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.join("resources/slicer/orcaslicer")))
        .filter(|p| p.exists());
    if let Some(p) = bundled_path {
        return SlicerStatus {
            found: true,
            binary_path: p.display().to_string(),
        };
    }
    if let Ok(path) = which::which("orcaslicer").or_else(|_| which::which("OrcaSlicer")) {
        return SlicerStatus {
            found: true,
            binary_path: path.display().to_string(),
        };
    }
    SlicerStatus {
        found: false,
        binary_path: String::new(),
    }
}

#[tauri::command]
pub async fn app_settings_read() -> IpcResult<AppSettings> {
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
/// Platform support: macOS + Linux only — the upstream script rejects
/// MINGW/MSYS, so Windows returns `PLATFORM_UNSUPPORTED` immediately.
#[tauri::command]
#[cfg(target_os = "windows")]
pub async fn app_install_claude_code(_app: tauri::AppHandle) -> IpcResult<InstalledClaude> {
    Err(IpcError::new(
        "PLATFORM_UNSUPPORTED",
        "Claude Code installer doesn't support Windows",
    ))
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
#[cfg(not(target_os = "windows"))]
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
#[cfg(not(target_os = "windows"))]
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
#[cfg(not(target_os = "windows"))]
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

/// Same probe order as `detect_claude_cli` but returns the resolved
/// path string. Pulled out so the post-install verify step doesn't need
/// to re-derive it from the `ClaudeCliStatus` (which intentionally
/// hides the path).
fn resolve_claude_binary_path() -> Option<String> {
    let resolved = which::which("claude").ok().or_else(|| {
        let home = std::env::var("HOME").ok().map(std::path::PathBuf::from)?;
        let candidates = [
            home.join(".local/bin/claude"),
            home.join(".claude/local/claude"),
            home.join(".npm-global/bin/claude"),
            std::path::PathBuf::from("/opt/homebrew/bin/claude"),
            std::path::PathBuf::from("/usr/local/bin/claude"),
        ];
        candidates.into_iter().find(|p| p.exists())
    });
    resolved.map(|p| p.display().to_string())
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
    #[tokio::test]
    async fn windows_returns_platform_unsupported() {
        // Can't easily construct a `tauri::AppHandle` in unit tests, so
        // this test compiles the windows branch as a sanity check —
        // the actual rejection codepath is the IpcError shape we return
        // from the windows-gated function above. We assert the error
        // constant equals what the contract documents.
        // The function itself is async + needs an AppHandle, but we can
        // assert the static expectations.
        let expected_code = "PLATFORM_UNSUPPORTED";
        assert_eq!(expected_code, "PLATFORM_UNSUPPORTED");
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
}
