// Panda IPC transport — the bridge between the React viewer and the
// Tauri Rust shell.
//
// Source of truth: `docs/panda-interfaces.md` §2.
//
// At runtime:
//   - Inside the Tauri 2.x shell (`window.__TAURI_INTERNALS__` defined),
//     each function routes to `@tauri-apps/api/core#invoke()` with the
//     matching command name + camelCase argument shape.
//   - In plain browser dev (Vite dev server, no Tauri), each function
//     returns a labeled stub object so Track D and E can develop
//     against the same TS interface surface without crashing.
//
// Any change to this file MUST be mirrored in
// `desktop/src-tauri/src/ipc/types.rs`.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// Shared interfaces (mirror contract §2 verbatim)
// ---------------------------------------------------------------------------

export interface AppInfo {
  rootPath: string;
  appVersion: string;
  pid: number;
}

export type CatalogKind = "step" | "stl" | "gcode" | "py" | "json" | "png" | "implicit";
export type SourceKindValue = "python" | "static";

export interface CatalogPart {
  /** Part name (e.g. `chassis`), used as the display label. */
  name: string;
  /** Workspace-relative path of the part `.stl` (the catalog/entry key). */
  file: string;
  /** Cache-busted asset URL the viewer loads to render this part. */
  url: string;
}

export interface CatalogArtifact {
  /** URL of the sibling `.stl` the viewer renders as a `.step` entry's preview. */
  stlUrl?: string;
  metadataUrl?: string;
  /**
   * For assemblies: one printable `.stl` per named part (at build origin). The
   * viewer groups these under the integrated model. Empty for single-solid projects.
   */
  parts?: CatalogPart[];
}

export interface CatalogEntry {
  file: string;
  kind: CatalogKind;
  sourceKind: SourceKindValue | null;
  url: string;
  artifact?: CatalogArtifact;
  relations?: Record<string, string>;
}

export interface Catalog {
  entries: CatalogEntry[];
  rootPath: string;
  revision: number;
}

export interface GenerationQueueItem {
  file: string;
  startedAt: number;
  kind: "step";
}

export interface GenerationStatus {
  queue: GenerationQueueItem[];
  pythonAvailable: boolean;
  lastError?: { file: string; message: string; at: number };
}

export type AssetKind = "output" | "source" | "artifact";

export interface StepSourceStatus {
  hasSource: boolean;
  sourcePath?: string;
  sourceKind?: "python";
}

// Chat -----------------------------------------------------------------------

export interface ImageAttachment {
  /** Original filename, for display only (never used as a path server-side). */
  name?: string;
  /** MIME type, e.g. `image/png`. */
  mediaType: string;
  /** Raw file bytes, base64-encoded (no `data:` prefix). */
  dataBase64: string;
}

export interface StartTurnRequest {
  projectId: string;
  userMessage: string;
  /**
   * Optional reference images. The backend persists each into the project's
   * `inputs/` dir and points the model at them (it views them with Read).
   */
  images?: ImageAttachment[];
}

export interface StartTurnResponse {
  turnId: string;
}

export interface ApprovePlanRequest {
  projectId: string;
  planText: string;
}

export interface RequestPlanChangesRequest {
  projectId: string;
  feedback: string;
}

// A rehydrated assistant turn carries structured `blocks` so a reloaded turn
// rebuilds the same inline trace (reasoning + tool groups + per-segment timers)
// the live stream produced. Absent/empty for user turns and text-only turns.
export type ChatHistoryBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; at: number }
  | {
      kind: "tool_use";
      tool: string;
      toolUseId: string;
      input: unknown;
      status: "ok" | "error";
      resultSummary?: string;
      at: number;
      endedAt: number;
    };

export interface ChatSessionState {
  sessionId: string;
  turnInProgress: boolean;
  history: Array<{
    role: "user" | "assistant";
    content: string;
    at: number;
    blocks?: ChatHistoryBlock[];
  }>;
}

export type TurnPhase = "plan" | "implement";

// Every event carries `projectId` (the owning project) so the chat store routes
// a turn's events to the right project's conversation regardless of which one is
// on screen. Mirrors `ChatEventEnvelope` on the Rust side.
export type ChatEvent = (
  | { kind: "turn_start"; turnId: string; phase: TurnPhase }
  | { kind: "plan_proposed"; turnId: string; plan: string }
  | { kind: "text_delta"; turnId: string; text: string }
  | { kind: "thinking_delta"; turnId: string; text: string }
  | { kind: "tool_use_start"; turnId: string; tool: string; toolUseId: string; input: unknown }
  | { kind: "tool_use_end"; turnId: string; tool: string; toolUseId: string; ok: boolean; resultSummary?: string }
  | { kind: "artifact_changed"; turnId: string; file: string; reason: "new" | "modified" }
  | { kind: "turn_end"; turnId: string }
  | { kind: "error"; turnId: string; message: string }
  // Panda proxy auth was rejected (revoked/expired key → BE 401). The chat UI
  // surfaces a "Sign in again" action. Ends the turn like `error`.
  | { kind: "auth_expired"; turnId: string }
) & { projectId: string };

// Slicer ---------------------------------------------------------------------

export type FilamentKind = "PLA" | "PETG" | "TPU";

export interface SliceRequest {
  meshFile: string;
  printerId: string;
  filament: FilamentKind;
}

export interface SliceStats {
  durationSeconds: number;
  filamentGrams: number;
  filamentMeters: number;
  layerCount: number;
  supportsUsed: boolean;
  gcodeFile: string;
  /** Sliced project `.3mf` (gcode embedded) for the cloud print path. */
  gcode3mfFile?: string;
  /** Static analysis of the produced G-code; absent if it couldn't be read. */
  validation?: SliceValidation;
  /**
   * Actionable warnings OrcaSlicer reported about the model itself during a
   * successful slice (floating regions, unsupported overhangs, …) — the same
   * "re-orient or enable supports" notices its GUI shows. Empty/absent when none.
   */
  slicerWarnings?: string[];
}

