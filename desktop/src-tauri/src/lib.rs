//! Panda desktop — Tauri shell.
//!
//! Track C: Rust IPC commands listed in `docs/panda-interfaces.md` §2.
//! The IPC types live in [`ipc::types`]; command handlers in [`commands`].

pub mod ipc;
pub mod commands;
pub mod state;
pub mod paths;
pub mod skills;
pub mod asset_protocol;

use commands::*;

/// Load PATH from the user's shell config and merge into the process env.
///
/// macOS GUI apps launched via Finder/`open` inherit a minimal system PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`), which omits Homebrew, npm globals,
/// and the standard Claude Code install at `~/.local/bin/claude`. This
/// function runs the user's login shell once at startup and unions the
/// reported PATH with whatever we already have. No-op if it fails — we
/// fall through to the existing minimal PATH.
#[cfg(target_os = "macos")]
fn fix_path_from_shell() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = std::process::Command::new(&shell)
        .args(["-l", "-i", "-c", "echo $PATH"])
        .output();
    let Ok(out) = output else { return };
    if !out.status.success() {
        return;
    }
    let shell_path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if shell_path.is_empty() {
        return;
    }
    let existing = std::env::var("PATH").unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    let mut merged = Vec::new();
    for segment in shell_path.split(':').chain(existing.split(':')) {
        if !segment.is_empty() && seen.insert(segment.to_string()) {
            merged.push(segment.to_string());
        }
    }
    std::env::set_var("PATH", merged.join(":"));
}

#[cfg(not(target_os = "macos"))]
fn fix_path_from_shell() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Check the configured updater endpoint and, if a newer signed bundle is
/// available, download + install it and relaunch. Returns `Ok(())` when there
/// is nothing to do. Errors propagate to the caller, which logs and ignores
/// them — auto-update is best-effort and must never break the app.
async fn check_and_install_update(app: tauri::AppHandle) -> tauri_plugin_updater::Result<()> {
    use tauri_plugin_updater::UpdaterExt;
    if let Some(update) = app.updater()?.check().await? {
        update
            .download_and_install(|_downloaded, _total| {}, || {})
            .await?;
        app.restart();
    }
    Ok(())
}

pub fn run() {
    fix_path_from_shell();
    tauri::Builder::default()
        .setup(|app| {
            // Devtools no longer auto-open: in a debug build the docked
            // inspector stole half the window (and, for automation, the chat
            // input). Opt in with `PANDA_DEVTOOLS=1` when you actually need it.
            if std::env::var("PANDA_DEVTOOLS").is_ok_and(|v| v != "0" && !v.is_empty()) {
                if let Some(window) = tauri::Manager::get_webview_window(app, "main") {
                    window.open_devtools();
                }
            }
            // Install the app's bundled Claude Code skills into
            // ~/.claude/skills so the `claude` subprocess (and cadcode's
            // generator) can find them. Best-effort; symlinked skill dirs are
            // left alone for dev live-editing. See `crate::skills`.
            skills::install_bundled_skills(&tauri::Manager::app_handle(app).clone());
            // Auto-update: on startup, check the GitHub Releases endpoint for a
            // newer signed bundle and install it in the background. No-op in dev
            // (the updater has no installed bundle to replace) and silently
            // ignored on any error — a failed update check must never block
            // launch. Set PANDA_NO_UPDATE=1 to skip the check entirely.
            if std::env::var("PANDA_NO_UPDATE").map_or(true, |v| v == "0" || v.is_empty()) {
                let handle = tauri::Manager::app_handle(app).clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = check_and_install_update(handle).await {
                        eprintln!("auto-update check failed: {e}");
                    }
                });
            }
            Ok(())
        })
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_uri_scheme_protocol(asset_protocol::SCHEME, asset_protocol::handle)
        .manage(state::AppState::new())
        .invoke_handler(tauri::generate_handler![
            // app
            app::app_info,
            app::app_prereq_check,
            app::app_settings_read,
            app::app_settings_write,
            app::app_install_claude_code,
            // catalog
            catalog::catalog_read,
            catalog::generation_status_read,
            // files
            files::file_read_bytes,
            files::file_save,
            files::file_reveal,
            // step
            step::step_source_status_read,
            step::step_artifact_regenerate,
            // chat
            chat::chat_start_turn,
            chat::chat_approve_plan,
            chat::chat_request_plan_changes,
            chat::chat_cancel_turn,
            chat::chat_session_state,
            // slicer
            slicer::slice_run,
            slicer::slice_status,
            // printer
            printer::printer_discover,
            printer::printer_add,
            printer::printer_list,
            printer::printer_status,
            printer::printer_upload_gcode,
            printer::printer_start_print,
            // project
            project::project_list,
            project::project_create,
            project::project_open,
            project::project_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Panda Tauri application");
}
