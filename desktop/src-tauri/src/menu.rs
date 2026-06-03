//! Native application menu (macOS).
//!
//! Tauri auto-builds a default macOS menu, but it has no "Check for Updates"
//! affordance. Once the user dismisses the in-app update toast (the viewer's
//! `UpdateNotifier`), there is no other way back into the update flow — a
//! newer version is staged on the server but the user can't act on it. So we
//! replace the default with our own menu that mirrors the macOS standards
//! (About / Services / Hide / Quit, plus the Edit and Window menus that
//! copy-paste and window shortcuts rely on) and add a **"Check for Updates…"**
//! item under the app (Panda) menu.
//!
//! Clicking it runs [`crate::commands::update::update_install`], which
//! re-checks and — if a newer signed bundle exists — downloads and stages it,
//! streaming the same `update_event`s the `UpdateNotifier` already renders
//! (download progress → "restart to apply"). If the app is already current it
//! emits `UpToDate` and the UI stays quiet.
//!
//! macOS only: other platforms keep Tauri's default (no app menu bar), so
//! [`install`] and [`on_event`] are no-ops there.

#[cfg(target_os = "macos")]
use tauri::{
    menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle,
};

/// Menu-item id for the "Check for Updates…" entry. Matched in [`on_event`].
#[cfg(target_os = "macos")]
pub const CHECK_FOR_UPDATES_ID: &str = "panda_check_for_updates";

/// Build and install the application menu. Wire from `Builder::setup`.
#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let check_updates = MenuItem::with_id(
        app,
        CHECK_FOR_UPDATES_ID,
        "Check for Updates…",
        true,
        None::<&str>,
    )?;

    // First submenu = the macOS app menu (shown as "Panda").
    let app_menu = Submenu::with_items(
        app,
        "Panda",
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(app)?,
            &check_updates,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    // Edit menu — without it, Cmd+C/V/X/A and undo/redo stop working in the
    // chat input once we replace the default menu.
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let menu = Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])?;
    app.set_menu(menu)?;
    Ok(())
}

/// Handle a menu click. Wire from `Builder::on_menu_event`.
#[cfg(target_os = "macos")]
pub fn on_event(app: &AppHandle, id: &str) {
    if id == CHECK_FOR_UPDATES_ID {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            // Re-checks first: downloads + stages a newer bundle (streaming
            // `Downloading` → `Ready` events the UpdateNotifier renders) or
            // emits `UpToDate`. Best-effort — errors surface as soft events.
            let _ = crate::commands::update::update_install(handle).await;
        });
    }
}

/// No-op on non-macOS: those platforms keep Tauri's default menu.
#[cfg(not(target_os = "macos"))]
pub fn install(_app: &tauri::AppHandle) -> tauri::Result<()> {
    Ok(())
}

/// No-op on non-macOS.
#[cfg(not(target_os = "macos"))]
pub fn on_event(_app: &tauri::AppHandle, _id: &str) {}