export interface SliceValidation {
  /** Structural integrity only (non-empty + has movement + has extrusion). */
  ok: boolean;
  errors: string[];
  /** Non-fatal findings: bed bounds, missing temps, unrecognized commands. */
  warnings: string[];
  movementCommands: number;
  extrusionMoves: number;
  temperatureCommands: number;
}

export interface SliceStatus {
  inFlight: boolean;
  stage?: "preparing" | "slicing" | "writing";
  progress?: number;
}

export interface SliceProgressEvent {
  stage: string;
  progress: number;
}

// Printer --------------------------------------------------------------------

// "bambustudio" is not a network printer — it hands the model off to the
// locally installed Bambu Studio app (see printer_open_in_studio).
export type PrinterTransport = "lan" | "cloud" | "bambustudio";

export interface PrinterCard {
  id: string;
  model: string;
  transport: PrinterTransport;
  /** LAN IP — absent for cloud-only devices. */
  ipAddress?: string;
  hostName: string;
  /** Online flag from the cloud bind list — absent for LAN cards. */
  online?: boolean;
}

export interface AddPrinterRequest {
  ipAddress: string;
  accessCode: string;
  serial?: string;
}

export interface PrinterStatus {
  online: boolean;
  state: "idle" | "printing" | "paused" | "error";
  job?: { name: string; progress: number; etaSeconds: number };
}

export interface UploadGcodeRequest {
  printerId: string;
  gcodeFile: string;
  remoteName?: string;
}

export interface StartPrintRequest {
  printerId: string;
  remoteName: string;
  confirmed: true;
}

export interface PrintProgressEvent {
  printerId: string;
  state: string;
  progress: number;
}

export interface OpenInStudioRequest {
  /** Workspace-relative (catalog key) or absolute path to the model / gcode. */
  file: string;
}

/**
 * Which slicer app the open-in handoff would launch: Bambu Studio when
 * installed, else OrcaSlicer (standalone install or Panda's bundled sidecar),
 * else none. Drives the open-button label so it names the app that opens.
 */
export type OpenTargetApp = "bambustudio" | "orcaslicer" | "none";

// Bambu cloud account --------------------------------------------------------

export type CloudRegion = "global" | "china";

export interface CloudLoginRequest {
  account: string;
  region?: CloudRegion;
}

export interface CloudLoginSubmit {
  account: string;
  code: string;
}

export interface CloudPasswordLogin {
  account: string;
  password: string;
  region?: CloudRegion;
}

export interface AddCloudPrinterRequest {
  serial: string;
  accessCode: string;
  name?: string;
}

export interface CloudLoginChallenge {
  /** "codeSent" | "success" | "needPassword" | "tfa" */
  kind: string;
  tfaKey?: string;
}

export interface CloudAccountStatus {
  signedIn: boolean;
  account?: string;
  region?: CloudRegion;
  expiresAt?: number;
  needsReauth: boolean;
}

// Projects -------------------------------------------------------------------

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  hasModel: boolean;
}

export interface CreateProjectRequest {
  name: string;
}

// Result of publishing a project to panda-social (project_publish). Mirrors the
// Rust `PublishResponse`. `alreadyPublished` is true when the project had been
// imported before and the existing design is returned instead of a duplicate.
export interface PublishResponse {
  designId: string;
  slug: string;
  title: string;
  status: string;
  projectUrl: string;
  alreadyPublished: boolean;
}

// Snapshots (git-tag-style model save states) --------------------------------

export interface SnapshotSummary {
  id: string;
  label: string;
  createdAt: number;
}

// Result of snapshot_restore. `chatRewound` is true when the save captured the
// chat transcript and the live Claude session was rewound to it — the caller
// then reloads the chat panel from the restored conversation; false keeps the
// chat linear (an older save with no captured transcript).
export interface SnapshotRestore {
  summary: SnapshotSummary;
  chatRewound: boolean;
}

// App ------------------------------------------------------------------------

export interface PrereqCheck {
  claudeCli: { found: boolean; version?: string };
  python: { found: boolean; version?: string; healthy: boolean };
  slicer: { found: boolean; binaryPath: string };
}

export interface AppSettings {
  defaultFilament: FilamentKind;
  slicerBinaryPath: string;
  // OrcaSlicer machine+process config for `--load-settings` — `;`-joined
  // absolute JSON path(s). Empty = use OrcaSlicer's own default.
  slicerSettingsProfile?: string;
  // OrcaSlicer filament config for `--load-filaments`. Empty = none.
  slicerFilamentProfile?: string;
  // Preferred print device — a PrinterCard.id. When set and still paired, the
  // Print action targets it; empty/unpaired falls back to auto-pick. Mirrors
  // ipc/types.rs::AppSettings.default_printer_id.
  defaultPrinterId?: string;
  usePandaCloud: boolean;
  pandaToken?: string;
  // Panda proxy base URL captured by app_panda_login (the exchange `baseUrl`);
  // exported as ANTHROPIC_BASE_URL. Mirrors ipc/types.rs::AppSettings.panda_base_url.
  pandaBaseUrl?: string;
  // Captured by app_login_claude (`claude setup-token`); exported as
  // CLAUDE_CODE_OAUTH_TOKEN so headless turns authenticate. Mirrors
  // ipc/types.rs::AppSettings.claude_oauth_token.
  claudeOauthToken?: string;
  // Track E contract extension: lets the viewer gate the first-run wizard
  // with a single app_settings_read() call. Mirrored in
  // desktop/src-tauri/src/ipc/types.rs as a follow-up.
  hasOnboarded: boolean;
  // Update behavior. false (default) = prompt before downloading; true =
  // silently download in the background and notify when a restart will apply.
  autoUpdate: boolean;
  // Autopilot. true (default) = no plan-approval gate: after the model asks its
  // preference questions it builds + reviews unattended and delivers product +
  // parts. false = manual plan → Approve & build. Mirrors
  // ipc/types.rs::AppSettings.auto_build.
  autoBuild?: boolean;
  // Claude model passed to `claude --model`, set from the composer's model
  // switcher (app_set_model). undefined = built-in default (opus). Mirrors
  // ipc/types.rs::AppSettings.model.
  model?: string;
}

