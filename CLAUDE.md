# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Architecture at a glance

Panda is a consumer desktop app: chat → CAD → slice → print on a Bambu Lab printer. Four layers, all wired together through one frozen interface document.

- **`desktop/src-tauri/`** — Tauri 2 shell (Rust). Owns the OS process, ships a bundled CPython and bundled OrcaSlicer as Tauri sidecars (declared in `tauri.conf.json` → `bundle.externalBin`), and exposes everything to the frontend over IPC. `src/ipc/types.rs` is the source of truth for the IPC schema; `src/commands/*` implements each command (`chat`, `claude_driver`, `catalog`, `slicer`, `printer`, `project`, `app`, `step`, `files`).
- **`viewer/`** — Vite + React frontend (the chat surface + 3D viewer). `src/client/lib/transport.ts` mirrors the Rust IPC schema and provides a `tauri()` helper that picks `invoke()` inside Tauri and `fetch()` against the dev HTTP routes in the browser. `src/server/` contains the legacy HTTP routes (`/__cad/*`) being replaced 1:1 by Tauri IPC.
- **`packages/cadjs/`** — UI-framework-agnostic JS for CAD mesh parsing/rendering consumed by the viewer (Panda renders the `.stl`). Source of truth. `viewer/packages/cadjs/` is a **generated mirror** — never hand-edit.
- **`packages/cadpy/`** — Python CadQuery + cadquery-ocp pipeline that turns a `gen_step()` project into `.step` + `.stl` + `.step.json`. Source of truth. Vendored copies under skill runtimes (e.g. `skills/cadcode/scripts/packages/cadpy/`) are **generated mirrors** — never hand-edit.
- **`skills/`** — Claude Code skills bundled with the app (`cadcode`, `cad-viewer`, `step-parts`). Invoked by the `claude` CLI subprocess, not by the Rust driver directly. Each skill is self-contained at runtime — no cross-skill imports, no imports from repo root; shared helpers are vendored in via `scripts/build/build-skill-runtimes.sh`. The `skills/` tree ships as a Tauri `bundle.resources` entry and is installed into `~/.claude/skills/` on every app startup by `src/skills.rs` (`install_bundled_skills`), which is where the `claude` subprocess discovers them (and where the cadcode generator runs from: `python ~/.claude/skills/cadcode/scripts/cad`). The install is version-gated and **skips any skill dir that is a symlink** — symlink `~/.claude/skills/<name>` at the repo to live-edit a skill without the startup copy clobbering it. In dev (`cargo run`), the resource dir is empty so the installer falls back to the repo `skills/` tree.

### The contract document

**`docs/panda-interfaces.md` is frozen for v1 and is the contract every track codes against.** Before changing anything that crosses these layers, read it. Three sections:

1. `gen_step()` CadQuery contract — what a project's `main.py` may return, the artifacts written, face-ID stability rules. The shape is resolved in one entry point via duck-typing on `.wrapped` / `TopoDS_Shape`; do not add isinstance checks.
2. Tauri IPC schema — every `snake_case` command and `chat_event` / `catalog_changed` / `slice_progress` / `print_progress` / `claude_install_progress` event. Rust struct is the source of truth; TS in `viewer/src/client/lib/transport.ts` is hand-mirrored.
3. Skill stdout + artifact contract — `cadcode` skill must print exactly one JSON line to stdout; Rust driver mtime-snapshots `.step .stp .stl .3mf .gcode .png .py .json` (case-sensitive, recursive) to emit `artifact_changed` events.

### Data flow per chat turn

User message → `chat_start_turn` IPC → Rust `claude_driver` spawns the host `claude` CLI as a subprocess with stream-json → CLI invokes the `cadcode` skill as a tool call → skill runs sandboxed (`RLIMIT_AS` 1 GiB, `RLIMIT_CPU` 20s, import allow-list), calls `cadpy.generation.generate_step()`, writes artifacts and emits one JSON-line result → driver's mtime snapshotter diffs the workspace and fires `artifact_changed` events → viewer reacts via the `chat_event` Tauri event stream and reloads via `catalog_read()`.

