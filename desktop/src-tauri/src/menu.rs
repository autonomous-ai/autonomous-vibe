//! Native application menu (macOS).
//!
//! Tauri auto-builds a default macOS menu, but it has no "Check for Updates"
//! affordance. Once the user dismisses the in-app update toast (the viewer's
//! `UpdateNotifier`), there is no other way back into the update flow — a
//! newer version is staged on the server but the user can't act on it. So we
//! replace the default with our own menu that mirrors the macOS standards
//! (About / Services / Hide / Quit, plus the Edit and Window menus that
//! copy-paste and window shortcuts rely on) and add a **"Check for Updates…"**
//! item under the app (Vibe) menu.
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
    AppHandle, Emitter,
};

/// Menu-item id for the "Check for Updates…" entry. Matched in [`on_event`].
#[cfg(target_os = "macos")]
pub const CHECK_FOR_UPDATES_ID: &str = "panda_check_for_updates";

/// Menu-item id for the "Add Printer…" entry. Matched in [`on_event`].
#[cfg(target_os = "macos")]
pub const ADD_PRINTER_ID: &str = "panda_add_printer";

/// Tauri event emitted to the webview when "Add Printer…" is chosen. The
/// frontend (ProjectMenu) listens for it and opens the add-printer dialog.
#[cfg(target_os = "macos")]
pub const OPEN_ADD_PRINTER_EVENT: &str = "open_add_printer";

/// Menu-item id for the "Run Setup Again…" entry. Matched in [`on_event`].
#[cfg(target_os = "macos")]
pub const RUN_SETUP_AGAIN_ID: &str = "panda_run_setup_again";

/// Tauri event emitted to the webview when "Run Setup Again…" is chosen. The
/// frontend (AppRoot) clears `hasOnboarded` and re-shows the onboarding wizard.
#[cfg(target_os = "macos")]
pub const RUN_SETUP_AGAIN_EVENT: &str = "run_setup_again";

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
    // About panel metadata. `AboutMetadata::default()` leaves every field
    // `None`, so the native panel renders with no version. Populate it from
    // Tauri's `PackageInfo` (derived from `tauri.conf.json`'s `version` — the
    // authoritative app/bundle version), mirroring muda's own cargo default:
    // `version` → macOS `ApplicationVersion` (shown in parens), `short_version`
    // → `Version` (the "Version X" line).
    let pkg = app.package_info();
    // User-facing app name. `pkg.name` is the Cargo crate name (`panda-desktop`);
    // the displayed name is `tauri.conf.json`'s `productName` ("Vibe"). Fall back
    // to the crate name only if `productName` is somehow unset.
    let app_name = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| pkg.name.clone());
    let about_metadata = AboutMetadata {
        name: Some(app_name.clone()),
        version: Some(pkg.version.to_string()),
        short_version: Some(format!("{}.{}", pkg.version.major, pkg.version.minor)),
        ..Default::default()
    };

    // First submenu = the macOS app menu (shown as "Vibe").
    let app_menu = Submenu::with_items(
        app,
        "Vibe",
        true,
        &[
            &PredefinedMenuItem::about(app, Some(&format!("About {app_name}")), Some(about_metadata))?,
            &PredefinedMenuItem::separator(app)?,
            &check_updates,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(&format!("Hide {app_name}")))?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some(&format!("Quit {app_name}")))?,
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

    // Printer menu — entry point to the printer-pairing flow for users who
    // skipped it during onboarding. Clicking emits OPEN_ADD_PRINTER_EVENT; the
    // webview opens the in-app dialog (the native menu can't render it).
    let add_printer = MenuItem::with_id(app, ADD_PRINTER_ID, "Add Printer…", true, None::<&str>)?;
    let printer_menu = Submenu::with_items(app, "Printer", true, &[&add_printer])?;

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

    let menu = Menu::with_items(app, &[&app_menu, &edit_menu, &printer_menu, &window_menu])?;
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
    } else if id == ADD_PRINTER_ID {
        // The dialog lives in the webview; tell it to open. Best-effort.
        let _ = app.emit(OPEN_ADD_PRINTER_EVENT, ());
    } else if id == RUN_SETUP_AGAIN_ID {
        // The onboarding wizard lives in the webview; it clears the flag and
        // re-shows itself. Best-effort.
        let _ = app.emit(RUN_SETUP_AGAIN_EVENT, ());
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