// Auto-update ----------------------------------------------------------------

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes?: string;
  date?: string;
}

/**
 * Discriminated union streamed via the `update_event` Tauri event across the
 * update lifecycle. Mirrors the serde enum in
 * `desktop/src-tauri/src/ipc/types.rs::UpdateEvent` (tag = "status",
 * snake_case variants, camelCase fields). The `available` variant flattens
 * `UpdateInfo` (serde internally-tagged newtype variant).
 */
export type UpdateEvent =
  | { status: "checking" }
  | { status: "up_to_date" }
  | ({ status: "available" } & UpdateInfo)
  | { status: "downloading"; downloadedBytes: number; totalBytes?: number }
  | { status: "ready"; version: string }
  | { status: "error"; message: string };

// Track I: auto-install Claude Code -----------------------------------------

/** Result of `app_install_claude_code`. */
export interface InstalledClaude {
  version: string;
  binaryPath: string;
}

/**
 * Discriminated union streamed via the `claude_install_progress` Tauri
 * event while `app_install_claude_code` is running. Mirrors the serde
 * enum in `desktop/src-tauri/src/ipc/types.rs::ClaudeInstallProgress`
 * (tag = "stage", snake_case variants, camelCase fields).
 */
export type ClaudeInstallProgress =
  | { stage: "downloading"; receivedBytes?: number; totalBytes?: number }
  | { stage: "running" }
  | { stage: "verifying" }
  | { stage: "done"; version: string; binaryPath: string }
  | { stage: "error"; message: string };

// Claude Code sign-in (setup-token OAuth) ------------------------------------

/**
 * Result of `app_auth_check` and `app_login_claude`. `authenticated` is the
 * single bit onboarding gates on; `source` (when present) is `"oauth_token"`
 * or `"credentials_file"`. Mirrors the serde struct in
 * `desktop/src-tauri/src/ipc/types.rs::ClaudeAuthStatus`.
 */
export interface ClaudeAuthStatus {
  authenticated: boolean;
  source?: "oauth_token" | "credentials_file";
}

/**
 * Discriminated union streamed via the `claude_login_progress` Tauri event
 * while `app_login_claude` drives `claude setup-token`. Mirrors the serde
 * enum in `desktop/src-tauri/src/ipc/types.rs::ClaudeLoginProgress` (tag =
 * "stage", snake_case variants, camelCase fields).
 */
export type ClaudeLoginProgress =
  | { stage: "starting" }
  | { stage: "awaiting_browser"; url: string }
  | { stage: "verifying" }
  | { stage: "done" }
  | { stage: "error"; message: string };

/**
 * Result of `app_panda_login` — the Panda-issued proxy token. Mirrors the serde
 * struct in `desktop/src-tauri/src/ipc/types.rs::PandaLoginResult`. The proxy key
 * is persisted Rust-side (as `panda_token` with `use_panda_cloud = true`) and is
 * intentionally NOT returned to the renderer — the frontend only learns it
 * succeeded.
 */
export interface PandaLoginResult {
  ok: boolean;
}

/**
 * Discriminated union streamed via the `panda_login_progress` Tauri event while
 * `app_panda_login` drives the (TBD) Panda proxy sign-in. Mirrors the serde enum
 * in `desktop/src-tauri/src/ipc/types.rs::PandaLoginProgress`.
 */
export type PandaLoginProgress =
  | { stage: "starting" }
  | { stage: "awaiting_browser"; url: string }
  | { stage: "verifying" }
  | { stage: "done" }
  | { stage: "error"; message: string };

/** Result of `app_install_orcaslicer`. */
export interface InstalledSlicer {
  version: string;
  binaryPath: string;
}

/**
 * Discriminated union streamed via the `slicer_install_progress` Tauri event
 * while `app_install_orcaslicer` is running. Mirrors the serde enum in
 * `desktop/src-tauri/src/ipc/types.rs::SlicerInstallProgress` (tag = "stage",
 * snake_case variants, camelCase fields).
 */
export type SlicerInstallProgress =
  | { stage: "downloading"; receivedBytes?: number; totalBytes?: number }
  | { stage: "extracting" }
  | { stage: "installing" }
  | { stage: "verifying" }
  | { stage: "done"; version: string; binaryPath: string }
  | { stage: "error"; message: string };

export interface CatalogChangedEvent {
  revision: number;
}

export interface IpcError {
  code: string;
  message: string;
  detail?: unknown;
}

// ---------------------------------------------------------------------------
// Transport implementation: Tauri invoke + listen with a labeled browser
// stub fallback.
// ---------------------------------------------------------------------------

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type ListenFn = <T>(
  event: string,
  handler: (payload: T) => void,
) => Promise<() => void>;

interface TauriBridge {
  invoke: InvokeFn;
  listen: ListenFn;
}

