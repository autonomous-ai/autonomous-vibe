# Panda

Imagine. Prompt. Print.

Consumer desktop app that turns natural-language CAD requests into 3D-printable
parts on a Bambu Lab printer. Chat for the design, click for the slice, click
for the print.

## Status

v1 in active development.

## Repo layout

- `desktop/` — Tauri shell (Rust) + bundled CPython + bundled OrcaSlicer
- `viewer/` — Vite + React app (the in-app 3D viewer and chat surface)
- `packages/cadjs/` — viewer's CAD/render/topology JS code (UI-framework-agnostic)
- `packages/cadpy/` — Python STEP/GLB/topology artifact pipeline (build123d + CadQuery)
- `skills/` — Claude Code skills bundled with the app
  - `cadcode` — CadQuery-based parametric CAD generation
  - `cad-viewer` — preview/inspection handoff into the in-app viewer
  - `gcode` — slice meshes via OrcaSlicer CLI
  - `bambu-labs` — upload + start prints on a local Bambu printer
  - `step-parts` — search and download off-the-shelf STEP catalog parts
- `scripts/` — Panda dev/build helpers
- `docs/` — interface contracts and architecture notes

## Prerequisites

- Claude Code installed on PATH: <https://claude.ai/install>
- Node 20+
- Rust + cargo (for Tauri)
- Python 3.11+ (for cadpy local dev; the shipped app bundles its own CPython)

## v1 LLM stance

Panda uses the user's existing Claude Code subscription. v2 will add an
optional Panda Cloud proxy for users who want a subscription instead.

## License

Licensed under the [MIT License](LICENSE), Copyright (c) 2026 dee.

Some bundled skills (`bambu-labs`, `cad-viewer`, `gcode`, `step-parts`) are
third-party components, each MIT-licensed and Copyright (c) 2026 earthtojake.
See [`NOTICE`](NOTICE) and the per-skill `LICENSE` files for attribution.
