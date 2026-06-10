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
    Implicit,
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

    /// Resolve a catalog kind from a full file name. Implicit CAD models use a
    /// compound `.implicit.js` / `.implicit.mjs` suffix whose trailing
    /// extension (`js`/`mjs`) is too generic for [`from_extension`], so they are
    /// matched on the suffix first; everything else falls back to the single
    /// extension. Plain `.js`/`.mjs` files therefore stay out of the catalog.
    pub fn from_filename(name: &str) -> Option<Self> {
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".implicit.js") || lower.ends_with(".implicit.mjs") {
            return Some(Self::Implicit);
        }
        let ext = std::path::Path::new(&lower)
            .extension()
            .and_then(|e| e.to_str())?;
        Self::from_extension(ext)
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
    /// For assemblies: one entry per named part, each its own printable `.stl`
    /// (at build origin). The viewer groups these under the integrated model.
    /// Empty/omitted for single-solid projects.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub parts: Vec<CatalogPart>,
}

/// A single named part of an assembly, surfaced from the `.step.json` sidecar's
/// `parts` array.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPart {
    /// Part name (e.g. `chassis`), used as the display label.
    pub name: String,
    /// Workspace-relative path of the part `.stl` (the catalog/entry key).
    pub file: String,
    /// Cache-busted asset URL the viewer loads to render this part.
    pub url: String,
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
    /// Reference images the user attached to this turn (additive, input-only).
    /// `#[serde(default)]` keeps existing callers and the browser HTTP stub
    /// valid when the field is absent. The chat handler persists each into the
    /// project's `inputs/` dir and points the model at them — see
    /// `commands/chat.rs`.
    #[serde(default)]
    pub images: Vec<ImageAttachment>,
}

/// One user-attached reference image. `data_base64` is the raw file bytes,
/// base64-encoded (no `data:` URI prefix); `media_type` is the MIME type
/// (e.g. `image/png`). `name` is the original filename for display only — it is
/// never trusted as a path.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    #[serde(default)]
    pub name: String,
    pub media_type: String,
    pub data_base64: String,
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
        /// Stable `tool_use_id` from the stream so the UI can pair this start
        /// with its `ToolUseEnd` by id (names collide when several tools of the
        /// same kind run in one turn).
        tool_use_id: String,
        input: serde_json::Value,
    },
    ToolUseEnd {
        turn_id: String,
        tool: String,
        /// Matches the `ToolUseStart.tool_use_id` this result completes.
        tool_use_id: String,
        ok: bool,
    },
    ArtifactChanged {
        turn_id: String,
        file: String,
        reason: ArtifactReason,
    },
    TurnEnd {
        turn_id: String,
    },
    Error {
        turn_id: String,
        message: String,
    },
    /// The Panda proxy rejected the turn's auth (revoked/expired `ccr-` key →
    /// the BE returns 401). Emitted instead of a generic `Error` when
    /// `use_panda_cloud` is on and the failure looks like an auth error, so the
    /// chat UI can offer a "Sign in again" action rather than a cryptic message.
    /// Ends the turn like `Error` does.
    AuthExpired {
        turn_id: String,
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
    /// Sliced project `.3mf` (gcode embedded) emitted alongside the plain
    /// G-code — the artifact the Bambu **cloud** print path uploads. `None`
    /// when the slicer did not produce one.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub gcode_3mf_file: Option<String>,
    /// Static analysis of the produced G-code. Best-effort and non-fatal: a
    /// slice still succeeds even when `validation.ok` is false. `None` when the
    /// G-code could not be read back.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub validation: Option<SliceValidation>,
    /// Actionable slicing warnings OrcaSlicer itself reported on stdout during a
    /// **successful** slice — e.g. "object has floating regions; re-orient or
    /// enable support generation". Distinct from `validation` (Panda's own static
    /// G-code analysis): these are the slicer's own findings about the model, the
    /// same notices its GUI surfaces. Empty/omitted when the slicer reported none.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub slicer_warnings: Vec<String>,
}