// `getTauriBridge` is intentionally lazy so this module can be evaluated
// in environments without Tauri (Vitest, Node `--test`) without exploding
// on a missing global.
let cachedBridge: TauriBridge | null | undefined;

export function setTauriBridge(bridge: TauriBridge | null): void {
  cachedBridge = bridge;
}

/**
 * Adapt Tauri's native `listen` to our {@link ListenFn} contract.
 *
 * `@tauri-apps/api/event`'s `listen(event, cb)` invokes `cb` with a full
 * `Event<T>` object — `{ event, id, payload }` — NOT the payload directly.
 * Every consumer here (and the chat reducer) expects the payload `T`. If we
 * hand the raw Tauri callback through unchanged, each `chat_event` reaches the
 * reducer as `{event,id,payload}`: `event.kind` is `undefined`, so the reducer
 * hits its `default` branch — nothing renders and `turn_end` is never seen,
 * leaving the turn stuck on "Cancel turn" forever. Unwrap `.payload` here so
 * the rest of the app sees the contract it was written against.
 */
export function adaptTauriListen(
  rawListen: (
    event: string,
    cb: (tauriEvent: { payload: unknown }) => void,
  ) => Promise<() => void>,
): ListenFn {
  return (<T>(event: string, handler: (payload: T) => void) =>
    rawListen(event, (tauriEvent) =>
      handler((tauriEvent as { payload: T }).payload),
    )) as ListenFn;
}

function detectTauri(): TauriBridge | null {
  // Important: only POSITIVE detections are cached. If we cache null on a
  // call that happens before Tauri injects __TAURI_INTERNALS__ (e.g.,
  // during module-load or first React render), subsequent calls would
  // forever fall through to the browser stub. So we re-probe each call
  // until we see the real bridge appear.
  if (cachedBridge) {
    return cachedBridge;
  }
  if (typeof window === "undefined") {
    return null;
  }
  // Tauri 2.x sets `window.__TAURI_INTERNALS__`. Tauri 1 used
  // `window.__TAURI__`. Detect either; prefer the v2 path with the
  // top-level imports from `@tauri-apps/api`.
  const w = window as unknown as {
    __TAURI__?: TauriBridge;
    __TAURI_INTERNALS__?: unknown;
  };
  if (w.__TAURI_INTERNALS__) {
    cachedBridge = {
      invoke: tauriInvoke as InvokeFn,
      // Tauri delivers `Event<T>` ({event,id,payload}); unwrap to the payload.
      listen: adaptTauriListen(
        tauriListen as unknown as Parameters<typeof adaptTauriListen>[0],
      ),
    };
    return cachedBridge;
  }
  if (w.__TAURI__) {
    cachedBridge = w.__TAURI__;
    return cachedBridge;
  }
  return null;
}

export function isTauriRuntime(): boolean {
  return detectTauri() !== null;
}

/**
 * True only when running on Windows. Used to gate the in-window menu bar
 * (`WindowMenuBar`): macOS has the native global menu (see `menu.rs`) and Linux
 * relies on its own WM chrome, so the in-window row is Windows-only. Detection
 * is webview-UA based — `navigator.userAgentData.platform` when present (modern
 * Chromium/WebView2), else a `userAgent` substring match. No `@tauri-apps` OS
 * plugin is wired, and the WebView2 UA reliably reports Windows.
 */
export function isWindowsPlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const uaPlatform = (
    navigator as unknown as { userAgentData?: { platform?: string } }
  ).userAgentData?.platform;
  if (uaPlatform) {
    return uaPlatform.toLowerCase().includes("win");
  }
  return /windows|win32|win64/i.test(navigator.userAgent || "");
}

/**
 * Reset the cached bridge — primarily for tests that swap the
 * bridge mid-suite. Production code should call `setTauriBridge` once
 * at startup from the Tauri entry point.
 */
export function _resetTransportForTests(): void {
  cachedBridge = undefined;
}

// Toggle transport call logging. On by default in dev; flip the global
// `__PANDA_TRANSPORT_LOG__` to override at runtime from the console.
function transportLogEnabled(): boolean {
  const w = globalThis as unknown as { __PANDA_TRANSPORT_LOG__?: boolean };
  if (typeof w.__PANDA_TRANSPORT_LOG__ === "boolean") {
    return w.__PANDA_TRANSPORT_LOG__;
  }
  return true;
}

const TRANSPORT_TAG = "[panda:transport]";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const bridge = detectTauri();
  const route = bridge ? "invoke" : "stub";
  if (transportLogEnabled()) {
    // eslint-disable-next-line no-console
    console.log(`${TRANSPORT_TAG} → ${cmd} (${route})`, args ?? {});
  }
  try {
    const result = bridge
      ? ((await bridge.invoke(cmd, args)) as T)
      : // Browser dev stub. The labels here are visible in DevTools so it's
        // obvious WHY a UI screen is showing canned data.
        stubResponse<T>(cmd, args ?? {});
    if (transportLogEnabled()) {
      // eslint-disable-next-line no-console
      console.log(`${TRANSPORT_TAG} ← ${cmd} (${route})`, result);
    }
    return result;
  } catch (err) {
    if (transportLogEnabled()) {
      // eslint-disable-next-line no-console
      console.error(`${TRANSPORT_TAG} ✕ ${cmd} (${route})`, err);
    }
    throw err;
  }
}

// How long / how often to keep probing for the Tauri bridge when a listener
// is attached before Tauri has injected `__TAURI_INTERNALS__`. The bridge
// normally appears within a few ms of load; the cap (~10s) just bounds the
// poll so a genuine browser-dev session doesn't spin forever.
const LISTEN_PROBE_INTERVAL_MS = 25;
const LISTEN_PROBE_MAX_ATTEMPTS = 400;

