//! Panda desktop — Tauri shell.
//!
//! Track C: Rust IPC commands listed in `docs/panda-interfaces.md` §2.
//! The IPC types live in [`ipc::types`]; command handlers in [`commands`].

pub mod ipc;
pub mod commands;
pub mod state;
pub mod paths;
pub mod skills;
pub mod menu;
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
pub fn run() {
    fix_path_from_shell();
    tauri::Builder::default()
        .setup(|app| {
            // Devtools no longer auto-open: in a debug build the docked
            // inspector stole half the window (and, for automation, the chat
            // input). Opt in with `PANDA_DEVTOOLS=1` when you actually need it.
            //
            // Debug-only: the webview inspector isn't compiled into release
            // builds (no `devtools` Cargo feature — see Cargo.toml), and
            // `open_devtools()` only exists under `cfg(debug_assertions)` there,
            // so this block must be debug-gated to compile in production.
            #[cfg(debug_assertions)]
            if std::env::var("PANDA_DEVTOOLS").is_ok_and(|v| v != "0" && !v.is_empty()) {
                if let Some(window) = tauri::Manager::get_webview_window(app, "main") {
                    window.open_devtools();
                }
            }
            // Windows: drop the native title bar. The in-window `WindowMenuBar`
            // (gated Windows-only in the frontend — see `main.jsx`) renders
            // custom minimize/maximize/close controls and a draggable region in
            // its place. macOS/Linux keep their native chrome (config
            // `decorations: true`); macOS also carries the native app menu (see
            // `crate::menu`). Done at runtime rather than in `tauri.conf.json`
            // because that flag can't be platform-scoped — this leaves macOS,
            // the dev platform, completely untouched. Best-effort.
            #[cfg(target_os = "windows")]
            if let Some(window) = tauri::Manager::get_webview_window(app, "main") {
                let _ = window.set_decorations(false);
            }
            // Install the app's bundled Claude Code skills into
            // ~/.claude/skills so the `claude` subprocess (and cadcode's
            // generator) can find them. Best-effort; symlinked skill dirs are
            // left alone for dev live-editing. See `crate::skills`.
            skills::install_bundled_skills(&tauri::Manager::app_handle(app).clone());
            skills::install_panda_mcp_config();
            // Replace Tauri's default macOS menu with one that adds a
            // "Check for Updates…" item under the Panda app menu, so the
            // update flow stays reachable after the in-app toast is dismissed.
            // No-op on non-macOS. See `crate::menu`.
            menu::install(tauri::Manager::app_handle(app))?;
            // Auto-update: on startup, run the auto-update flow. In the default
            // (prompt) mode this is a no-op and the UI drives a check-then-ask
            // flow via the `update_check` command; with the `auto_update`
            // setting on, it silently downloads + stages a newer signed bundle
            // and emits `update_event`s so the UI can show progress and offer a
            // restart. No-op in dev (no installed bundle to replace) and
            // silently best-effort on any error. Set PANDA_NO_UPDATE=1 to skip.
            if std::env::var("PANDA_NO_UPDATE").map_or(true, |v| v == "0" || v.is_empty()) {
                let handle = tauri::Manager::app_handle(app).clone();
                tauri::async_runtime::spawn(commands::update::run_startup_auto_update(handle));
            }
            // Export any stored Claude Code OAuth token (captured by
            // `app_login_claude` → `claude setup-token`) into this process's
            // environment so every spawned `claude -p` child inherits it and
            // headless turns authenticate without an interactive `/login`.
            tauri::async_runtime::spawn(commands::app::apply_stored_oauth_token_to_env());
            // Panda sign-in deep link: receive the browser's
            // `myide://auth/callback?code=…&state=…` and route it to the
            // waiting `app_panda_login`. Runtime-register the scheme so dev
            // (`cargo run`, no installer) also works; the installed build
            // registers it via the bundler (tauri.conf.json deep-link config).
            // The warm-start case on Windows/Linux (a second process spawned for
            // the link) is handled by the single-instance callback below.
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = tauri::Manager::app_handle(app).clone();
                let _ = app.deep_link().register("myide");
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        #[cfg(debug_assertions)]
                        eprintln!("[panda deeplink] on_open_url received: {}", url.as_str());
                        commands::app::handle_panda_deeplink(&handle, url.as_str());
                    }
                });
            }
            Ok(())
        })
        .on_menu_event(|app, event| menu::on_event(app, event.id.as_ref()))
        // Single-instance MUST be the first plugin registered. It also forwards
        // the deep-link URL: on Windows/Linux the OS launches a *second* process
        // for `myide://…`, whose argv carries the URL — we route it to
        // the same handler and focus the existing window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            for arg in &argv {
                if arg.starts_with("myide://") {
                    commands::app::handle_panda_deeplink(app, arg);
                }
            }
            if let Some(win) = tauri::Manager::get_webview_window(app, "main") {
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
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
            app::app_auth_check,
            app::app_login_claude,
            app::app_submit_login_code,
            app::app_panda_login,
            app::app_cancel_panda_login,
            app::app_set_auth_mode,
            app::app_panda_logout,
            app::app_install_orcaslicer,
            // catalog
            catalog::catalog_read,
            catalog::project_catalog_read,
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
            printer::printer_add_cloud,
            printer::printer_add_studio,
            printer::printer_list,
            printer::printer_status,
            printer::printer_upload_gcode,
            printer::printer_start_print,
            printer::printer_open_in_studio,
            printer::printer_open_in_studio_target,
            // cloud (Bambu account + cloud-transport printing)
            cloud::cloud_login_request_code,
            cloud::cloud_login_submit_code,
            cloud::cloud_login_password,
            cloud::cloud_account_status,
            cloud::cloud_logout,
            cloud::printer_discover_cloud,
            // project
            project::project_list,
            project::project_create,
            project::project_open,
            project::project_rename,
            project::project_delete,
            // update
            update::update_check,
            update::update_install,
            update::update_relaunch,
            update::update_latest_version,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Panda Tauri application");
}