### Two-phase chat: plan → approve → build

A turn runs in one of two phases, selected by Claude Code's own `--permission-mode` (see `TurnPhase` in `commands/claude_driver.rs`):

- **Plan** (`chat_start_turn` → `--permission-mode plan`): the model designs read-only (writes are CLI-blocked), asks preference questions via a fenced ` ```panda-questions ` JSON block, and ends by calling the built-in `ExitPlanMode` tool. The driver intercepts that tool call in `from_assistant`, emits a `PlanProposed { plan }` event, and kills the child to end the turn deterministically (headless `-p` plan mode does not need it, but it's robust either way).
- **Build** (`chat_approve_plan` → `--permission-mode bypassPermissions`): resumes the **same** session with the approved (possibly edited) plan; `cadcode` now writes source and generates artifacts. `bypassPermissions` (not `acceptEdits`) is required: the build runs unattended in headless `-p` mode, and the cadcode generator is a Bash command (`python …/cad <file>`) that `acceptEdits` would still prompt for — blocking artifact generation. `chat_request_plan_changes` stays in plan mode with feedback.

After a build, the driver runs an automatic, silent **Review** phase (`TurnPhase::Review`, also `bypassPermissions`) *inside* the same build turn — it is never started from the chat layer and rides under the `Implement` wire tag. cadpy writes deterministic geometry warnings (floating/`disconnected_bodies`, slivers, invalid B-reps) into each `.step.json` under `validation.warnings`; `run_review_fix_loop` reads them and, while any remain, resumes the session to render-inspect-fix (the model runs `skills/cadcode/scripts/review` to get per-part PNGs). It loops up to `MAX_REVIEW_ROUNDS`, suppresses the review's chat (forwarding only `artifact_changed`), and leaves one note only if it can't converge. Best-effort: a review failure never fails the build.

Session continuity across phases is free: `session_id_for_project()` is a deterministic per-project UUID, so every phase `--resume`s the same Claude session (planning context carries into the build). `--permission-mode` is per-invocation and orthogonal to `--resume`. Frontend mirrors this with a `plan` chat block + `awaitingApproval` state in `store/chat.js`; question chips are parsed from the fence by `Markdown.jsx`'s custom code renderer.

## Common commands

Run only the checks relevant to the change (see AGENTS.md). Three independent gates:

```bash
# cadpy (Python pipeline)
cd packages/cadpy && python -m pytest
# single test:
cd packages/cadpy && python -m pytest tests/test_cadquery_generation.py::test_name

# cadjs + viewer (JS / React)
npm --prefix viewer test
npm --prefix viewer run build
# single test (the runner accepts paths):
node viewer/scripts/run-tests.mjs viewer/src/server/localAssetBackend.test.mjs

# Tauri (Rust shell + IPC)
cargo --manifest-path desktop/src-tauri/Cargo.toml test
# single test:
cargo --manifest-path desktop/src-tauri/Cargo.toml test <test_name>
```

Dev / build:

```bash
# Run the full app in dev mode (starts Vite + the Tauri shell, wired together).
# Use this script, not raw `cargo run`: the Tauri CLI is not a project dep, so
# nothing auto-starts Vite, and the viewer's default port (4178) does not match
# the shell's devUrl (5173). dev.sh starts Vite on the devUrl port, waits for it,
# then runs the app, and stops Vite on exit.
scripts/dev.sh
PANDA_DEVTOOLS=1 scripts/dev.sh            # dock the webview inspector

# Just the Rust shell (assumes Vite is already serving on the devUrl port).
# Flag order matters — this cargo rejects `cargo --manifest-path ... run`.
cargo run --manifest-path desktop/src-tauri/Cargo.toml

# Viewer in isolation (browser, no Tauri)
npm --prefix viewer run dev