/// Result of statically validating a sliced `.gcode`. `ok` reflects structural
/// integrity only (the file has movement + extrusion and is non-empty); bed
/// bounds, missing-temperature, and unrecognized-command findings ride in
/// `warnings` so they never spuriously fail a slice (Bambu firmware legitimately
/// moves outside the printable area for purge/wipe).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceValidation {
    pub ok: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub movement_commands: u32,
    pub extrusion_moves: u32,
    pub temperature_commands: u32,
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

/// How Panda reaches a printer. `Lan` is the original direct-to-IP path
/// (SSDP/mDNS + FTPS + MQTT to the printer); `Cloud` routes through the
/// signed-in Bambu account (cloud MQTT + REST upload/print-job). `BambuStudio`
/// is not a real printer at all — it hands the model off to the locally
/// installed Bambu Studio app (`printer_open_in_studio`) so the user slices and
/// prints from there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PrinterTransport {
    #[default]
    Lan,
    Cloud,
    BambuStudio,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterCard {
    pub id: String,
    pub model: String,
    #[serde(default)]
    pub transport: PrinterTransport,
    /// LAN IP. `None` for cloud-only devices (no LAN address known).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ip_address: Option<String>,
    pub host_name: String,
    /// Online flag — carried by the cloud bind list; `None` for LAN cards
    /// (LAN discovery does not report it).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub online: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddPrinterRequest {
    pub ip_address: String,
    pub access_code: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub serial: Option<String>,
}

/// Register a cloud printer directly from its serial + access code, skipping the
/// account "bind list" discovery. The signed-in cloud account (token) authorizes
/// the actual upload/print; the serial drives the MQTT topic and the access code
/// is stored on the record.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddCloudPrinterRequest {
    pub serial: String,
    pub access_code: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
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

/// Hand a model (or G-code) file off to a locally installed slicer app.
/// `file` is workspace-relative (a catalog key like `model.stl`) or absolute.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenInStudioRequest {
    pub file: String,
}

/// Which locally-installed slicer app the "open in studio" handoff will launch.
/// Bambu Studio is preferred when present; otherwise Panda falls back to
/// OrcaSlicer (a standalone install or the bundled sidecar). `None` only when
/// neither is available. Drives the open-button label so it names the app that
/// will actually open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpenTargetApp {
    BambuStudio,
    OrcaSlicer,
    None,
}

impl OpenTargetApp {
    /// Human-readable app name for status / error messages.
    pub fn label(self) -> &'static str {
        match self {
            OpenTargetApp::BambuStudio => "Bambu Studio",
            OpenTargetApp::OrcaSlicer => "OrcaSlicer",
            OpenTargetApp::None => "a slicer",
        }
    }
}

// ---------------------------------------------------------------------------
// Bambu cloud account
// ---------------------------------------------------------------------------

/// Which Bambu cloud region (host set) the account belongs to. Global is the
/// default; China uses a separate API host + MQTT broker (carried for future
/// support — v1 ships Global).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CloudRegion {
    #[default]
    Global,
    China,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudLoginRequest {
    pub account: String,
    #[serde(default)]
    pub region: CloudRegion,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudLoginSubmit {
    pub account: String,
    pub code: String,
}

/// Direct email + password sign-in (no emailed verification code). Bambu may
/// still answer with a 2FA / verification challenge for some accounts, which the
/// command surfaces as a typed error.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudPasswordLogin {
    pub account: String,
    pub password: String,
    #[serde(default)]
    pub region: CloudRegion,
}

