//! Tauri command handlers. One module per command group in the IPC
//! contract (`docs/panda-interfaces.md` §2).

pub mod app;
pub mod catalog;
pub mod files;
pub mod step;
pub mod chat;
pub mod claude_driver;
pub mod slicer;
pub mod printer;
pub mod project;
pub mod update;
pub mod versions;