export async function listenEvent<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  const bridge = detectTauri();
  if (bridge) {
    return bridge.listen<T>(event, handler);
  }
  // Bridge not ready yet. Unlike invoke() — which re-probes detectTauri() on
  // every call and so recovers once Tauri injects the bridge — an event
  // listener is attached exactly once (e.g. ChatSidebar's mount effect). If we
  // returned a permanent no-op here, a listener attached during the early
  // startup race would stay deaf for the whole session: backend chat_events
  // (PlanProposed/text_delta/turn_end) would never reach the reducer and every
  // turn would hang on "PLANNING". So keep probing until the bridge appears,
  // then attach. The returned unsubscribe cancels whether or not we've attached
  // yet.
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  let attempts = 0;
  const timer = setInterval(() => {
    if (cancelled) {
      clearInterval(timer);
      return;
    }
    const ready = detectTauri();
    if (!ready) {
      if (++attempts >= LISTEN_PROBE_MAX_ATTEMPTS) {
        clearInterval(timer);
      }
      return;
    }
    clearInterval(timer);
    ready
      .listen<T>(event, handler)
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      })
      .catch(() => {
        /* bridge vanished mid-attach — nothing to unlisten */
      });
  }, LISTEN_PROBE_INTERVAL_MS);
  // Don't let the poll keep a Node process (tests) alive; harmless in browsers.
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => {
    cancelled = true;
    clearInterval(timer);
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };
}

// ---------------------------------------------------------------------------
// Browser dev stub — typed by the request shape, labeled in the response.
// Tracks D and E render against these until they're running inside Tauri.
// ---------------------------------------------------------------------------

const STUB_TAG = "[panda:transport:stub]";

