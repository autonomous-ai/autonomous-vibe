# Vibe Hardware: Create Magical Things by Chatting with AI

It's this simple to make anything with Vibe.

**1. Design:**
Describe what you want. Vibe designs it into a real, precise object — exactly as you pictured it.

**2. Print:** 
Send it straight to your printer. Clean, watertight parts that land on the bed ready to go.

**3. Bring it to life:** 
Pull it off the plate and into the world. The thing that only lived in your head — now in your hand.

https://github.com/user-attachments/assets/8a79be02-ea62-45d8-9db2-bfa7c33fb7e3

## Status

v1 in active development.

## Repo layout

- `desktop/` — Tauri shell (Rust) + bundled CPython + bundled OrcaSlicer
- `viewer/` — Vite + React app (the in-app 3D viewer and chat surface)
- `packages/cadjs/` — viewer's CAD mesh/render JS code (UI-framework-agnostic)
- `packages/cadpy/` — Python STEP + STL artifact pipeline (CadQuery)
- `skills/` — Claude Code skills bundled with the app
  - `cadcode` — CadQuery-based parametric CAD generation
  - `cad-viewer` — preview/inspection handoff into the in-app viewer
  - `step-parts` — search and download off-the-shelf STEP catalog parts
  - `shape-analysis` — enrich a terse object prompt into a print-ready design brief
- `scripts/` — Panda dev/build helpers
- `docs/` — interface contracts and architecture notes

## Prerequisites

- Claude Code installed on PATH: <https://claude.ai/install>
- Node 20+
- Rust + cargo (for Tauri)
- Python 3.11+ (for cadpy local dev; the shipped app bundles its own CPython)

## v1 LLM stance

Vibe uses the user's existing Claude Code subscription. v2 will add an
optional Vibe Cloud LLM for users who want a simple subscription instead.
