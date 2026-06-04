//! Serde struct definitions mirroring `docs/panda-interfaces.md` §2.
//!
//! These are the Rust source of truth for the Tauri IPC schema. Any
//! change here MUST land in `viewer/src/client/lib/transport.ts` in the
//! same commit.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Inherited commands (replace viewer/src/server/server.mjs)
// ---------------------------------------------------------------------------

/// `app_info` — replaces `GET /__cad/server`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub root_path: String,
    pub app_version: String,
    pub pid: u32,
}

/// Per-entry record returned by `catalog_read`. Mirrors the TS
/// `CatalogEntry` interface verbatim.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub file: String,
    pub kind: CatalogKind,
    pub source_kind: Option<SourceKind>,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact: Option<CatalogArtifact>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relations: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CatalogKind {
    Step,
    Stl,
    Gcode,
    Py,
    Json,
    Png,
}

impl CatalogKind {
    /// Map a lowercase extension (without dot) to a catalog kind. Returns
    /// `None` for extensions outside the contract enum.
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext {
            "step" | "stp" => Some(Self::Step),
            "stl" => Some(Self::Stl),
            "gcode" => Some(Self::Gcode),
            "py" => Some(Self::Py),
            "json" => Some(Self::Json),
            "png" => Some(Self::Png),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Python,
    Static,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogArtifact {
    /// URL of the sibling `.stl` the viewer renders as the preview mesh for a
    /// `.step` entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stl_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub entries: Vec<CatalogEntry>,
    pub root_path: String,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationStatus {
    pub queue: Vec<GenerationQueueItem>,
    pub python_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<GenerationLastError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationQueueItem {
    pub file: String,
    pub started_at: i64,
    pub kind: GenerationQueueKind,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GenerationQueueKind {
    Step,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationLastError {
    pub file: String,
    pub message: String,
    pub at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AssetKind {
    Output,
    Source,
    Artifact,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepSourceStatus {
    pub has_source: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_kind: Option<StepSourceKind>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StepSourceKind {
    Python,
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTurnRequest {
    pub project_id: String,
    pub user_message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTurnResponse {
    pub turn_id: String,
}

/// Approve a proposed design plan and resume the session in `acceptEdits`
/// mode to implement it. `plan_text` is the (possibly user-edited) plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovePlanRequest {
    pub project_id: String,
    pub plan_text: String,
}

/// Request changes to a proposed plan; the session stays in `plan` mode and
/// the model revises. `feedback` is the user's free-text request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanChangesRequest {
    pub project_id: String,
    pub feedback: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSessionState {
    pub session_id: String,
    pub turn_in_progress: bool,
    pub history: Vec<ChatHistoryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryEntry {
    pub role: ChatRole,
    pub content: String,
    pub at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    User,
    Assistant,
}

/// Discriminated union of chat-stream events emitted as `chat_event`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ChatEvent {
    TurnStart {
        turn_id: String,
        /// Which workflow phase this turn runs in, so the UI can badge it
        /// "Planning" vs "Building".
        phase: TurnPhaseTag,
    },
    /// Emitted when the model calls the built-in `ExitPlanMode` tool: the
    /// design plan is ready for the user to review/edit/approve. `plan` is
    /// markdown. The plan turn ends immediately after.
    PlanProposed {
        turn_id: String,
        plan: String,
    },
    TextDelta {
        turn_id: String,
        text: String,
    },
    ThinkingDelta {
        turn_id: String,
        text: String,
    },
    ToolUseStart {
        turn_id: String,
        tool: String,
        input: serde_json::Value,
    },
    ToolUseEnd {
        turn_id: String,
        tool: String,
        ok: bool,
    },
    ArtifactChanged {
        turn_id: String,
        file: String,
        reason: ArtifactReason,
    },
    /// Emitted after a successful build turn auto-saves a version checkpoint
    /// (model + conversation snapshot). The UI uses it to attach a "Start from
    /// here" affordance to the turn and refresh its version list.
    CheckpointCreated {
        turn_id: String,
        checkpoint_id: String,
    },
    TurnEnd {
        turn_id: String,
    },
    Error {
        turn_id: String,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactReason {
    New,
    Modified,
}

/// Wire tag for the workflow phase a chat turn runs in. Mirrors the
/// driver's internal `TurnPhase`; serialized lowercase (`plan`/`implement`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TurnPhaseTag {
    Plan,
    Implement,
}

// ---------------------------------------------------------------------------
// Slicer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceRequest {
    pub mesh_file: String,
    pub printer_id: String,
    pub filament: FilamentKind,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum FilamentKind {
    Pla,
    Petg,
    Tpu,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceStats {
    pub duration_seconds: f64,
    pub filament_grams: f64,
    pub filament_meters: f64,
    pub layer_count: u32,
    pub supports_used: bool,
    pub gcode_file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SliceStatus {
    pub in_flight: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<SliceStage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SliceStage {
    Preparing,
    Slicing,
    Writing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceProgressEvent {
    pub stage: String,
    pub progress: f64,
}

// ---------------------------------------------------------------------------
// Printer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterCard {
    pub id: String,
    pub model: String,
    pub ip_address: String,
    pub host_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddPrinterRequest {
    pub ip_address: String,
    pub access_code: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub serial: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterStatus {
    pub online: bool,
    pub state: PrinterState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job: Option<PrinterJob>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PrinterState {
    Idle,
    Printing,
    Paused,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterJob {
    pub name: String,
    pub progress: f64,
    pub eta_seconds: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadGcodeRequest {
    pub printer_id: String,
    pub gcode_file: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub remote_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartPrintRequest {
    pub printer_id: String,
    pub remote_name: String,
    /// Always `true` — the contract requires explicit consumer confirm.
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintProgressEvent {
    pub printer_id: String,
    pub state: String,
    pub progress: f64,
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub has_model: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectRequest {
    pub name: String,
}

// ---------------------------------------------------------------------------
// Versions (checkpoints / branching)
// ---------------------------------------------------------------------------

/// One node in a project's checkpoint tree. Auto-created after each successful
/// build turn; also the persisted record in `.panda/history.json`. `parent_id`
/// makes the history a tree (restoring an older checkpoint and building again
/// forks it), and `session_id` is the Claude session whose transcript snapshot
/// this checkpoint carries, so "Start from here" can branch the conversation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointInfo {
    pub id: String,
    pub parent_id: Option<String>,
    pub turn_id: String,
    pub session_id: String,
    pub created_at: i64,
    /// Short human label (derived from the user's prompt).
    pub title: String,
    pub prompt: String,
    /// Workspace-relative artifact paths captured in this checkpoint.
    pub artifacts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreVersionRequest {
    pub project_id: String,
    pub checkpoint_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOpenResponse {
    pub workspace_root: String,
}

// ---------------------------------------------------------------------------
// App settings + prereq check
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrereqCheck {
    pub claude_cli: ClaudeCliStatus,
    pub python: PythonStatus,
    pub slicer: SlicerStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCliStatus {
    pub found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonStatus {
    pub found: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlicerStatus {
    pub found: bool,
    pub binary_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub default_filament: FilamentKind,
    pub slicer_binary_path: String,
    pub use_panda_cloud: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub panda_token: Option<String>,
    /// Lets the viewer gate the first-run wizard with a single
    /// app_settings_read() call. Added by Track E.
    #[serde(default)]
    pub has_onboarded: bool,
    /// Update behavior. `false` (default) = **prompt**: on startup the app
    /// only checks and the UI asks before downloading. `true` = **auto**:
    /// the app silently downloads a newer bundle in the background and the
    /// UI notifies the user that a restart will apply it. Either way the
    /// install is never applied without the user choosing to relaunch.
    #[serde(default)]
    pub auto_update: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            default_filament: FilamentKind::Pla,
            slicer_binary_path: String::new(),
            use_panda_cloud: false,
            panda_token: None,
            has_onboarded: false,
            auto_update: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Catalog events
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogChangedEvent {
    pub revision: u64,
}

// ---------------------------------------------------------------------------
// Claude Code auto-install (Track I)
// ---------------------------------------------------------------------------

/// Result of `app_install_claude_code` — the post-install snapshot of the
/// freshly resolved CLI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledClaude {
    pub version: String,
    pub binary_path: String,
}

/// Streamed via the `claude_install_progress` Tauri event while the
/// installer is running. Mirrors the TS discriminated union in
/// `viewer/src/client/lib/transport.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "stage", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ClaudeInstallProgress {
    Downloading {
        #[serde(skip_serializing_if = "Option::is_none")]
        received_bytes: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        total_bytes: Option<u64>,
    },
    Running,
    Verifying,
    Done {
        version: String,
        binary_path: String,
    },
    Error {
        message: String,
    },
}

// ---------------------------------------------------------------------------
// Auto-update (tauri-plugin-updater)
// ---------------------------------------------------------------------------

/// Summary of an available update, returned by `update_check` and carried in
/// the `UpdateEvent::Available` payload. `current_version` is the running
/// build; `version` is the newer one on the release endpoint.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
}

/// Streamed via the `update_event` Tauri channel across the whole update
/// lifecycle. Drives every update surface in the UI: the "update available"
/// prompt + passive badge (`Available`), the download progress bar
/// (`Downloading`), and the "restart to apply" banner (`Ready`). Mirrors the
/// TS discriminated union in `viewer/src/client/lib/transport.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum UpdateEvent {
    /// A check is in flight (UI may show a subtle "checking…" hint).
    Checking,
    /// The running build is the latest; nothing to do.
    UpToDate,
    /// A newer signed bundle exists but has not been downloaded yet.
    Available(UpdateInfo),
    /// Bytes are streaming down. `total_bytes` is absent when the server
    /// doesn't send a Content-Length.
    Downloading {
        downloaded_bytes: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        total_bytes: Option<u64>,
    },
    /// The update is downloaded and staged; relaunch to apply it.
    Ready { version: String },
    /// The check or download failed; auto-update is best-effort so this is
    /// surfaced softly and never blocks the app.
    Error { message: String },
}
