//! `update_*` IPC commands + startup auto-update flow.
//!
//! Wraps `tauri-plugin-updater` in an event-driven surface so the React
//! viewer can show every update affordance: an "update available" prompt,
//! a passive badge, a download-progress bar, and a "restart to apply"
//! banner. Every stage is streamed over the `update_event` Tauri channel
//! ([`UpdateEvent`]); the commands themselves stay thin.
//!
//! Lifecycle:
//!   - `update_check` — check only. Emits `Checking` → `Available`/`UpToDate`.
//!     Used by the UI on mount (Tauri events aren't buffered, so a late
//!     listener would miss the startup check otherwise) and by a manual
//!     "Check for updates" affordance.
//!   - `update_install` — re-check, then download (streaming `Downloading`
//!     progress) and stage the bundle. Emits `Ready` when done. Does NOT
//!     relaunch — the user decides when via `update_relaunch`.
//!   - `update_relaunch` — apply the staged update by restarting the app.

use crate::ipc::types::{UpdateEvent, UpdateInfo};
use crate::ipc::{IpcError, IpcResult};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// Tauri event channel for [`UpdateEvent`] payloads.
pub const UPDATE_EVENT: &str = "update_event";

fn emit(app: &AppHandle, event: &UpdateEvent) {
    let _ = app.emit(UPDATE_EVENT, event);
}

fn updater_err(e: impl std::fmt::Display) -> IpcError {
    IpcError::new("UPDATE_FAILED", e.to_string())
}

/// Version at which auto-update is hard-disabled. `0.1.0` is the local/reset
/// build marker: there is no release channel for it, so checking would only
/// surface confusing "update available" prompts (or errors against an
/// endpoint that doesn't know this version). Gate every update entry point on
/// it so both the startup flow and the manual UI affordance stay quiet.
const AUTO_UPDATE_DISABLED_VERSION: &str = "0.1.0";

/// Whether auto-update is disabled for this build. True when the running app
/// version is [`AUTO_UPDATE_DISABLED_VERSION`].
fn auto_update_disabled(app: &AppHandle) -> bool {
    app.package_info().version.to_string() == AUTO_UPDATE_DISABLED_VERSION
}

/// Check the configured endpoint for a newer signed bundle. Emits
/// `Checking` immediately, then `Available(info)` or `UpToDate`. Returns the
/// update summary when one is available so a caller can use the value
/// directly in addition to the event stream.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> IpcResult<Option<UpdateInfo>> {
    if auto_update_disabled(&app) {
        emit(&app, &UpdateEvent::UpToDate);
        return Ok(None);
    }
    emit(&app, &UpdateEvent::Checking);
    let updater = app.updater().map_err(updater_err)?;
    match updater.check().await {
        Ok(Some(update)) => {
            let info = describe(&update);
            emit(&app, &UpdateEvent::Available(info.clone()));
            Ok(Some(info))
        }
        Ok(None) => {
            emit(&app, &UpdateEvent::UpToDate);
            Ok(None)
        }
        Err(e) => {
            let err = updater_err(e);
            emit(&app, &UpdateEvent::Error { message: err.message.clone() });
            Err(err)
        }
    }
}

/// Download and stage the available update, streaming `Downloading` progress
/// and finishing with `Ready`. Re-checks rather than holding the `Update`
/// handle across IPC calls. The bundle is installed but the app is NOT
/// relaunched — call [`update_relaunch`] to apply it.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> IpcResult<()> {
    if auto_update_disabled(&app) {
        emit(&app, &UpdateEvent::UpToDate);
        return Ok(());
    }
    let updater = app.updater().map_err(updater_err)?;
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            // Already current (e.g. a concurrent install already staged it).
            emit(&app, &UpdateEvent::UpToDate);
            return Ok(());
        }
        Err(e) => {
            let err = updater_err(e);
            emit(&app, &UpdateEvent::Error { message: err.message.clone() });
            return Err(err);
        }
    };

    let version = update.version.clone();
    let progress_app = app.clone();
    let mut downloaded: u64 = 0;
    let result = update
        .download_and_install(
            move |chunk_len, total| {
                downloaded += chunk_len as u64;
                emit(
                    &progress_app,
                    &UpdateEvent::Downloading {
                        downloaded_bytes: downloaded,
                        total_bytes: total,
                    },
                );
            },
            || {},
        )
        .await;

    match result {
        Ok(()) => {
            emit(&app, &UpdateEvent::Ready { version });
            Ok(())
        }
        Err(e) => {
            let err = updater_err(e);
            emit(&app, &UpdateEvent::Error { message: err.message.clone() });
            Err(err)
        }
    }
}

