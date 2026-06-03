# Panda — Frozen Interface Contracts

Three contracts that all parallel implementation tracks must code against.
Frozen for v1.0; any change here requires re-coordination across tracks.

Document version: **v1.0-post-merge** (2026-05-28).

Changes since pre-flight:
- AppSettings gained `hasOnboarded: boolean` (Track E; mirrored in Rust as `has_onboarded`)
- §1 documents the concrete `generate_step()` signature now that Track A's follow-up wrapper has landed
- §2 added `app_install_claude_code()` + `claude_install_progress` event for Track I (one-click Claude Code install from the first-run wizard)

- [1. `gen_step()` CadQuery contract](#1-gen_step-cadquery-contract) — Tracks A, B
- [2. Tauri IPC schema](#2-tauri-ipc-schema) — Tracks C, D, E
- [3. Skill stdout + artifact contract](#3-skill-stdout--artifact-contract) — Tracks B, C

---

## 1. `gen_step()` CadQuery contract

### Scope

Defines what a Panda CAD project's `gen_step()` function may return and what
`cadpy.generation.generate_step()` produces. CadQuery is the only modeling
library; the input is resolved by duck-typing on its underlying OCCT
`TopoDS_Shape`.

### Project shape

A "project" is a directory under the workspace containing at minimum:

```
<project>/
├── main.py           required — defines gen_step(); imported as a module
├── params.py         optional — dataclass Params with all dimensions
├── parts/            optional — one Python module per physical part
├── features/         optional — reusable feature functions
└── assemblies/       optional — positioning + union of parts
```

The runner adds the project dir to `sys.path` so `from params import Params`
and `from parts.base import …` resolve. `main.py` must define `gen_step()`
at module scope. The legacy single-file `result = <shape>` form is also
accepted; the runner treats it as if `gen_step()` returned `result`.

### Accepted return values

`gen_step()` returns **one** of:

| Form | Type | Meaning |
|---|---|---|
| **Shape (CadQuery)** | `cq.Workplane` or `cq.Shape` | Single-solid part. Internally normalized to `{"shape": cq_obj}`. |
| **Assembly (CadQuery)** | `cq.Assembly` | Named hierarchy. Walked into `{"children": [...]}` of instances. |
| **List** | `list[Instance]` | Manual assembly composition (see `assembly_spec.AssemblyInstance`). |
| **Envelope dict** | `dict` | Explicit form, see below. |

### Envelope dict keys

A dict return must contain **exactly one** of `shape`, `instances`,
`children`, plus any of the optional output-control keys. Unknown keys raise
`TypeError`.

```python
{
    # Exactly one content key:
    "shape":     <cq.Workplane | cq.Shape>,
    "instances": list[AssemblyInstance],
    "children":  list[Shape | Workplane | AssemblyInstance],

    # Optional output controls (all bypass-able):
    "step_output":           str | Path,   # override the STEP path
    "mesh_tolerance":        float,        # linear, mm; default 0.05
    "mesh_angular_tolerance": float,       # deg; default 3.0
}
```

The `.stl` is always written (it is both the printable deliverable and the
viewer's preview mesh); there is no envelope flag to toggle it.

### Library-agnostic resolution

`generation.py` MUST resolve the input via duck-typing on `.wrapped` —
**not** isinstance checks against `cq.Workplane` / `cq.Shape`. The rule, in
order:

1. If `result` is a `dict`, dispatch on `(shape|instances|children)` key.
2. If `result` is a `list`, treat as `{"children": result}`.
3. If `result` has callable `.val()` and `.val().wrapped` is a
   `TopoDS_Shape`, treat as `{"shape": result}` (CadQuery `Workplane`).
4. If `result.wrapped` is a `TopoDS_Shape`, treat as `{"shape": result}`
   (CadQuery `Shape` or any future `TopoDS_Shape` wrapper).
5. If `result` is a `cq.Assembly` (has `.children` and `.toCompound()`),
   walk it into `{"children": [...]}`.
6. Otherwise raise `TypeError` with the offending type name.

This keeps the contract open to future OCP wrappers without invasive
edits.

### Face-ID stability

Face / edge / vertex ordinals MUST come from
`TopExp.MapShapes_s(shape.wrapped, TopAbs_*)` over the OCCT topology tree —
**not** from CadQuery-specific tags or selectors — so a given CadQuery shape
yields deterministic ordinals. A regression test in
`tests/test_cadquery_generation.py` asserts the stable top-face ordinal for
`cq.Workplane().box(20, 20, 5)`.

### Public entry point

```python
def generate_step(
    project_dir: Path | str,
    output_path: Path | str,
    *,
    mesh_tolerance: float = DEFAULT_MESH_TOLERANCE,
    mesh_angular_tolerance: float = DEFAULT_MESH_ANGULAR_TOLERANCE,
) -> dict[str, object]
```

Loads `<project_dir>/main.py`, calls `gen_step()` (or picks up legacy
module-level `result`), and writes the artifacts below. Returns a dict
with `step_path`, `stl_path`, `metadata_path`, plus `is_solid`,
`volume_mm3`, and `bbox`.

`generate_step_targets()` remains the multi-target CLI entry; the new
`generate_step()` is the single-project wrapper Panda's runner uses.

### Artifacts written per call

`generate_step(project_dir, output_path, ...)` produces these files; paths
shown relative to `output_path`'s parent.

| File | Always written? | Purpose |
|---|---|---|
| `<stem>.step` | yes | B-rep archival, labels + colors via XCAF |
| `<stem>.stl` | yes | Printable mesh + the viewer's preview mesh |
| `<stem>.step.json` | yes | Source hash, generator metadata, validation summary |

`<stem>` is the basename of `output_path`. The driver's mtime snapshotter
(contract §3) watches all three extensions.

### Error contract

All errors raised by `generate_step()` MUST be subclasses of
`cadpy.generation.GenerationError`. The runner catches these, prints a
single-line JSON error result (contract §3), and exits 1.

### Regression rule

The existing 12 pytest cases in `packages/cadpy/tests/` MUST still pass
after Track A's changes. Track A's new tests
(`test_cadquery_generation.py`) are additive only.

---

## 2. Tauri IPC schema

### Scope

All IPC calls between the React viewer and the Tauri Rust shell. The schema
is duplicated as:

- **Rust side**: `desktop/src-tauri/src/ipc/types.rs` — `serde` structs
  with `#[derive(Serialize, Deserialize)]`
- **TypeScript side**: `viewer/src/client/lib/transport.ts` — interface
  declarations, plus a `tauri()` helper that picks `invoke()` on Tauri and
  `fetch()` on the browser dev server (fallback).

Both sides MUST stay in lockstep. The Rust struct is the source of truth;
TS is generated or hand-mirrored.

### Naming convention

- Commands: `snake_case`, namespaced by domain: `catalog_*`, `file_*`,
  `step_*`, `chat_*`, `printer_*`, `slice_*`, `project_*`, `app_*`.
- Events: `snake_case`, broadcast via Tauri's `emit()`; namespace mirrors
  commands.
- All commands return `Result<T, IpcError>` in Rust;
  `Promise<T>` (rejecting on error) in TS.

### Inherited (from viewer's HTTP routes)

These replace `viewer/src/server/server.mjs` 1:1.

```typescript
// app_info — replaces GET /__cad/server
interface AppInfo {
  rootPath: string;             // workspace root (data-dir/projects)
  appVersion: string;
  pid: number;
}
function app_info(): Promise<AppInfo>;

// catalog_read — replaces GET /__cad/catalog
//
// Scoped to the OPEN project: the scanner walks only the active project's
// dir (`<data-dir>/projects/<id>/`), set by project_open / project_create.
// So entry `file` paths are project-relative (bare, e.g. `model.step`,
// `parts/base.py`) and the rail never shows sibling projects or bundled
// resources. With no project open, returns `{ entries: [], rootPath: "" }`.
// file_read_bytes / file_reveal resolve these bare refs under the same dir.
interface CatalogEntry {
  file: string;                 // project-relative path (bare)
  kind: "step" | "stl" | "gcode" | "py" | "json" | "png";
  sourceKind: "python" | "static" | null;
  url: string;                  // tauri:// URI for fetching bytes
  artifact?: {
    stlUrl?: string;            // sibling .stl the viewer renders for a .step entry
    metadataUrl?: string;
  };
  relations?: Record<string, string>;
}
interface Catalog {
  entries: CatalogEntry[];
  rootPath: string;             // active project dir, or "" if none open
  revision: number;             // increments when scan finds changes
}
function catalog_read(): Promise<Catalog>;

// project_catalog_read — read a SPECIFIC project's files by id, WITHOUT
// changing the active project. Powers the sidebar's lazy per-project subtrees:
// expanding a non-active project loads its catalog here, leaving the active
// project (chat session + 3D viewer) untouched. Same scanner/shape as
// catalog_read but scoped to `<data-dir>/projects/<id>/`. `revision` is 0
// (non-active subtrees are display-only; selecting a file switches the active
// project, after which catalog_read takes over). Rejects ids that are not bare
// directory names (path traversal) with IpcError code "INVALID_PROJECT_ID".
function project_catalog_read(id: string): Promise<Catalog>;

// generation_status_read — replaces GET /__cad/generation-status
interface GenerationStatus {
  queue: Array<{ file: string; startedAt: number; kind: "step" }>;
  pythonAvailable: boolean;
  lastError?: { file: string; message: string; at: number };
}
function generation_status_read(): Promise<GenerationStatus>;

// file_read_bytes — read a project file's raw bytes (browser/hosted backends
// stream these over HTTP; desktop downloads use file_save instead).
type AssetKind = "output" | "source" | "artifact";
function file_read_bytes(file: string, asset: AssetKind): Promise<Uint8Array>;

// file_save — native "Save As" + local copy of a project file. Files already
// live on disk, so a desktop download is just a local-to-local copy: the
// command resolves the source under the open project (rejecting `..`), shows
// the OS save dialog, and copies the bytes. Resolves to the chosen destination
// path, or null if the user cancelled.
function file_save(file: string, asset: AssetKind): Promise<string | null>;

// file_reveal — replaces POST /__cad/reveal
function file_reveal(file: string, asset: AssetKind): Promise<void>;

// step_source_status_read — replaces GET /__cad/step-source-status
interface StepSourceStatus {
  hasSource: boolean;
  sourcePath?: string;
  sourceKind?: "python";
}
function step_source_status_read(file: string): Promise<StepSourceStatus>;

// step_artifact_regenerate — replaces POST /__cad/step-artifact
function step_artifact_regenerate(file: string, force: boolean): Promise<void>;
```

### New Panda commands

#### Chat (drives the host `claude` CLI)

```typescript
interface StartTurnRequest {
  projectId: string;
  userMessage: string;
}
interface StartTurnResponse { turnId: string; }
function chat_start_turn(req: StartTurnRequest): Promise<StartTurnResponse>;

function chat_cancel_turn(turnId: string): Promise<void>;

interface ChatSessionState {
  sessionId: string;
  turnInProgress: boolean;
  history: Array<{ role: "user" | "assistant"; content: string; at: number }>;
}
function chat_session_state(projectId: string): Promise<ChatSessionState>;

// Events emitted while a turn is in flight (see Events section below)
// - "chat_event" with payload ChatEvent
```

#### Slicer

```typescript
interface SliceRequest {
  meshFile: string;             // workspace-relative .stl/.3mf
  printerId: string;
  filament: "PLA" | "PETG" | "TPU";
}
interface SliceStats {
  durationSeconds: number;      // estimated print time
  filamentGrams: number;
  filamentMeters: number;
  layerCount: number;
  supportsUsed: boolean;
  gcodeFile: string;            // workspace-relative .gcode
}
function slice_run(req: SliceRequest): Promise<SliceStats>;

interface SliceStatus {
  inFlight: boolean;
  stage?: "preparing" | "slicing" | "writing";
  progress?: number;            // 0..1
}
function slice_status(): Promise<SliceStatus>;
```

#### Printer (Bambu)

```typescript
interface PrinterCard {
  id: string;                   // serial-derived
  model: string;                // "X1C", "P1S", "A1", …
  ipAddress: string;
  hostName: string;
}
function printer_discover(): Promise<PrinterCard[]>;

interface AddPrinterRequest {
  ipAddress: string;
  accessCode: string;
  serial?: string;              // optional override; else pulled from TLS cert
}
function printer_add(req: AddPrinterRequest): Promise<PrinterCard>;

function printer_list(): Promise<PrinterCard[]>;

interface PrinterStatus {
  online: boolean;
  state: "idle" | "printing" | "paused" | "error";
  job?: { name: string; progress: number; etaSeconds: number };
}
function printer_status(printerId: string): Promise<PrinterStatus>;

interface UploadGcodeRequest {
  printerId: string;
  gcodeFile: string;            // workspace-relative
  remoteName?: string;          // defaults to basename
}
function printer_upload_gcode(req: UploadGcodeRequest): Promise<void>;

interface StartPrintRequest {
  printerId: string;
  remoteName: string;           // already-uploaded G-code on the printer
  confirmed: true;              // explicit consumer-facing confirm — see plan
}
function printer_start_print(req: StartPrintRequest): Promise<void>;
```

#### Projects

```typescript
interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  hasModel: boolean;
}
function project_list(): Promise<ProjectSummary[]>;

interface CreateProjectRequest { name: string; }
function project_create(req: CreateProjectRequest): Promise<ProjectSummary>;

function project_open(id: string): Promise<{ workspaceRoot: string }>;

// project_rename — set a user-chosen display name. Writes `name` to the
// project's `project.json`, preserving `createdAt` and bumping `updatedAt`;
// returns the updated summary. Rejects an empty/whitespace name
// (INVALID_ARGUMENT) and a missing project (PROJECT_NOT_FOUND). A user name is
// never the placeholder, so the AI-title self-heal below no longer fires once a
// project has been renamed.
function project_rename(id: string, name: string): Promise<ProjectSummary>;

function project_delete(id: string): Promise<void>;
```

**Naming.** New projects are created with a placeholder (`"New project"`) and the
UI does not prompt for a name up front. While a project still carries the
placeholder (or an empty name), `project_list` self-heals: `read_project_summary`
reads the latest `ai-title` line Claude Code wrote to that project's session JSONL
(`~/.claude/projects/<encode_cwd>/<session_id>.jsonl`) and persists it back to
`project.json`, so the display name upgrades from `"New project"` to Claude's
AI-generated title on the first list refresh after a title exists. The user can
override this at any time via `project_rename` (sidebar inline edit); once a
non-placeholder name is set, the self-heal stops touching it.

#### App

```typescript
interface PrereqCheck {
  claudeCli: { found: boolean; version?: string };
  python: { found: boolean };
  slicer: { found: boolean; binaryPath: string };
}
function app_prereq_check(): Promise<PrereqCheck>;

interface AppSettings {
  defaultFilament: "PLA" | "PETG" | "TPU";
  slicerBinaryPath: string;     // empty = bundled
  usePandaCloud: boolean;       // v2 hook; default false
  pandaToken?: string;          // v2 hook
  hasOnboarded: boolean;        // gates the first-run wizard (added during Track E merge)
  autoUpdate: boolean;          // false (default) = prompt before downloading an update;
                                //   true = silently download in the background, notify to restart
}
function app_settings_read(): Promise<AppSettings>;
function app_settings_write(s: AppSettings): Promise<void>;

// Track I — auto-install Claude Code from the first-run wizard.
//
// Fetches Anthropic's official installer over HTTPS, runs it through
// /bin/sh, then re-runs the same detection used by app_prereq_check.
// Resolves with the post-install version + binary path; rejects with
// one of:
//   - "PLATFORM_UNSUPPORTED"      — Windows (upstream installer rejects it)
//   - "INSTALLER_INSECURE_URL"    — script URL was not https://
//   - "INSTALLER_FETCH_FAILED"    — network or non-2xx response
//   - "INSTALLER_TOO_LARGE"       — body exceeded the 100 KB cap
//   - "INSTALL_FAILED"            — installer subprocess exited non-zero
//                                   (detail: { exitCode, stderrTail })
//   - "INSTALL_VERIFIED_MISSING"  — installer exited cleanly but no
//                                   claude binary appeared on PATH
interface InstalledClaude {
  version: string;
  binaryPath: string;
}
function app_install_claude_code(): Promise<InstalledClaude>;

// Auto-update (tauri-plugin-updater). Event-driven: all three commands emit
// "update_event" (below). update_check is check-only; the UI calls it on
// mount (Tauri events aren't buffered) and to offer "check now". update_install
// downloads + stages the bundle but does NOT relaunch — update_relaunch applies
// it. The startup flow honors AppSettings.autoUpdate (silent download when on).
interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes?: string;
  date?: string;
}
function update_check(): Promise<UpdateInfo | null>;  // null = up to date
function update_install(): Promise<void>;              // emits downloading… → ready
function update_relaunch(): Promise<void>;             // never returns (restarts)
```

### Events (Tauri `emit`)

```typescript
// "chat_event" — driven by the Claude CLI subprocess's stream-json
type ChatEvent =
  | { kind: "turn_start"; turnId: string }
  | { kind: "text_delta"; turnId: string; text: string }
  | { kind: "thinking_delta"; turnId: string; text: string }
  | { kind: "tool_use_start"; turnId: string; tool: string; input: unknown }
  | { kind: "tool_use_end"; turnId: string; tool: string; ok: boolean }
  | { kind: "artifact_changed"; turnId: string; file: string; reason: "new" | "modified" }
  | { kind: "turn_end"; turnId: string }
  | { kind: "error"; turnId: string; message: string };

// "catalog_changed" — fires when the Rust catalog scanner notices new/modified files
interface CatalogChangedEvent { revision: number; }

// "slice_progress" — fires during slice_run
interface SliceProgressEvent { stage: string; progress: number; }

// "print_progress" — fires when polling printer_status returns a delta
interface PrintProgressEvent { printerId: string; state: string; progress: number; }

// "claude_install_progress" — streams during app_install_claude_code.
// Driven by the upstream installer's stdout/stderr; tag is the
// snake_case stage name. Stages may repeat (e.g., the bootstrap script
// downloads then re-downloads the release tarball).
type ClaudeInstallProgress =
  | { stage: "downloading"; receivedBytes?: number; totalBytes?: number }
  | { stage: "running" }
  | { stage: "verifying" }
  | { stage: "done"; version: string; binaryPath: string }
  | { stage: "error"; message: string };

// "update_event" — streams across the whole auto-update lifecycle. Drives
// every update surface in the UI: the "update available" prompt + passive
// badge ("available"), the download progress bar ("downloading"), and the
// "restart to apply" banner ("ready"). The "available" variant flattens
// UpdateInfo (serde internally-tagged newtype variant).
type UpdateEvent =
  | { status: "checking" }
  | { status: "up_to_date" }
  | ({ status: "available" } & UpdateInfo)
  | { status: "downloading"; downloadedBytes: number; totalBytes?: number }
  | { status: "ready"; version: string }
  | { status: "error"; message: string };
```

### Error shape

```typescript
interface IpcError {
  code: string;                 // e.g., "PRINTER_OFFLINE", "PYTHON_MISSING"
  message: string;              // human-readable
  detail?: unknown;             // optional structured detail
}
```

---

## 3. Skill stdout + artifact contract

### Scope

How the `cadcode` skill communicates results to the Tauri Rust driver, and
which files in the workspace dir count as "agent-produced artifacts" for
the driver's mtime snapshotter.

### Skill invocation

```bash
python -m cad <project_dir> [--out-dir <dir>] [--mesh-tolerance <mm>] \
  [--angular-tolerance <deg>] [--wall-clock-s <s>]
```

The skill is shipped as a Python package at `skills/cadcode/scripts/` and
invoked via `python -m cad` after the cadcode skill installs its
`scripts/` parent dir onto `PYTHONPATH`. (Internal detail; the Rust driver
doesn't invoke this directly — the `claude` CLI does, as a tool call.)

### Stdout: single JSON line

The skill MUST print **exactly one** JSON line to stdout containing the
result. Stderr is for human-readable logs and warnings.

```typescript
interface CadcodeResult {
  ok: boolean;

  // Always present on success:
  step_path?: string;           // workspace-relative
  stl_path?: string;            // always written (printable + preview mesh)
  metadata_path?: string;       // <stem>.step.json

  // Geometry facts (success):
  is_solid?: boolean;
  volume_mm3?: number;
  bbox?: { min: [number, number, number]; max: [number, number, number] };

  // On failure:
  error?: {
    code: string;               // "VALIDATION_FAILED", "SANDBOX_TIMEOUT", "EXPORT_ERROR", "SYNTAX_ERROR", "RUNTIME_ERROR"
    message: string;
    traceback?: string;
  };
}
```

The Tauri driver's `check` variant (mtime-clean inspection) re-uses this
schema but with `step_path`/`stl_path`/etc. omitted (results from a
tempdir).

### Artifact files written per turn

The cadcode skill writes these into `<out-dir>` (defaults to the project
dir):

| Extension | Source | Always? |
|---|---|---|
| `.step` | cadpy STEP export with XCAF labels | yes (on success) |
| `.stl` | cadpy mesh export (printable + viewer preview) | yes (on success) |
| `.step.json` | cadpy metadata (source hash, generator, validation) | yes (on success) |
| `.py` (any) | the agent's `gen_step()` source | written by the agent's `Write` tool, not by the skill itself |

### mtime snapshot watchlist

The Rust driver (`desktop/src-tauri/src/commands/claude_driver.rs`)
snapshots all files in the per-session workspace dir before each turn and
diffs after. A file counts as an "artifact event" if:

1. Its extension is one of: `.step .stp .stl .3mf .gcode .png .py
   .json` (lowercase, case-sensitive)
2. AND it was created, OR its mtime moved forward by ≥ 1 second.

Snapshot must be recursive into subdirectories (projects can have `parts/`,
`features/`, etc).

For each artifact event, the driver emits a `chat_event`:

```typescript
{
  kind: "artifact_changed",
  turnId: <currentTurnId>,
  file: <workspace-relative path>,
  reason: <"new" | "modified">
}
```

### Workspace dir layout

```
~/Library/Application Support/Panda/projects/<projectId>/
├── main.py                  ← agent-written, gen_step() entry
├── params.py                ← agent-written, all dimensions
├── parts/                   ← optional, agent-written
│   ├── __init__.py
│   ├── base.py
│   └── lid.py
├── features/                ← optional
├── assemblies/              ← optional
├── model.step               ← cadpy STEP
├── model.step.json          ← cadpy metadata
├── model.stl                ← cadpy mesh (slice-input + viewer preview)
├── model.gcode              ← OrcaSlicer output
└── chat.jsonl               ← Panda-managed chat history (one event per line)
```

The Rust catalog scanner (`commands/catalog.rs`) builds the `CatalogEntry`
records by mapping the above naming convention to entries; the React
viewer reads the catalog via `catalog_read()`.

### Sandboxing (carried over from cadcode skill)

The cadcode skill runs `gen_step()` in a sandboxed subprocess with:

- `RLIMIT_AS` ≤ 1 GiB
- `RLIMIT_CPU` ≤ 20 s
- `RLIMIT_NOFILE` ≤ 64
- Import allow-list (no `os`, `subprocess`, `urllib`, …)

The artifact files appear in the workspace only after the sandbox exits
cleanly. A failed sandbox writes nothing — the driver sees no
`artifact_changed` events, just the JSON error result on stdout.

---

## Contract change discipline

If you find a real reason to change one of these contracts during
implementation:

1. Open a discussion in `panda/docs/panda-interfaces-CHANGES.md` (not yet
   created — add one when needed).
2. Note which tracks are affected.
3. Land the change on `main` BEFORE the affected tracks merge so worktrees
   can rebase.

Contracts are frozen, not immutable — but every change costs coordination.