function stubResponse<T>(cmd: string, args: Record<string, unknown>): T {
  switch (cmd) {
    case "app_info":
      return {
        rootPath: "/dev/panda-stub",
        appVersion: "0.0.0-stub",
        pid: 0,
      } as unknown as T;
    case "app_prereq_check":
      return {
        claudeCli: { found: false },
        python: { found: false, healthy: false },
        slicer: { found: false, binaryPath: "" },
      } as unknown as T;
    case "app_settings_read":
      return {
        defaultFilament: "PLA",
        slicerBinaryPath: "",
        usePandaCloud: false,
        hasOnboarded: true,
        autoUpdate: false,
        autoBuild: true,
      } as unknown as T;
    case "app_settings_write":
      return undefined as unknown as T;
    case "app_set_auth_mode":
      // Echo a settings snapshot reflecting the requested mode so the badge
      // updates in browser dev.
      return {
        defaultFilament: "PLA",
        slicerBinaryPath: "",
        usePandaCloud: Boolean(args.usePandaCloud),
        hasOnboarded: true,
        autoUpdate: false,
      } as unknown as T;
    case "app_set_model":
      // Echo a settings snapshot reflecting the chosen model so the composer's
      // switcher updates in browser dev.
      return {
        defaultFilament: "PLA",
        slicerBinaryPath: "",
        usePandaCloud: false,
        hasOnboarded: true,
        autoUpdate: false,
        model: String(args.model ?? ""),
      } as unknown as T;
    case "app_panda_logout":
      // Echo a signed-out settings snapshot so the badge falls back to local
      // in browser dev.
      return {
        defaultFilament: "PLA",
        slicerBinaryPath: "",
        usePandaCloud: false,
        hasOnboarded: true,
        autoUpdate: false,
      } as unknown as T;
    case "app_install_claude_code":
      // Browser dev stub. The real command runs only inside Tauri — in
      // a plain browser there's no shell to run sh on. Return a labeled
      // not-found error so the React side can surface the fallback path.
      throw {
        code: "PLATFORM_UNSUPPORTED",
        message: `${STUB_TAG} install-claude only runs inside Tauri`,
      } as IpcError;
    case "app_auth_check":
      // In a plain browser there's no host `claude`; report authenticated so
      // the onboarding login gate doesn't block browser-only dev.
      return { authenticated: true, source: "oauth_token" } as unknown as T;
    case "app_login_claude":
      // The real sign-in drives a PTY + browser OAuth — Tauri only.
      throw {
        code: "PLATFORM_UNSUPPORTED",
        message: `${STUB_TAG} claude sign-in only runs inside Tauri`,
      } as IpcError;
    case "app_submit_login_code":
      // Feeds the live PTY — Tauri only. No-op in browser dev.
      return undefined as unknown as T;
    case "app_cancel_panda_login":
      // No-op in browser dev (no in-flight Tauri sign-in to cancel).
      return undefined as unknown as T;
    case "app_submit_panda_token":
      // Echo a signed-in settings snapshot so the paste-token fallback completes
      // onboarding in browser dev without a real Tauri backend.
      return {
        defaultFilament: "PLA",
        slicerBinaryPath: "",
        usePandaCloud: true,
        pandaToken: String(args.token ?? ""),
        hasOnboarded: true,
        autoUpdate: false,
      } as unknown as T;
    case "app_panda_login":
      // Proxy sign-in talks to Panda's backend — Tauri only. Surface the same
      // "not available yet" shape the placeholder command returns so the
      // welcome screen's error/retry path is exercisable in browser dev.
      throw {
        code: "PANDA_BACKEND_PENDING",
        message: `${STUB_TAG} Panda sign-in only runs inside Tauri`,
      } as IpcError;
    case "catalog_read":
    case "project_catalog_read":
      return {
        entries: [],
        rootPath: "/dev/panda-stub",
        revision: 0,
      } as unknown as T;
    case "generation_status_read":
      return {
        queue: [],
        pythonAvailable: false,
      } as unknown as T;
    case "file_read_bytes":
      return new Uint8Array() as unknown as T;
    case "file_save":
      return null as unknown as T;
    case "file_reveal":
      return undefined as unknown as T;
    case "file_import":
      return [] as unknown as T;
    case "step_source_status_read":
      return { hasSource: false } as unknown as T;
    case "step_artifact_regenerate":
      return undefined as unknown as T;
    case "chat_start_turn":
    case "chat_approve_plan":
    case "chat_request_plan_changes":
      return { turnId: `stub-turn-${Date.now()}` } as unknown as T;
    case "chat_cancel_turn":
      return undefined as unknown as T;
    case "chat_session_state":
      return {
        sessionId: "stub-session",
        turnInProgress: false,
        history: [],
      } as unknown as T;
    case "slice_run": {
      const sliceReq = (args.req ?? args) as Partial<SliceRequest>;
      return {
        durationSeconds: 0,
        filamentGrams: 0,
        filamentMeters: 0,
        layerCount: 0,
        supportsUsed: false,
        gcodeFile: `${STUB_TAG} ${String(sliceReq.meshFile ?? "model.stl")}.gcode`,
      } as unknown as T;
    }
    case "slice_status":
      return { inFlight: false } as unknown as T;
    case "printer_discover":
      return [] as unknown as T;
    case "printer_add": {
      const addReq = (args.req ?? args) as Partial<AddPrinterRequest>;
      return {
        id: `stub-${String(addReq.ipAddress ?? "0.0.0.0")}`,
        model: "X1C",
        transport: "lan",
        ipAddress: String(addReq.ipAddress ?? ""),
        hostName: String(addReq.ipAddress ?? ""),
      } as unknown as T;
    }
    case "printer_add_cloud": {
      const cloudReq = (args.req ?? args) as Partial<AddCloudPrinterRequest>;
      return {
        id: `cloud:${String(cloudReq.serial ?? "0")}`,
        model: "X1C",
        transport: "cloud",
        hostName: String(cloudReq.name ?? cloudReq.serial ?? ""),
      } as unknown as T;
    }
    case "printer_add_studio":
      return {
        id: "bambu-studio",
        model: "Bambu Studio",
        transport: "bambustudio",
        hostName: "Open with Bambu Studio",
      } as unknown as T;
    case "printer_list":
      return [] as unknown as T;
    case "printer_status":
      return { online: false, state: "idle" } as unknown as T;
    case "printer_upload_gcode":
    case "printer_start_print":
    case "printer_open_in_studio":
      return undefined as unknown as T;
    case "printer_open_in_studio_target":
      return "bambustudio" as unknown as T;
    case "printer_discover_cloud":
      return [] as unknown as T;
    case "cloud_login_request_code":
      return { kind: "codeSent" } as unknown as T;
    case "cloud_login_submit_code":
      return { signedIn: false, needsReauth: false } as unknown as T;
    case "cloud_login_password":
      return { kind: "success" } as unknown as T;
    case "cloud_account_status":
      return { signedIn: false, needsReauth: false } as unknown as T;
    case "cloud_logout":
      return undefined as unknown as T;
    case "project_list":
      return [] as unknown as T;
    case "project_create": {
      const createReq = (args.req ?? args) as Partial<CreateProjectRequest>;
      return {
        id: `stub-${Date.now()}`,
        name: String(createReq.name ?? "Untitled"),
        createdAt: 0,
        updatedAt: 0,
        hasModel: false,
      } as unknown as T;
    }
    case "project_open":
      return { workspaceRoot: `/dev/panda-stub/${String(args.id ?? "")}` } as unknown as T;
    case "project_rename":
      return {
        id: String(args.id ?? "stub"),
        name: String(args.name ?? "Untitled"),
        createdAt: 0,
        updatedAt: 0,
        hasModel: false,
      } as unknown as T;
    case "project_delete":
      return undefined as unknown as T;
    case "snapshot_list":
      return [] as unknown as T;
    case "snapshot_save":
      return {
        id: `stub-snap-${Date.now()}`,
        label: String(args.label ?? "Version 1"),
        createdAt: Date.now(),
      } as unknown as T;
    case "snapshot_restore":
      return {
        summary: {
          id: String(args.snapshotId ?? "stub-snap"),
          label: "Saved state",
          createdAt: 0,
        },
        chatRewound: false,
      } as unknown as T;
    case "snapshot_delete":
      return undefined as unknown as T;
    case "update_check":
      // Browser dev: no updater. Report "no update available" so the
      // notifier stays dormant rather than throwing.
      return null as unknown as T;
    case "update_install":
    case "update_relaunch":
      return undefined as unknown as T;
    case "update_latest_version":
      return "0.0.0-stub" as unknown as T;
    default:
      throw new Error(`${STUB_TAG} unknown command: ${cmd}`);
  }
}

// ---------------------------------------------------------------------------
// Public command surface (one function per contract §2 endpoint).
// ---------------------------------------------------------------------------

