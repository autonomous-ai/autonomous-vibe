# AGENTS.md

This repo is a consumer desktop app. Bootstrapped from text-to-cad and cadcode
donor sources; once bootstrapped, no runtime dependency on those repos.

## Repo Rules

- Each skill must be self-contained at runtime. No skill imports from another
  skill or from repo-root modules. Shared runtime helpers live under
  `packages/` and get vendored into skill runtimes at build time.
- `packages/cadjs/` is the source of truth for the viewer's JS package.
  `viewer/packages/cadjs/` is a generated copy refreshed by
  `scripts/build/build-viewer-packages.sh`. Do not hand-edit the viewer copy.
- `packages/cadpy/` is the source of truth for the Python artifact pipeline.
  Vendored copies under skill runtimes (e.g.
  `skills/cadcode/scripts/packages/cadpy/`) are generated; do not hand-edit.
- Edit sources first, then regenerate explicit derived outputs.
- Out of scope for v1: URDF / SRDF / SDF (robotics), SendCutSend (services),
  non-Bambu printers. Code paths for these may still exist (inherited from
  donors) but are not exercised and not on the v1 release checklist.

## Implementation tracks

Work is split into five worktree-friendly parallel tracks (cadpy / skill /
Tauri / chat / library+onboarding). Inter-track contracts live in
`docs/panda-interfaces.md`.

## Checks

Run only the checks relevant to the change.

- cadpy: `cd packages/cadpy && python -m pytest`
- cadjs / viewer: `npm --prefix viewer test && npm --prefix viewer run build`
- Tauri: `cargo --manifest-path desktop/src-tauri/Cargo.toml test`
