# Panda — Frozen Interface Contracts

Three contracts that all parallel implementation tracks must code against.
Frozen for v1.0; any change here requires re-coordination across tracks.

Document version: **v1.0-post-merge** (2026-05-28).

Changes since pre-flight:
- AppSettings gained `hasOnboarded: boolean` (Track E; mirrored in Rust as `has_onboarded`)
- AppSettings gained `defaultPrinterId?: string` — the user's preferred print device (a `PrinterCard.id`); the Print action targets it when still paired, else auto-picks (mirrored in Rust as `default_printer_id`)
- §1 documents the concrete `generate_step()` signature now that Track A's follow-up wrapper has landed
- §2 added `app_install_claude_code()` + `claude_install_progress` event for Track I (one-click Claude Code install from the first-run wizard)
- §2 added `app_install_orcaslicer()` + `slicer_install_progress` event (one-click OrcaSlicer install from the first-run wizard, step 2 of 4); `app_prereq_check().slicer` now resolves via the same probe the slice path uses

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

    # Optional (additive): project-declared warnings merged into
    # validation.warnings alongside the deterministic geometry checks. Each:
    # {"part", "kind", "detail", "severity"} (kind defaults vary; part→"model",
    # severity→"warning"). Used for kind:"functional" assembly-feasibility checks.
    "warnings":              list[dict],
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
| `<stem>.stl` | yes | Printable mesh + the viewer's preview mesh (assembled scene) |
| `<stem>.step.json` | yes | Source hash, generator metadata, validation summary |
| `<stem>_parts/<part>.stl` | assemblies only | One STL per named part, at its own build origin (review/print individually) |

`<stem>` is the basename of `output_path`. The driver's mtime snapshotter
(contract §3) watches all three extensions.

**Per-part STLs (additive).** When `gen_step()` returns an assembly with more
than one leaf part, the wrapper also writes one STL per named part under
`<stem>_parts/`, each in its own build frame (not assembled position) so it can
be reviewed and printed individually. The `<stem>.step.json` gains a `parts`
array — `[{ "name": str, "stlPath": "<stem>_parts/<part>.stl" }]`, with
`stlPath` relative to the sidecar's directory — and `generate_step()`'s return
dict gains `parts: [{ "name", "stl_path" }]`. Single-solid projects omit both
(no `_parts/` dir). The Tauri catalog surfaces these on the integrated `.stl`
entry's `artifact.parts` (contract §2); the viewer groups them under the model.

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
  url: string;                  // pandaasset:// URI for fetching bytes (served as
                                // `http://pandaasset.localhost/...` on Windows — Tauri's
                                // per-platform custom-scheme form). Renderable mesh URLs
                                // (the `.stl` entry + `stlUrl` below) carry an opaque
                                // `?v=<mtime>-<size>` cache-bust token so a regenerated,
                                // same-path mesh re-renders (the protocol resolves by
                                // path, ignoring the query).
  artifact?: {
    stlUrl?: string;            // sibling .stl the viewer renders for a .step entry
    metadataUrl?: string;
    parts?: {                   // assemblies only: per-part STLs (contract §1),
      name: string;             //   attached to the integrated .stl entry. The
      file: string;             //   per-part files themselves are hidden from the
      url: string;              //   flat list; the viewer nests them under the model.
    }[];
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

// file_import — native "Open" dialog that imports user-chosen mesh files into
// the open project. Everything is normalized to `.stl` (the render/slice
// pipeline's native format): `.stl` is copied as-is; `.glb`/`.gltf` is converted
// to `.stl` via the bundled CPython's trimesh (OrcaSlicer can't slice GLB).
// Destination names are de-duplicated so an import never overwrites an existing
// model; the catalog revision is bumped on success. Resolves to the imported
// workspace-relative paths (e.g. ["dragon.stl"]), or [] if the user cancelled.
function file_import(): Promise<string[]>;

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
interface ImageAttachment {
  name?: string;        // original filename, display-only (never used as a path)
  mediaType: string;    // "image/png" | "image/jpeg" | "image/webp" | "image/gif"
  dataBase64: string;   // raw file bytes, base64-encoded (no "data:" prefix)
}
interface StartTurnRequest {
  projectId: string;
  userMessage: string;
  // Optional reference images. The handler persists each into the project's
  // `inputs/` dir (before the mtime baseline, so no artifact_changed fires) and
  // appends a note pointing the model at them; it views them with its Read tool.
  // Additive + optional — absent for text-only turns. Added 2026-06-05; see
  // panda-interfaces-CHANGES.md.
  images?: ImageAttachment[];
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
  gcode3mfFile?: string;        // sliced .gcode.3mf (cloud upload artifact); absent if not produced
  validation?: SliceValidation; // static analysis of the produced gcode; absent if it couldn't be read
  slicerWarnings?: string[];    // OrcaSlicer's own model warnings on a successful slice
                                // (floating regions / unsupported overhangs — "re-orient or
                                // enable supports"); empty/absent when the slicer reported none
}
// Static G-code analysis. Advisory/non-fatal: a slice
// succeeds even when `ok` is false. `ok` reflects structural integrity only
// (non-empty + has movement + has extrusion); bed-bounds, missing-temperature,
// and unrecognized-command findings ride in `warnings` (Bambu firmware
// legitimately moves outside the printable area for purge/wipe).
interface SliceValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  movementCommands: number;
  extrusionMoves: number;
  temperatureCommands: number;
}
// slice_run pre-screens the mesh before invoking OrcaSlicer, rejecting
// unsliceable inputs with a clear code:
//   MESH_UNSUPPORTED — non-mesh (.step/.dxf/…), or a mesh format this flow
//                      doesn't convert (.ply/.glb/.gltf)
//   ALREADY_SLICED   — a .3mf that is already a sliced plate (carries
//                      Metadata/plate_*.gcode), to avoid re-slicing it
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
// "bambustudio" is not a network printer — it hands the model off to the
// locally installed Bambu Studio app (printer_open_in_studio).
type PrinterTransport = "lan" | "cloud" | "bambustudio";
interface PrinterCard {
  id: string;                   // serial-derived (dev_id for cloud)
  model: string;                // "X1C", "P1S", "A1", …
  transport: PrinterTransport;  // how Panda reaches it
  ipAddress?: string;           // LAN only — absent for cloud-only devices
  hostName: string;
  online?: boolean;             // cloud bind-list flag; absent for LAN
}
function printer_discover(): Promise<PrinterCard[]>;  // LAN (SSDP/mDNS)