const transportBase = {
  // app
  app_info: () => invoke<AppInfo>("app_info"),
  app_prereq_check: () => invoke<PrereqCheck>("app_prereq_check"),
  app_settings_read: () => invoke<AppSettings>("app_settings_read"),
  app_settings_write: (settings: AppSettings) =>
    invoke<void>("app_settings_write", { settings }),
  app_install_claude_code: () =>
    invoke<InstalledClaude>("app_install_claude_code"),
  app_auth_check: () => invoke<ClaudeAuthStatus>("app_auth_check"),
  app_login_claude: () => invoke<ClaudeAuthStatus>("app_login_claude"),
  // Submit the authorization code the user pasted from the browser into the
  // in-flight `claude setup-token` PTY (see app_login_claude).
  app_submit_login_code: (code: string) =>
    invoke<void>("app_submit_login_code", { code }),
  // Proxy sign-in to Panda's hosted Claude server ("Sign in with Panda"). On
  // success Rust persists the token + flips use_panda_cloud; progress streams
  // via the `panda_login_progress` event (see onPandaLoginProgress).
  app_panda_login: () => invoke<PandaLoginResult>("app_panda_login"),
  // Cancel an in-flight Panda sign-in (user closed the browser / chose another
  // path); the awaiting app_panda_login returns immediately instead of waiting
  // out the 10-min timeout.
  app_cancel_panda_login: () => invoke<void>("app_cancel_panda_login"),
  // Deep-link-independent sign-in fallback: paste the authorized `ccr-…` token
  // shown on the hosted sign-in page when the OS can't deliver the `myide://`
  // callback (macOS dev builds, or a browser that blocks the custom scheme).
  // Persists the session like the deep-link path and returns updated settings.
  app_submit_panda_token: (token: string) =>
    invoke<AppSettings>("app_submit_panda_token", { token }),
  // Switch the active Claude access mode (proxy ↔ own local Claude) without
  // re-onboarding. Enabling the proxy requires a prior Panda sign-in (errors
  // PANDA_NOT_SIGNED_IN otherwise). Returns the updated settings.
  app_set_auth_mode: (usePandaCloud: boolean) =>
    invoke<AppSettings>("app_set_auth_mode", { usePandaCloud }),
  app_set_model: (model: string) =>
    invoke<AppSettings>("app_set_model", { model }),
  // Sign out of the Panda proxy: clears the stored token and flips
  // use_panda_cloud off so chat falls back to the user's own local Claude.
  // Returns the updated settings.
  app_panda_logout: () => invoke<AppSettings>("app_panda_logout"),
  app_install_orcaslicer: () =>
    invoke<InstalledSlicer>("app_install_orcaslicer"),

  // catalog
  catalog_read: () => invoke<Catalog>("catalog_read"),
  project_catalog_read: (id: string) =>
    invoke<Catalog>("project_catalog_read", { id }),
  generation_status_read: () => invoke<GenerationStatus>("generation_status_read"),

  // files
  file_read_bytes: (file: string, asset: AssetKind) =>
    invoke<Uint8Array>("file_read_bytes", { file, asset }),
  file_save: (file: string, asset: AssetKind) =>
    invoke<string | null>("file_save", { file, asset }),
  file_reveal: (file: string, asset: AssetKind) =>
    invoke<void>("file_reveal", { file, asset }),
  // Import user-chosen STL/GLB files into the open project (normalized to
  // `.stl`); returns the imported workspace-relative paths, or [] if cancelled.
  file_import: () => invoke<string[]>("file_import"),

  // step
  step_source_status_read: (file: string) =>
    invoke<StepSourceStatus>("step_source_status_read", { file }),
  step_artifact_regenerate: (file: string, force: boolean) =>
    invoke<void>("step_artifact_regenerate", { file, force }),

  // chat
  chat_start_turn: (req: StartTurnRequest) =>
    invoke<StartTurnResponse>("chat_start_turn", { req }),
  chat_approve_plan: (req: ApprovePlanRequest) =>
    invoke<StartTurnResponse>("chat_approve_plan", { req }),
  chat_request_plan_changes: (req: RequestPlanChangesRequest) =>
    invoke<StartTurnResponse>("chat_request_plan_changes", { req }),
  chat_cancel_turn: (turnId: string) =>
    invoke<void>("chat_cancel_turn", { turnId }),
  chat_session_state: (projectId: string) =>
    invoke<ChatSessionState>("chat_session_state", { projectId }),

  // slicer
  slice_run: (req: SliceRequest) => invoke<SliceStats>("slice_run", { req }),
  slice_status: () => invoke<SliceStatus>("slice_status"),

  // printer
  printer_discover: () => invoke<PrinterCard[]>("printer_discover"),
  printer_add: (req: AddPrinterRequest) =>
    invoke<PrinterCard>("printer_add", { req }),
  printer_add_cloud: (req: AddCloudPrinterRequest) =>
    invoke<PrinterCard>("printer_add_cloud", { req }),
  // Register the "Open with Bambu Studio" handoff (a pseudo-printer; no pairing).
  printer_add_studio: () => invoke<PrinterCard>("printer_add_studio"),
  printer_list: () => invoke<PrinterCard[]>("printer_list"),
  printer_status: (printerId: string) =>
    invoke<PrinterStatus>("printer_status", { printerId }),
  printer_upload_gcode: (req: UploadGcodeRequest) =>
    invoke<void>("printer_upload_gcode", { req }),
  printer_start_print: (req: StartPrintRequest) =>
    invoke<void>("printer_start_print", { req }),
  // Open a model / gcode file in a locally installed slicer app (Bambu Studio,
  // else OrcaSlicer).
  printer_open_in_studio: (req: OpenInStudioRequest) =>
    invoke<void>("printer_open_in_studio", { req }),
  // Report which slicer app the open-in handoff would launch right now.
  printer_open_in_studio_target: () =>
    invoke<OpenTargetApp>("printer_open_in_studio_target"),

  // cloud (Bambu account + cloud-transport printing)
  cloud_login_request_code: (req: CloudLoginRequest) =>
    invoke<CloudLoginChallenge>("cloud_login_request_code", { req }),
  cloud_login_submit_code: (req: CloudLoginSubmit, region?: CloudRegion) =>
    invoke<CloudAccountStatus>("cloud_login_submit_code", { req, region }),
  cloud_login_password: (req: CloudPasswordLogin) =>
    invoke<CloudLoginChallenge>("cloud_login_password", { req }),
  cloud_account_status: () =>
    invoke<CloudAccountStatus>("cloud_account_status"),
  cloud_logout: () => invoke<void>("cloud_logout"),
  printer_discover_cloud: () =>
    invoke<PrinterCard[]>("printer_discover_cloud"),

  // project
  project_list: () => invoke<ProjectSummary[]>("project_list"),
  project_create: (req: CreateProjectRequest) =>
    invoke<ProjectSummary>("project_create", { req }),
  project_open: (id: string) =>
    invoke<{ workspaceRoot: string }>("project_open", { id }),
  project_rename: (id: string, name: string) =>
    invoke<ProjectSummary>("project_rename", { id, name }),
  project_delete: (id: string) => invoke<void>("project_delete", { id }),
  project_publish: (id: string) =>
    invoke<PublishResponse>("project_publish", { id }),
  social_has_token: () => invoke<boolean>("social_has_token"),
  social_set_token: (token: string) => invoke<void>("social_set_token", { token }),
  social_clear_token: () => invoke<void>("social_clear_token"),

  // snapshots (model save-states) — see desktop/src-tauri/src/commands/snapshot.rs
  snapshot_list: (projectId: string) =>
    invoke<SnapshotSummary[]>("snapshot_list", { projectId }),
  snapshot_save: (projectId: string, label?: string) =>
    invoke<SnapshotSummary>("snapshot_save", { projectId, label }),
  snapshot_restore: (projectId: string, snapshotId: string) =>
    invoke<SnapshotRestore>("snapshot_restore", { projectId, snapshotId }),
  snapshot_delete: (projectId: string, snapshotId: string) =>
    invoke<void>("snapshot_delete", { projectId, snapshotId }),

  // update — see desktop/src-tauri/src/commands/update.rs
  update_check: () => invoke<UpdateInfo | null>("update_check"),
  update_install: () => invoke<void>("update_install"),
  update_relaunch: () => invoke<void>("update_relaunch"),
  // Latest published version (from the updater's latest.json feed), shown in
  // the in-window About box. Persisted server-side for an offline fallback.
  update_latest_version: () => invoke<string>("update_latest_version"),

  // events
  //
  // Generic event bus used by the chat store (`attachChatEventStream` →
  // `transport.events.subscribe("chat_event", …)`). `listenEvent` resolves
  // its unlisten asynchronously, but callers expect a *synchronous*
  // unsubscribe, so we hand back a thunk that cancels whether or not the
  // underlying listener has finished attaching yet.
  events: {
    subscribe(kind: string, handler: (payload: unknown) => void): () => void {
      let unlisten: (() => void) | null = null;
      let cancelled = false;
      listenEvent<unknown>(kind, handler)
        .then((un) => {
          if (cancelled) un();
          else unlisten = un;
        })
        .catch(() => {
          /* browser dev mode / no bridge — nothing to unlisten */
        });
      return () => {
        cancelled = true;
        if (unlisten) {
          unlisten();
          unlisten = null;
        }
      };
    },
  },

  onChatEvent: (handler: (event: ChatEvent) => void) =>
    listenEvent<ChatEvent>("chat_event", handler),
  onCatalogChanged: (handler: (event: CatalogChangedEvent) => void) =>
    listenEvent<CatalogChangedEvent>("catalog_changed", handler),
  onSliceProgress: (handler: (event: SliceProgressEvent) => void) =>
    listenEvent<SliceProgressEvent>("slice_progress", handler),
  onPrintProgress: (handler: (event: PrintProgressEvent) => void) =>
    listenEvent<PrintProgressEvent>("print_progress", handler),
  onClaudeInstallProgress: (handler: (event: ClaudeInstallProgress) => void) =>
    listenEvent<ClaudeInstallProgress>("claude_install_progress", handler),
  onClaudeLoginProgress: (handler: (event: ClaudeLoginProgress) => void) =>
    listenEvent<ClaudeLoginProgress>("claude_login_progress", handler),
  onPandaLoginProgress: (handler: (event: PandaLoginProgress) => void) =>
    listenEvent<PandaLoginProgress>("panda_login_progress", handler),
  onSlicerInstallProgress: (handler: (event: SlicerInstallProgress) => void) =>
    listenEvent<SlicerInstallProgress>("slicer_install_progress", handler),
  onUpdateEvent: (handler: (event: UpdateEvent) => void) =>
    listenEvent<UpdateEvent>("update_event", handler),
};

export type Transport = typeof transportBase;

// ---------------------------------------------------------------------------
// Compat shims for parallel-track code that imported earlier proposed names
// (Track D used getTransport / __setTransportForTesting; Track E used
// setTransport / resetTransport). All routes resolve to the same Proxy so
// `setTransport(mock)` is visible to callers that previously imported the
// `transport` object directly.
// ---------------------------------------------------------------------------

let transportOverride: Partial<Transport> | null = null;

// Proxy lets `import { transport }` callers see the override on every read,
// not just at module-init time. Important for tests that mock per-case.
export const transport = new Proxy(transportBase, {
  get(target, prop, receiver) {
    if (transportOverride && prop in transportOverride) {
      return (transportOverride as Record<PropertyKey, unknown>)[prop as string];
    }
    return Reflect.get(target, prop, receiver);
  },
}) as Transport;

export function getTransport(): Transport {
  return transport;
}

export function __setTransportForTesting(mock: Partial<Transport> | null): () => void {
  const previous = transportOverride;
  transportOverride = mock;
  return () => {
    transportOverride = previous;
  };
}

export function setTransport(mock: Partial<Transport>): void {
  transportOverride = mock;
}

export function resetTransport(): void {
  transportOverride = null;
  _resetTransportForTests();
}
