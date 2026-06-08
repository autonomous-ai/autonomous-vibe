//! Process-wide runtime state held by Tauri's managed-state registry.
//!
//! Single source of truth for cross-command data: the catalog revision
//! counter, the generation queue, in-flight slice/chat turns, the
//! discovered/registered printer list.

use crate::ipc::types::{
    ChatSessionState, GenerationLastError, GenerationQueueItem, PrinterCard, SliceStatus,
};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::oneshot;

/// The in-RAM context for an in-flight Panda sign-in. `app_panda_login` stashes
/// this before opening the browser; the deep-link handler matches `state` and
/// delivers the one-time `code` (or an error) through `tx`. Never persisted.
pub struct PendingPandaLogin {
    /// The CSRF `state` value we sent to the web login; the callback must echo
    /// it back or we reject the response.
    pub state: String,
    /// Fires once with the authorization `code` on a matched callback, or an
    /// error string the command surfaces to the UI.
    pub tx: oneshot::Sender<Result<String, String>>,
}

pub struct AppState {
    /// Monotonic counter incremented when the catalog scanner detects
    /// a change. Surfaced via the `catalog_changed` event so the React
    /// client can invalidate its cached view.
    catalog_revision: AtomicU64,

    /// In-progress STEP regeneration jobs (contract §2:
    /// `GenerationStatus.queue`).
    generation_queue: Mutex<Vec<GenerationQueueItem>>,
    last_generation_error: Mutex<Option<GenerationLastError>>,

    /// In-progress slice. Track C only models a single slice at a
    /// time; that matches the contract's `SliceStatus` shape.
    slice_status: Mutex<SliceStatus>,

    /// Per-project chat session state.
    chat_sessions: Mutex<HashMap<String, ChatSessionState>>,

    /// The project the viewer currently has open. Set by `project_open`
    /// / `project_create`, cleared by `project_delete`. The catalog
    /// scanner and asset resolvers scope all filesystem access to this
    /// project's dir so the Models rail and `file_read_bytes` never see
    /// other projects or bundled resources.
    active_project: Mutex<Option<String>>,

    /// Registered Bambu printers (Track C stubs return canned data,
    /// real impl persists to `bambu-printers.json`).
    printers: Mutex<Vec<PrinterCard>>,

    /// Writer over the in-flight `claude setup-token` PTY's stdin. Installed by
    /// `app_login_claude` for the duration of a sign-in; `app_submit_login_code`
    /// writes the user-pasted authorization code into it so the OAuth
    /// paste-the-code flow can complete. `None` when no sign-in is in progress.
    login_pty_writer: Mutex<Option<Box<dyn Write + Send>>>,

    /// In-flight Panda sign-in awaiting its browser deep-link callback. Set by
    /// `app_panda_login`; consumed by the deep-link handler. `None` when no
    /// Panda sign-in is in progress.
    pending_panda_login: Mutex<Option<PendingPandaLogin>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            catalog_revision: AtomicU64::new(1),
            generation_queue: Mutex::new(Vec::new()),
            last_generation_error: Mutex::new(None),
            slice_status: Mutex::new(SliceStatus::default()),
            chat_sessions: Mutex::new(HashMap::new()),
            printers: Mutex::new(Vec::new()),
            active_project: Mutex::new(None),
            login_pty_writer: Mutex::new(None),
            pending_panda_login: Mutex::new(None),
        }
    }

    pub fn active_project(&self) -> Option<String> {
        self.active_project.lock().clone()
    }

    pub fn set_active_project(&self, id: Option<String>) {
        *self.active_project.lock() = id;
    }

    pub fn current_revision(&self) -> u64 {
        self.catalog_revision.load(Ordering::Acquire)
    }

    pub fn bump_revision(&self) -> u64 {
        self.catalog_revision.fetch_add(1, Ordering::AcqRel) + 1
    }

    pub fn generation_queue_snapshot(&self) -> Vec<GenerationQueueItem> {
        self.generation_queue.lock().clone()
    }

    pub fn last_generation_error(&self) -> Option<GenerationLastError> {
        self.last_generation_error.lock().clone()
    }

    pub fn push_generation_job(&self, item: GenerationQueueItem) {
        self.generation_queue.lock().push(item);
    }

    pub fn pop_generation_job(&self, file: &str) {
        self.generation_queue.lock().retain(|item| item.file != file);
    }

    pub fn record_generation_error(&self, err: GenerationLastError) {
        *self.last_generation_error.lock() = Some(err);
    }

    pub fn slice_status_snapshot(&self) -> SliceStatus {
        self.slice_status.lock().clone()
    }

    pub fn set_slice_status(&self, status: SliceStatus) {
        *self.slice_status.lock() = status;
    }

    pub fn chat_session_snapshot(&self, project_id: &str) -> Option<ChatSessionState> {
        self.chat_sessions.lock().get(project_id).cloned()
    }

    pub fn put_chat_session(&self, project_id: String, state: ChatSessionState) {
        self.chat_sessions.lock().insert(project_id, state);
    }

    pub fn printers_snapshot(&self) -> Vec<PrinterCard> {
        self.printers.lock().clone()
    }

    pub fn add_printer(&self, card: PrinterCard) {
        let mut list = self.printers.lock();
        if list.iter().any(|p| p.id == card.id) {
            return;
        }
        list.push(card);
    }

    /// Install the active sign-in PTY writer (see [`login_pty_writer`]).
    pub fn set_login_pty_writer(&self, writer: Box<dyn Write + Send>) {
        *self.login_pty_writer.lock() = Some(writer);
    }

    /// Drop the sign-in PTY writer (closes the child's stdin). Called when a
    /// login attempt finishes, succeeds, errors, or times out.
    pub fn clear_login_pty_writer(&self) {
        *self.login_pty_writer.lock() = None;
    }

    /// Write a user-submitted authorization code (plus a carriage return, which
    /// is what a terminal sends for Enter) into the active sign-in PTY. Returns
    /// `Err` when no sign-in is currently awaiting a code, or the write fails.
    pub fn write_login_code(&self, code: &str) -> Result<(), String> {
        let mut guard = self.login_pty_writer.lock();
        let writer = guard
            .as_mut()
            .ok_or_else(|| "no sign-in is currently awaiting a code".to_string())?;
        writer
            .write_all(code.trim().as_bytes())
            .and_then(|_| writer.write_all(b"\r"))
            .and_then(|_| writer.flush())
            .map_err(|e| e.to_string())
    }

    /// Arm the pending Panda sign-in (see [`PendingPandaLogin`]). Replaces any
    /// prior pending login — a fresh "Sign in with Panda" click supersedes a
    /// stale one (whose receiver has already timed out).
    pub fn set_pending_panda_login(&self, pending: PendingPandaLogin) {
        *self.pending_panda_login.lock() = Some(pending);
    }

    /// Take the pending Panda sign-in, leaving `None`. The deep-link handler
    /// calls this once per callback; the command's `oneshot` receiver only
    /// fires for the matching arming.
    pub fn take_pending_panda_login(&self) -> Option<PendingPandaLogin> {
        self.pending_panda_login.lock().take()
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
