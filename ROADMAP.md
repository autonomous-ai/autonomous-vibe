# Panda Roadmap

Goal: **ship v1 fast** — the shortest credible path to a shippable v1 beta of
"prompt to print." Check items off as they land; defer everything not on the
critical path.

> Status legend: `[ ]` todo · `[~]` in progress · `[x]` done

## Where things stand

Panda is **essentially v1 feature-complete in code.** The four layers (Tauri Rust
shell, React viewer, `cadpy` Python pipeline, bundled skills) are wired through the
frozen contract in `docs/panda-interfaces.md`, and the end-to-end chat turn
(message → `claude` subprocess → `cadcode` skill → artifacts → viewer reload)
works. The gap to a shippable v1 is **not feature work** — it's **real-hardware
validation + a few visible gaps + release hardening.**

| Layer / area | Status |
|---|---|
| Chat engine (plan→build→review, session continuity) | ✅ Done |
| `cadpy` generation (STEP/STL, assemblies, validation) | ✅ Done |
| Catalog / project CRUD / files / app settings | ✅ Done |
| Onboarding wizard (install / login / printer / filament) | ✅ Done |
| Slice (bundled OrcaSlicer headless CLI) | ⚠️ Coded, unvalidated on real slicer |
| Print (Bambu LAN: discover / upload / start / status) | ⚠️ Coded, unvalidated on real printer |
| `step_artifact_regenerate` | ❌ Stub (no-op), but UI-reachable |
| Release hardening (risky `.expect`s on hot paths) | ⚠️ A few |
| Version control / Linux / Panda Cloud | ⛔ Deferred (post-v1) |

## Slicing engine — decision (locked)

**Keep OrcaSlicer, bundled as a headless CLI sidecar. No engine swap.**

"One app, prompt to print; users only ever use Panda" is *already how it's built*:
OrcaSlicer ships *inside* Panda as a Tauri sidecar (`tauri.conf.json` →
`externalBin: "resources/slicer/orcaslicer"`, packed by
`scripts/build/build-slicer-sidecar.sh`, resolved bundled-first in `slicer.rs`).
The user never installs, opens, or sees it — Panda spawns it headlessly and parses
the resulting G-code.

OrcaSlicer is the right engine because it's the **only** one with first-class
**Bambu Lab profiles + correct gcode flavor / start-end gcode** → correct, safe
output on real hardware with **zero profile maintenance** on our side. CuraEngine /
PrusaSlicer would force us to author and forever maintain Bambu definitions, for no
licensing benefit (all are AGPL-3.0). The only cost is bundle size (~482 MB on
macOS) — an *optional, post-v1* slim-down, not a v1 blocker.

AGPL hygiene: slicer stays a separate executable invoked over a process boundary
(a sidecar), never statically linked; bundle the clean AGPL slicer, avoid Bambu's
proprietary networking blob. (Legal sign-off before GA — not legal advice.)

---

## Phase 0 — Reconcile & de-risk (≈0.5 day)

