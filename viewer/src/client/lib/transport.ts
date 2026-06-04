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

export interface StartTurnRequest {
  projectId: string;
  userMessage: string;
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

export interface ChatSessionState {
  sessionId: string;
  turnInProgress: boolean;
  history: Array<{ role: "user" | "assistant"; content: string; at: number }>;
}

export type TurnPhase = "plan" | "implement";

export type ChatEvent =
  | { kind: "turn_start"; turnId: string; phase: TurnPhase }
  | { kind: "plan_proposed"; turnId: string; plan: string }
  | { kind: "text_delta"; turnId: string; text: string }
  | { kind: "thinking_delta"; turnId: string; text: string }
  | { kind: "tool_use_start"; turnId: string; tool: string; input: unknown }
  | { kind: "tool_use_end"; turnId: string; tool: string; ok: boolean }
  | { kind: "artifact_changed"; turnId: string; file: string; reason: "new" | "modified" }
  | { kind: "checkpoint_created"; turnId: string; checkpointId: string }
  | { kind: "turn_end"; turnId: string }
  | { kind: "error"; turnId: string; message: string };

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

export interface PrinterCard {
  id: string;
  model: string;
  ipAddress: string;
  hostName: string;
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

// Versions (checkpoints / branching) -----------------------------------------

export interface CheckpointInfo {
  id: string;
  parentId: string | null;
  turnId: string;
  sessionId: string;
  createdAt: number;
  title: string;
  prompt: string;
  artifacts: string[];
}

export interface RestoreVersionRequest {
  projectId: string;
  checkpointId: string;
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
  usePandaCloud: boolean;
  pandaToken?: string;
  // Track E contract extension: lets the viewer gate the first-run wizard
  // with a single app_settings_read() call. Mirrored in
  // desktop/src-tauri/src/ipc/types.rs as a follow-up.
  hasOnboarded: boolean;
  // Update behavior. false (default) = prompt before downloading; true =
  // silently download in the background and notify when a restart will apply.
  autoUpdate: boolean;
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
 * Reset the cached bridge — primarily for tests that swap the
 * bridge mid-suite. Production code should call `setTauriBridge` once
 * at startup from the Tauri entry point.
 */
export function _resetTransportForTests(): void {
  cachedBridge = undefined;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const bridge = detectTauri();
  if (bridge) {
    return (await bridge.invoke(cmd, args)) as T;
  }
  // Browser dev stub. The labels here are visible in DevTools so it's
  // obvious WHY a UI screen is showing canned data.
  return stubResponse<T>(cmd, args ?? {});
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
      } as unknown as T;
    case "app_settings_write":
      return undefined as unknown as T;
    case "app_install_claude_code":
      // Browser dev stub. The real command runs only inside Tauri — in
      // a plain browser there's no shell to run sh on. Return a labeled
      // not-found error so the React side can surface the fallback path.
      throw {
        code: "PLATFORM_UNSUPPORTED",
        message: `${STUB_TAG} install-claude only runs inside Tauri`,
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
        ipAddress: String(addReq.ipAddress ?? ""),
        hostName: String(addReq.ipAddress ?? ""),
      } as unknown as T;
    }
    case "printer_list":
      return [] as unknown as T;
    case "printer_status":
      return { online: false, state: "idle" } as unknown as T;
    case "printer_upload_gcode":
    case "printer_start_print":
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
    case "versions_list":
      return [] as unknown as T;
    case "version_restore":
      return undefined as unknown as T;
    case "update_check":
      // Browser dev: no updater. Report "no update available" so the
      // notifier stays dormant rather than throwing.
      return null as unknown as T;
    case "update_install":
    case "update_relaunch":
      return undefined as unknown as T;
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
  printer_list: () => invoke<PrinterCard[]>("printer_list"),
  printer_status: (printerId: string) =>
    invoke<PrinterStatus>("printer_status", { printerId }),
  printer_upload_gcode: (req: UploadGcodeRequest) =>
    invoke<void>("printer_upload_gcode", { req }),
  printer_start_print: (req: StartPrintRequest) =>
    invoke<void>("printer_start_print", { req }),

  // project
  project_list: () => invoke<ProjectSummary[]>("project_list"),
  project_create: (req: CreateProjectRequest) =>
    invoke<ProjectSummary>("project_create", { req }),
  project_open: (id: string) =>
    invoke<{ workspaceRoot: string }>("project_open", { id }),
  project_rename: (id: string, name: string) =>
    invoke<ProjectSummary>("project_rename", { id, name }),
  project_delete: (id: string) => invoke<void>("project_delete", { id }),

  // versions (checkpoints / branching) — see desktop/src-tauri/src/commands/versions.rs
  versions_list: (projectId: string) =>
    invoke<CheckpointInfo[]>("versions_list", { projectId }),
  version_restore: (req: RestoreVersionRequest) =>
    invoke<void>("version_restore", { req }),

  // update — see desktop/src-tauri/src/commands/update.rs
  update_check: () => invoke<UpdateInfo | null>("update_check"),
  update_install: () => invoke<void>("update_install"),
  update_relaunch: () => invoke<void>("update_relaunch"),

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