/// Relaunch the app to apply a staged update. `app.restart()` never returns.
#[tauri::command]
pub async fn update_relaunch(app: AppHandle) -> IpcResult<()> {
    app.restart();
}

/// Updater feed consulted for the published version shown in the in-window
/// "About" box. Mirrors `tauri.conf.json` → `plugins.updater.endpoints[0]`; the
/// raw build version baked into the binary (`CARGO_PKG_VERSION`) is unreliable
/// on Windows (the CI version-stamp regex misses CRLF-checked-out Cargo.toml),
/// so the About box reports the authoritative version from this feed instead.
const LATEST_JSON_URL: &str =
    "https://github.com/autonomous-ai/panda/releases/latest/download/latest.json";

/// On-disk cache of the last successfully fetched `latest.json` version, so the
/// About box still shows a real version when the feed is unreachable (offline).
fn cached_version_path() -> std::path::PathBuf {
    crate::paths::app_data_dir().join("latest-version.json")
}

/// Latest published version, for the in-window About box.
///
/// Fetches `latest.json` from the updater feed and returns its `version`,
/// persisting it for offline use. When the feed is unreachable, falls back to
/// the last persisted value, and finally to the installed bundle version
/// (`package_info`, the same authoritative source the native macOS About uses)
/// so the box is never blank.
#[tauri::command]
pub async fn update_latest_version(app: AppHandle) -> IpcResult<String> {
    match fetch_latest_version().await {
        Ok(version) => {
            persist_cached_version(&version).await; // best-effort
            Ok(version)
        }
        Err(_) => Ok(read_cached_version()
            .await
            .unwrap_or_else(|| app.package_info().version.to_string())),
    }
}

/// GET `latest.json` and pull out its top-level `version` string.
async fn fetch_latest_version() -> Result<String, String> {
    let client = reqwest::Client::builder()
        // GitHub's `releases/latest/download/<asset>` 302-redirects to the
        // resolved release asset; follow a few hops.
        .redirect(reqwest::redirect::Policy::limited(5))
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(LATEST_JSON_URL)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("latest.json HTTP {}", resp.status()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    json.get("version")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| "latest.json missing 'version'".to_string())
}

/// Persist the fetched version (best-effort; cache failures are non-fatal).
async fn persist_cached_version(version: &str) {
    let path = cached_version_path();
    if let Some(parent) = path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let body = serde_json::json!({ "version": version }).to_string();
    let _ = tokio::fs::write(path, body).await;
}

/// Read the last persisted version, if any.
async fn read_cached_version() -> Option<String> {
    let bytes = tokio::fs::read(cached_version_path()).await.ok()?;
    let json: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    json.get("version")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn describe(update: &tauri_plugin_updater::Update) -> UpdateInfo {
    UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone().filter(|s| !s.is_empty()),
        date: update.date.map(|d| d.to_string()),
    }
}

/// Startup auto-update flow, spawned from `lib::run`. Honors the
/// `auto_update` setting: when enabled, silently downloads + stages a newer
/// bundle (streaming progress so an attached UI can show it) and ends on
/// `Ready` so the UI can offer a restart. When disabled (the default), this
/// is a no-op — the UI drives a prompt-first flow via `update_check`.
/// Best-effort throughout: any error is emitted softly and swallowed.
pub async fn run_startup_auto_update(app: AppHandle) {
    // `0.1.0` is the reset/local build marker — auto-update is hard-disabled
    // there regardless of the `auto_update` setting (see
    // [`auto_update_disabled`]).
    if auto_update_disabled(&app) {
        return;
    }
    let auto = match crate::commands::app::load_settings().await {
        Ok(s) => s.auto_update,
        Err(_) => false,
    };
    if !auto {
        return;
    }
    // `update_install` re-checks internally, so a plain call performs the
    // full check → download → stage → `Ready` sequence with progress events.
    let _ = update_install(app).await;
}