interface AddPrinterRequest {
  ipAddress: string;
  accessCode: string;
  serial?: string;              // optional override; else pulled from TLS cert
}
function printer_add(req: AddPrinterRequest): Promise<PrinterCard>;

// Register the "Open with Bambu Studio" handoff (a pseudo-printer, fixed id
// "bambu-studio", transport "bambustudio"). No pairing or network setup.
function printer_add_studio(): Promise<PrinterCard>;

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

interface OpenInStudioRequest {
  file: string;                 // workspace-relative (catalog key) or absolute
}
// Hand a model/gcode file off to a locally installed slicer app. This is the
// action behind the "bambustudio" transport — no upload/start. Prefers Bambu
// Studio; when it isn't installed, falls back to OrcaSlicer (a standalone
// install or Panda's bundled sidecar). Errors SLICER_APP_NOT_FOUND only when
// neither is available in a standard location (SLICER_APP_OPEN_FAILED if the
// OS "open with" handoff fails).
function printer_open_in_studio(req: OpenInStudioRequest): Promise<void>;

// Which slicer app the open-in handoff would launch right now — drives the
// open-button label so it names the app that will actually open. Read-only.
type OpenTargetApp = "bambustudio" | "orcaslicer" | "none";
function printer_open_in_studio_target(): Promise<OpenTargetApp>;
```

`printer_status` / `printer_upload_gcode` / `printer_start_print` dispatch on
the stored record's `transport`: LAN uses FTPS + direct-to-IP MQTT; cloud
routes through the signed-in account (cloud MQTT + REST upload/print-job). The
cloud upload uploads the sliced `.gcode.3mf` (it auto-prefers the sibling 3mf
when handed a `.gcode`). A `"bambustudio"` record is not a network printer —
`printer_upload_gcode` / `printer_start_print` reject it (`PRINTER_IS_BAMBU_STUDIO`);
the Print button instead calls `printer_open_in_studio` with the model STL.

#### Cloud account (Bambu)

Account login is by **email + verification code**. One signed-in account →
many bound devices, which `printer_discover_cloud` upserts into the shared
printer list tagged `transport: "cloud"`. Tokens persist to `bambu-cloud.json`
(sensitive — never returned to JS), refreshed before expiry; a stale,
unrefreshable session surfaces `CLOUD_REAUTH_REQUIRED`.

```typescript
type CloudRegion = "global" | "china";   // v1 ships global
interface CloudLoginRequest { account: string; region?: CloudRegion; }
interface CloudLoginChallenge {
  kind: string;                 // "codeSent" | "success" | "needPassword" | "tfa"
  tfaKey?: string;
}
function cloud_login_request_code(req: CloudLoginRequest): Promise<CloudLoginChallenge>;

