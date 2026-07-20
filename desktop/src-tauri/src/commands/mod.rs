//! Tauri command handlers. One module per command group in the IPC
//! contract (`docs/panda-interfaces.md` §2).

pub mod app;
pub mod catalog;
pub mod files;
pub mod step;
pub mod chat;
pub mod claude_driver;
pub mod claude_stream_debug;
pub mod slicer;
pub mod printer;
pub mod cloud;
pub mod project;
pub mod snapshot;
pub mod social;
pub mod update;

/// Windows `CREATE_NO_WINDOW` process-creation flag. Spawning a console
/// program (`claude`, `python`, …) from our GUI process — which has no
/// console of its own — otherwise makes Windows allocate a visible cmd /
/// PowerShell window for the child. Applying this flag suppresses it.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Suppress the child console window on Windows for a `tokio::process::Command`.
/// No-op on other platforms. Call before `.spawn()` / `.output()`.
#[allow(unused_variables)]
pub fn hide_console_tokio(command: &mut tokio::process::Command) {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
}

/// Suppress the child console window on Windows for a `std::process::Command`.
/// No-op on other platforms. Call before `.spawn()` / `.output()`.
#[allow(unused_variables)]
pub fn hide_console_std(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}