# Production app bundle (requires sidecars built first; see below).
# Use this script, not raw `cargo tauri build` — it adds the freshness guard.
scripts/build/build-app.sh                 # release
scripts/build/build-app.sh --debug         # debug bundle, faster
```

Generated-mirror sync (run after editing the source-of-truth packages):

```bash
# Refresh viewer/packages/cadjs/ from packages/cadjs/
scripts/build/build-viewer-packages.sh
scripts/build/build-viewer-packages.sh --check   # CI-style staleness check

# Vendor packages/cadpy/ into skill runtimes
scripts/build/build-skill-runtimes.sh
```

Sidecars (only needed for a packaged build; idempotent, ~1 GB on first download):

```bash
scripts/build/build-all-sidecars.sh           # python + slicer
scripts/build/build-all-sidecars.sh --force   # rebuild both
```

## Conventions worth knowing

- **Out of scope for v1:** URDF / SRDF / SDF (robotics), SendCutSend, non-Bambu printers. Donor code paths for these still exist but aren't exercised; don't add features there.
- **Errors raised by `cadpy.generation.generate_step()`** must subclass `cadpy.generation.GenerationError`. The skill runner catches these, prints a JSON error line, and exits 1.
- **Face IDs** come from `TopExp.MapShapes_s(shape.wrapped, TopAbs_*)` — never from CadQuery tags or selectors — so a given CadQuery shape yields deterministic ordinals.
- **IPC errors** are `IpcError { code, message, detail? }`. Codes are uppercase snake (`PRINTER_OFFLINE`, `PYTHON_MISSING`, `INSTALL_FAILED`, …).
- **Bundle-freshness footgun:** `tauri::generate_context!()` bakes `viewer/dist/` into the Rust binary at compile time. Rebuilding only `viewer/dist/` without re-running `cargo tauri build` ships an `.app` whose embedded JS is the old version — every IPC call silently falls through to the browser HTTP stub. `scripts/build/verify-bundle-fresh.sh` (wired in as `afterBundleCommand`) catches this; always go through `scripts/build/build-app.sh`.
- **Launch-PATH footgun:** a `.app` started from Finder/Dock/`open` inherits launchd's minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), **not** the user's shell PATH — so `claude` (typically `~/.local/bin`) and the `node` it needs are invisible, and a turn hangs with no response. The driver therefore resolves the binary via `augmented_path()` / `resolve_claude()` (which prepend the usual user/Homebrew bin dirs) and passes that PATH to the child. Never assume the inherited PATH; symptoms when this regresses are a stuck spinner with no assistant turn and no `~/.claude/projects/<encoded-workspace>/<uuid>.jsonl` ever created. Running the bundled binary directly from a terminal masks the bug (it inherits your shell PATH).
- **Session-dir encoding footgun:** `encode_cwd()` must replace **every** non-alphanumeric char with `-` (matching Claude Code's `cwd.replace(/[^a-zA-Z0-9]/g, '-')`), not just `/`. The packaged app's workspaces live under `~/Library/Application Support/app.panda.desktop/projects/<uuid>` — spaces and dots included — so a `/`-only encoding mismatches the real session dir, `claude_session_exists()` returns false, the driver passes `--session-id` for an existing session, and claude dies with "Session ID already in use" (turn produces nothing → chat stuck on "PLANNING"). Dev/repo paths have no spaces/dots so this only bites the bundled app.
- **Dev-server footgun:** there is no `cargo tauri dev` here — the Tauri CLI is not a project dependency, and the Rust shell does not spawn Vite. Plain `cargo run` only launches the binary, which loads `build.devUrl` (`http://localhost:5173`) in debug; if nothing serves that URL the window comes up blank. Worse, the viewer's own default is port **4178** (`DEFAULT_VIEWER_PORT`, `strictPort`), so `npm --prefix viewer run dev` alone serves the wrong port for the shell. `scripts/dev.sh` is the fix: it reads the port from `devUrl`, starts Vite there via `VIEWER_PORT`, waits for it, then runs the app. Use it instead of starting the two halves by hand.
- **Devtools** do not auto-open; set `PANDA_DEVTOOLS=1` (env var, must run the binary directly — `open` won't propagate it) to dock the inspector.