interface CloudLoginSubmit { account: string; code: string; }
interface CloudAccountStatus {
  signedIn: boolean;
  account?: string;
  region?: CloudRegion;
  expiresAt?: number;           // unix seconds (JWT exp)
  needsReauth: boolean;
}
function cloud_login_submit_code(req: CloudLoginSubmit, region?: CloudRegion): Promise<CloudAccountStatus>;
function cloud_account_status(): Promise<CloudAccountStatus>;
function cloud_logout(): Promise<void>;
function printer_discover_cloud(): Promise<PrinterCard[]>;
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

#### Snapshots (git-tag-style model save states)

```typescript
interface SnapshotSummary {
  id: string;
  label: string;
  createdAt: number; // epoch millis
}

interface SnapshotRestore {
  summary: SnapshotSummary;
  // True when the save captured the chat transcript and the live Claude session
  // was rewound to it; the UI then reloads the chat panel from the restored
  // conversation. False keeps the chat linear (an older save with no transcript).
  chatRewound: boolean;
}

// List a project's saved states, newest first.
function snapshot_list(projectId: string): Promise<SnapshotSummary[]>;

// Save the current model as a named checkpoint, capturing the model files AND
// the Claude session transcript. An empty/missing `label` falls back to
// `Version N`. Rejects a missing project (PROJECT_NOT_FOUND).
function snapshot_save(projectId: string, label?: string): Promise<SnapshotSummary>;

// Revert to a saved state: model files go back, and — when the save captured the
// transcript — the live Claude session is rewound to it too (chatRewound=true).
// The saved state is NOT consumed; it stays restorable. Rejects an unknown id
// (SNAPSHOT_NOT_FOUND).
function snapshot_restore(projectId: string, snapshotId: string): Promise<SnapshotRestore>;

// Delete a saved state (files + captured transcript + index entry). Idempotent.
function snapshot_delete(projectId: string, snapshotId: string): Promise<void>;
```

**Storage.** A snapshot copies a project's model-defining files (Python source +
generated artifacts — everything except `.panda`, `.claude`, `.git`,
`project.json`, and `inputs/`) into `<project>/.panda/snapshots/<id>/`, indexed
by `<project>/.panda/history.json`. It also captures the Claude session
transcript — which lives outside the project at
`~/.claude/projects/<encoded-cwd>/<session>.jsonl` — as a sibling
`<project>/.panda/snapshots/<id>.session.jsonl` (a sibling, not inside `<id>/`,
so `restore_scope` never lands it among the model files). `.panda/` is excluded
from catalog scans, so saves never surface as CAD parts.

**Rewind revert (same session, no fork).** Restore swaps the model files back
(stamping fresh mtimes so the viewer reloads — see the cache-bust note below),
then, if the save captured a transcript, overwrites the live session JSONL with
it: the conversation rewinds to the snapshot point and the next turn `--resume`s
from there (`chatRewound=true`). The frontend reloads the chat panel from the
restored transcript and ends it with a single "↩ Reverted to `<label>`" marker.
Messages after the snapshot are dropped from the live session — saving a state
before reverting keeps them. The deterministic per-project session id is reused
(the session is *not* forked to a new id — that was the removed option 2). Older
saves with no captured transcript fall back to the prior linear behavior
(`chatRewound=false`): model files revert, the chat stays put, and the driver
stashes a one-shot note the *next* `chat_start_turn` appends to the user message
so the model knows its files went back. See `docs/future-work-version-control.md`.

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
  slicerSettingsProfile?: string;   // OrcaSlicer --load-settings (machine;process), ;-joined paths; empty = default
  slicerFilamentProfile?: string;   // OrcaSlicer --load-filaments path; empty = none
  defaultPrinterId?: string;    // preferred print device (a PrinterCard.id); when paired the Print
                                //   action targets it, else auto-picks. empty = auto-pick
  usePandaCloud: boolean;       // v2 hook; default false
  pandaToken?: string;          // v2 hook
  hasOnboarded: boolean;        // gates the first-run wizard (added during Track E merge)
  autoUpdate: boolean;          // false (default) = prompt before downloading an update;
                                //   true = silently download in the background, notify to restart
}
function app_settings_read(): Promise<AppSettings>;
function app_settings_write(s: AppSettings): Promise<void>;