/// Result of `cloud_login_request_code`. `kind` is one of:
/// `codeSent` (verification email dispatched — call submit next),
/// `success` (token returned directly, no code needed),
/// `needPassword` (account requires password — unsupported in the
/// code-only v1 flow), `tfa` (two-factor — `tfa_key` set).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudLoginChallenge {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tfa_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudAccountStatus {
    pub signed_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<CloudRegion>,
    /// Unix seconds the access token expires at (from the JWT `exp` claim).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    /// True when the token is expired/near-expired and no refresh succeeded —
    /// the UI should re-prompt for an email code.
    pub needs_reauth: bool,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOpenResponse {
    pub workspace_root: String,
}

// ---------------------------------------------------------------------------
// Snapshots (git-tag-style model save states)
// ---------------------------------------------------------------------------

/// One saved model state. The files themselves live under
/// `<project>/.panda/snapshots/<id>/`; this is the index entry the UI lists
/// and reverts to. See `commands/snapshot.rs`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotSummary {
    pub id: String,
    pub label: String,
    /// Milliseconds since the Unix epoch.
    pub created_at: i64,
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
    /// A usable interpreter exists (bundled sidecar, else system `python3`).
    pub found: bool,
    /// `major.minor.patch` reported by the resolved interpreter, when probed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The resolved interpreter both matches the pinned `major.minor` and can
    /// import the full cadpy stack. `found && !healthy` means present but
    /// unusable (wrong version, missing deps) — onboarding can say *why*.
    pub healthy: bool,
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
    /// OrcaSlicer machine+process config for `--load-settings` — one or more
    /// absolute JSON paths joined by `;` (e.g. `machine.json;process.json`).
    /// Empty = pass no profile (OrcaSlicer uses its own default/last-used).
    /// v1 ships no bundled Bambu profiles, so this is how dev points the
    /// slicer at real configs. Added with cloud printing.
    #[serde(default)]
    pub slicer_settings_profile: String,
    /// OrcaSlicer filament config for `--load-filaments` — absolute JSON
    /// path(s), `;`-joined. Empty = none.
    #[serde(default)]
    pub slicer_filament_profile: String,
    /// Preferred print device — a `PrinterCard.id` (LAN serial, `cloud:<serial>`,
    /// or the `bambu-studio` handoff). When set and it still matches a paired
    /// device, the Print action targets it instead of auto-picking; an empty or
    /// no-longer-paired value falls back to the auto-pick heuristic. Lets the
    /// user choose which device prints a sliced model when several are paired.
    #[serde(default)]
    pub default_printer_id: String,
    pub use_panda_cloud: bool,
    /// Panda proxy key (`ccr-…`) captured by `app_panda_login`. Exported as
    /// `ANTHROPIC_AUTH_TOKEN` into the spawned `claude -p` when
    /// `use_panda_cloud` is set, so turns route through Panda's hosted proxy.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub panda_token: Option<String>,
    /// Panda proxy base URL (`baseUrl` returned by the sign-in exchange, e.g.
    /// `https://api-panda.autonomous.ai`). Exported as `ANTHROPIC_BASE_URL`
    /// alongside `panda_token`. `None` falls back to the compiled-in proxy URL.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub panda_base_url: Option<String>,
    /// Long-lived (1-year) Claude Code OAuth token captured by
    /// `app_login_claude` (`claude setup-token`). When present it is exported
    /// as `CLAUDE_CODE_OAUTH_TOKEN` into the spawned `claude -p` environment so
    /// headless turns authenticate without an interactive `/login`. Stored here
    /// (like `panda_token`) rather than in the OS keychain for v1 simplicity;
    /// the file already lives in the per-user app data dir.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub claude_oauth_token: Option<String>,
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
    /// Autopilot. `true` (default) = the design runs end-to-end with **no plan
    /// approval gate**: after the model asks its preference questions, it builds
    /// and runs the full review pipeline (geometry → functional → aesthetic)
    /// unattended, then delivers the product + parts. `false` restores the
    /// manual plan → *Approve & build* flow. Defaults true even for settings
    /// files written before this field existed (`default_true`).
    #[serde(default = "default_true")]
    pub auto_build: bool,
}