- [ ] Fix the stale stub-era header comments in `printer.rs` / `slicer.rs` ("Track G
      replaces the canned stub") — they describe past work, not current reality, and
      mislead readers into thinking these are stubs.
- [ ] Triage the unmerged in-flight branches and decide v1 fate (see Phase 2):
      `feat/sidebar-project-tree`, `fix/restore-chat-history-on-restart`.
      (`feature/chat-resize-coordination` is already merged.)
- [ ] Establish a green baseline on all three CI gates (see Verification).

## Phase 1 — Validate slice → print on real hardware (CRITICAL PATH)

The one thing that can't be faked — the gate between "demo" and "ship."

**Slice** (`commands/slicer.rs`, bundled OrcaSlicer headless CLI — engine locked):
- [ ] Run a real generated STL through the bundled OrcaSlicer sidecar end-to-end.
- [ ] Verify binary resolution (configured → bundled → PATH).
- [ ] Verify the arg set (`--orient`, `--outputdir`, `--filament-profile`, `--slice`).
- [ ] Verify the `slice_progress` event sequence and freshest-`.gcode` selection.
- [ ] **Confirm G-code header stat parsing** against *actual* OrcaSlicer output
      (duration / filament mass+length / layer count / supports) — the regexes are
      the highest-risk untested code.
- [ ] Keep OrcaSlicer pinned **≥ 2.3.2** in `scripts/build/SLICER_VERSION.txt`
      (earlier CLI has a `--slice`/export NULL-plater segfault).
- [ ] **Ship native Bambu machine + process profiles** and pass them via
      `--load-settings` / `--load-filaments` keyed off the connected printer model,
      instead of relying on generic defaults (`slicer.rs:380` currently only passes
      `--filament-profile "Generic …"` and ignores `printer_id`). This is the main
      slice-side quality work for v1.

**Print** (`commands/printer.rs`), against a real Bambu printer on LAN:
- [ ] Discovery (SSDP ports 1990/2021 + mDNS).
- [ ] `printer_add` (serial from TLS cert CN) and access-code persistence in
      `bambu-printers.json`.
- [ ] `printer_status` (MQTT report parsing).
- [ ] `printer_upload_gcode` (FTPS :990 → `/cache/`).
- [ ] `printer_start_print` (MQTT publish), auth = `bblp` + access code.

**Harness:**
- [ ] Build sidecars first (`scripts/build/build-all-sidecars.sh`) and test from a
      **packaged `.app`**, not `cargo run` — the launch-PATH and session-dir-encoding
      footguns (see CLAUDE.md) only bite the bundle.

**Exit criterion:**
- [ ] A part designed in chat physically prints, driven entirely through the app UI.

## Phase 2 — Close visible v1 gaps (≈2–4 days, parallelizable)

- [ ] **`step_artifact_regenerate` stub** (`commands/step.rs:69`): UI-reachable
      ("Regenerate STEP artifacts" → `cadCatalogBackendTauri.js:106`) but a no-op.
      Pick one:
  - [ ] *(Recommended for ship-fast)* Hide/disable the regenerate affordance for v1
        (chat-driven regeneration already covers the real workflow).
  - [ ] *(Alt)* Wire it for real via `python …/cad <file>` through the bundled-CPython
        path the chat driver already uses (mirror `claude_driver`'s sidecar resolution).
- [ ] **Harden hot-path `.expect()`s** into propagated `IpcError`s, prioritizing
      first-run / unattended paths: `project.rs` `expect("HOME is set")`, `app.rs`
      `expect("stdout/stderr piped")`. (Most other `.expect`s are in tests — fine.)
- [ ] Land `fix/restore-chat-history-on-restart` (clear UX win).
- [ ] Decide on `feat/sidebar-project-tree` — ship only if stable, else cut from v1.
- [ ] Smoke the full chat → CAD → slice → print loop on each release target
      (macOS arm64, macOS x64, Windows x64).

## Phase 3 — Beta release (≈1–2 days)

- [ ] Tag a `v0.1.x` beta; release pipeline (`.github/workflows/release.yml`) handles
      signing/notarization + `latest.json` for auto-update.
- [ ] Verify the auto-update path works from a prior installed build (gated by
      `AppSettings.autoUpdate`).
- [ ] Add a clear error-surface (and ideally lightweight crash telemetry) so beta
      feedback is actionable — especially the print path (MQTT/FTPS timeouts are
      currently hard-coded with no backoff).

## Phase 4 — Post-v1 (deferred — do NOT block ship)

- [ ] Test-coverage backfill where it most reduces regression risk: Rust IPC
      integration tests (print/slice paths), `cadpy` export modules
      (`assembly_composition`, `step_export*`, `step_scene`, `render`), viewer↔3D E2E.
- [ ] Model version control — implement the "linear undo-marker" design in
      `docs/future-work-version-control.md` (earlier branching attempt removed for UX).
- [ ] Connectivity resilience — backoff/retry on MQTT/FTPS; printer job history.
- [ ] Real `step_artifact_regenerate` sidecar (if deferred from Phase 2).
- [ ] Slim the OrcaSlicer bundle (console binary + minimal profile resources instead
      of the full `.app`) to cut the ~482 MB footprint.
- [ ] Linux builds.
- [ ] Panda Cloud subscription proxy (the stated v2 hook).

---

## Verification

**CI gates** (run only those relevant to a change):
- `cd packages/cadpy && python -m pytest`
- `npm --prefix viewer test && npm --prefix viewer run build`
- `cargo --manifest-path desktop/src-tauri/Cargo.toml test`

**End-to-end (the real v1 bar):** build sidecars → `scripts/build/build-app.sh` →
from the packaged `.app`: chat → generate a part → slice → upload → print to a real
Bambu printer. This is the single most important verification and the gate for
Phase 1.

**Per-platform smoke:** repeat the e2e loop on macOS arm64, macOS x64, Windows x64.
