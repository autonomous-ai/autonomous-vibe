//! Tauri IPC schema, mirroring `docs/panda-interfaces.md` §2.
//!
//! The Rust struct shapes in [`types`] are the source of truth; the
//! TypeScript module at `viewer/src/client/lib/transport.ts` is the
//! hand-mirrored client counterpart.

pub mod types;
pub mod error;

pub use error::{IpcError, IpcResult};