/// serde default for fields that should be `true` when absent from an existing
/// settings file (so a missing `auto_build` means autopilot, not manual).
fn default_true() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            default_filament: FilamentKind::Pla,
            slicer_binary_path: String::new(),
            slicer_settings_profile: String::new(),
            slicer_filament_profile: String::new(),
            default_printer_id: String::new(),
            use_panda_cloud: false,
            panda_token: None,
            panda_base_url: None,
            claude_oauth_token: None,
            has_onboarded: false,
            auto_update: false,
            auto_build: true,
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
// Claude Code sign-in (setup-token OAuth)
// ---------------------------------------------------------------------------

/// Result of `app_auth_check` and `app_login_claude`. `authenticated` is the
/// single bit onboarding gates on; `source` says how we know (for diagnostics
/// / UI copy), and is `None` when unauthenticated.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAuthStatus {
    pub authenticated: bool,
    /// One of `"oauth_token"` (a token we captured/stored or one already in the
    /// environment) or `"credentials_file"` (the user logged in interactively
    /// elsewhere and `~/.claude/.credentials.json` exists). `None` when not
    /// authenticated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// Streamed via the `claude_login_progress` Tauri event while
/// `app_login_claude` drives `claude setup-token` through a PTY. Mirrors the
/// TS discriminated union in `viewer/src/client/lib/transport.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "stage", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ClaudeLoginProgress {
    /// Spawning `claude setup-token`.
    Starting,
    /// The OAuth URL was detected in the CLI output. The CLI opens the default
    /// browser itself; `url` is surfaced so the UI can show a manual fallback
    /// link if the browser didn't open.
    AwaitingBrowser {
        url: String,
    },
    /// Browser flow finished; we captured a token and are persisting it.
    Verifying,
    Done,
    Error {
        message: String,
    },
}

// ---------------------------------------------------------------------------
// Panda proxy sign-in (placeholder — backend in progress)
// ---------------------------------------------------------------------------

/// Result of `app_panda_login`. The issued proxy key is **never** returned to
/// the renderer — it is persisted Rust-side (`panda_token` + `use_panda_cloud`,
/// see `store_panda_session`) and only ever leaves the process as an env var on
/// the spawned `claude` child. The renderer just needs to know it succeeded.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PandaLoginResult {
    pub ok: bool,
}

/// Streamed via the `panda_login_progress` Tauri event while `app_panda_login`
/// drives the (TBD) Panda proxy sign-in. Deliberately mirrors
/// `ClaudeLoginProgress` so the welcome screen can reuse the same
/// starting/awaiting/verifying/done/error states regardless of which sign-in
/// UX the backend ultimately ships. Mirrors the TS union in
/// `viewer/src/client/lib/transport.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "stage", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum PandaLoginProgress {
    /// Beginning the sign-in flow.
    Starting,
    /// A hosted sign-in URL is ready; the UI can surface `url` as a fallback
    /// link if the browser didn't open. (Only emitted by a browser-OAuth UX.)
    AwaitingBrowser {
        url: String,
    },
    /// Sign-in finished; we captured a token and are persisting it.
    Verifying,
    Done,
    Error {
        message: String,
    },
}

// ---------------------------------------------------------------------------
// OrcaSlicer auto-install
// ---------------------------------------------------------------------------

/// Result of `app_install_orcaslicer` — the post-install snapshot of the
/// freshly resolved slicer binary.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSlicer {
    pub version: String,
    pub binary_path: String,
}

/// Streamed via the `slicer_install_progress` Tauri event while
/// `app_install_orcaslicer` is running. Mirrors the TS discriminated union in
/// `viewer/src/client/lib/transport.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "stage", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum SlicerInstallProgress {
    Downloading {
        #[serde(skip_serializing_if = "Option::is_none")]
        received_bytes: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        total_bytes: Option<u64>,
    },
    Extracting,
    Installing,
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