// Panda proxy sign-out: clears pandaToken + pandaBaseUrl and flips usePandaCloud
// off, so the next chat turn falls back to the user's own local Claude Code auth
// (the inverse of the app_panda_login sign-in). Idempotent. Returns the updated
// settings so the UI can reflect the new mode immediately.
function app_panda_logout(): Promise<AppSettings>;

// Track I — auto-install Claude Code from the first-run wizard.
//
// Fetches Anthropic's official installer over HTTPS, then runs it through
// /bin/sh (macOS + Linux) or PowerShell (Windows: install.ps1 via
// -ExecutionPolicy Bypass -File), then re-runs the same detection used by
// app_prereq_check. Resolves with the post-install version + binary path;
// rejects with one of:
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

// Auto-install OrcaSlicer from the first-run wizard (step 2 of 4).
//
// Downloads the pinned OrcaSlicer release (scripts/build/SLICER_VERSION.txt)
// from GitHub, installs it into a user-writable location
// (~/Applications/OrcaSlicer.app on macOS, ~/.local/bin/orcaslicer on Linux),
// then re-runs the same detection used by app_prereq_check. Resolves with the
// pinned version + resolved binary path; rejects with one of:
//   - "PLATFORM_UNSUPPORTED"      — Windows (portable zip has no installer)
//   - "INSTALLER_CLIENT_ERROR"    — could not build the HTTP client
//   - "INSTALLER_FETCH_FAILED"    — network or non-2xx response
//   - "INSTALL_FAILED"            — mount/copy/permission step failed
//   - "INSTALL_VERIFIED_MISSING"  — installer finished but no OrcaSlicer
//                                   binary was resolvable afterward
interface InstalledSlicer {
  version: string;
  binaryPath: string;
}
function app_install_orcaslicer(): Promise<InstalledSlicer>;

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
// Published version from the updater's latest.json feed, for the in-window
// About box. Persisted on disk so it survives an offline launch; falls back to
// the installed bundle version when the feed is unreachable and nothing cached.
function update_latest_version(): Promise<string>;
```

### Events (Tauri `emit`)

```typescript
// "chat_event" — driven by the Claude CLI subprocess's stream-json
type ChatEvent =
  | { kind: "turn_start"; turnId: string }
  | { kind: "text_delta"; turnId: string; text: string }
  | { kind: "thinking_delta"; turnId: string; text: string }
  | { kind: "tool_use_start"; turnId: string; tool: string; input: unknown }
  | { kind: "tool_use_end"; turnId: string; tool: string; ok: boolean; resultSummary?: string }
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

// "slicer_install_progress" — streams during app_install_orcaslicer.
// Downloading carries byte counts; extracting/installing cover the
// platform mount+copy (macOS) or AppImage drop (Linux).
type SlicerInstallProgress =
  | { stage: "downloading"; receivedBytes?: number; totalBytes?: number }
  | { stage: "extracting" }
  | { stage: "installing" }
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

  // Assemblies only (additive): one printable STL per named part, at build
  // origin. Absent/empty for single-solid projects. See contract §1.
  parts?: { name: string; stl_path: string }[];

  // Deterministic geometry sanity checks (additive; the `kind` set is open and
  // grows). Absent/empty when the geometry is clean. `ok` stays true — these are
  // advisory, not failures; the skill loop and the harness Review phase use them
  // as a fix gate. Blocking-geometry kinds ∈ { "disconnected_bodies", "sliver",
  // "invalid_brep", "empty", "check_failed" }. Aesthetic advisories carry
  // `severity:"info"` and never gate the geometry loop: "sharp_edges" (count of
  // un-softened convex arrises) seeds the harness's automatic aesthetic-polish
  // pass. Project-declared "functional" warnings (severity:"warning") flag
  // assembly/usability problems (the part is a valid solid but won't assemble/
  // work) and gate the harness's functional-review pass. `part` is the part name
  // (or "model" for single-part projects). Also mirrored into `.step.json` under
  // `validation.warnings`.
  warnings?: { part: string; kind: string; detail: string; severity: string }[];

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
├── model.step.json          ← cadpy metadata (+ parts[] for assemblies)
├── model.stl                ← cadpy mesh (slice-input + viewer preview)
├── model_parts/             ← assemblies only: one STL per named part
│   ├── base.stl
│   └── lid.stl
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
