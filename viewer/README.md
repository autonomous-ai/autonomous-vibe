# CAD Viewer

CAD Viewer is a browser workbench for inspecting CAD files, robot-description
files, and generated CAD artifacts from a local root directory or hosted catalog. It
is built for engineering review loops where a developer or agent needs to open
a model quickly, understand the source tree, copy stable `@cad[...]`
references, and verify generated assets without leaving the browser.

## Features

- Scans a configured root directory and mirrors its folder structure in the
  sidebar.
- Opens `.step`, `.stp`, `.stl`, `.3mf`, `.glb`, `.gcode`, `.dxf`, `.urdf`,
  `.srdf`, and `.sdf` entries.
- Uses hidden STEP GLB/topology sidecars for assembly structure, face/edge
  picking, copied CAD references, and STEP parameter controls.
- Previews mesh files, DXF flat patterns, G-code toolpaths, URDF/SDF robots,
  and SRDF group states in one app shell.
- Runs against either a local filesystem backend or hosted Vercel Blob storage.
- Can regenerate STEP GLB/topology artifacts when the CAD Python runtime is
  available.
- Provides optional MoveIt2 websocket controls for SRDF IK and planning.

## Quick Start

Run these commands from this directory:

```bash
npm install
npm run dev
npm run test
npm run build
npm run serve
```

For a reusable local development link, pass the required root directory:

```bash
npm run dev:ensure -- \
  --root-dir /path/to/root \
  --file assemblies/robot-arm/robot-arm.step
```

Use the URL printed by `dev:ensure`; local tools should not assume a fixed port.
Detached servers started by `dev:ensure` and `serve:ensure` shut down
automatically after 12 hours. Pass `--shutdown-after <duration>` only when a
different lifetime is needed, for example `--shutdown-after 30m` or
`--shutdown-after 2h`; reused servers keep their existing shutdown timer.

This workbench keeps a generated `cadjs` package copy under `packages/cadjs` so
the viewer can build from a standalone `viewer/` deploy root. Edit the source of
truth in `../packages/cadjs`, then refresh the viewer-local copy before
handoff:

```bash
../scripts/build/build-viewer.sh
```

Refresh and install the viewer-local Python artifact package when iterating on
local STEP regeneration:

```bash
../scripts/build/build-viewer.sh
python -m pip install -r requirements.txt
```

## Project Layout

- `src/client/`: React app, browser state, styling, and viewer/workbench UI.
- `src/client/components/`: top-level CAD, DXF, workbench, and shadcn-style UI
  components.
- `src/client/workbench/`: selection, persistence, file-sheet, alert, motion,
  and reference helpers that are not React components.
- `src/client/ui/`: viewer-owned browser utilities such as clipboard, color
  scheme, class merging, and DOM helpers.
- `src/server/`: local and hosted backend adapters, HTTP middleware, and the
  local production server.
- `api/cad/`: Vercel serverless shims for `/__cad/*` routes.
- `scripts/`: developer and runtime launchers, plus the test runner.
- `docs/`: workflow reference docs for backend storage, browser persistence,
  and MoveIt2.
- `moveit2_server/`: optional Python websocket backend for SRDF controls.

The shared non-React CAD runtime source lives in `../packages/cadjs` in this
workbench. Keep reusable parsing, rendering, sidecar, selector, and topology
logic there instead of editing generated viewer-local package copies.

## Common Commands

```bash
npm run dev          # Vite dev server with local CAD API middleware
npm run dev:ensure   # Reuse or start a matching detached dev server
npm run build        # Production frontend build
npm run serve        # Serve dist/ with the local or hosted backend
npm run serve:ensure # Reuse or start a matching production server
npm run test         # Discover and run all JS tests
```

`npm run test` uses `scripts/run-tests.mjs`, which discovers
`*.test.js` and `*.test.mjs` under `src/` and `scripts/`. To run specific tests:

```bash
node scripts/run-tests.mjs src/client/workbench/sidebar.test.js
node scripts/run-tests.mjs src/server/localAssetBackend.test.mjs
```

## Runtime Configuration

Important environment variables:

- `VIEWER_ASSET_BACKEND`: `local-fs` for local files or `vercel-blob` for hosted
  Blob assets.
- `VIEWER_DEFAULT_FILE`: root-directory-relative file opened when `?file=` is absent.
- `VIEWER_PORT`: preferred dev or production port, default `4178`.
- `VIEWER_PORT_END`: optional end of the `dev:ensure` / `serve:ensure` port
  search range.
- `VIEWER_SERVER_LIFETIME_MS`: optional server lifetime in milliseconds for
  detached servers. `dev:ensure` and `serve:ensure` set this to 12 hours by
  default, or to the value passed with `--shutdown-after`.
- `VIEWER_GITHUB_URL`: top-bar GitHub link target.
- `VIEWER_ALLOWED_HOSTS`: extra hostnames accepted by local Vite dev and
  production servers.
- `VIEWER_MOVEIT2_WS_URL`: optional websocket URL for SRDF MoveIt2 controls.
- `VIEWER_CAD_PYTHON`: optional Python executable for local STEP regeneration.
- `VIEWER_CAD_PYTHONPATH` / `CAD_PYTHONPATH`: optional Python source path for
  the `cadpy` package.
- `VIEWER_SERVER_REGISTRY`: optional local server registry JSON path.

Local filesystem backend variables:

- `VIEWER_LOCAL_ROOT_DIR`: local filesystem root path used by the backend.
  `dev:ensure` and `serve:ensure` set this from the required `--root-dir`
  argument.

Vercel Blob backend variables:

- `VIEWER_VERCEL_BLOB_PREFIX`: Blob prefix for all catalog assets. For token-free
  hosted deployments, use the public Blob URL for the prefix, such as
  `https://<store-id>.public.blob.vercel-storage.com/models2`. Trusted local
  upload scripts may use the path prefix, such as `models2`.

Hosted Vercel API routes are read-only. They serve the catalog and file assets
but do not regenerate STEP artifacts or require a Blob read/write token at
runtime. The hosted backend always reads `catalog.json` at the root of
`VIEWER_VERCEL_BLOB_PREFIX`; for the example above, that is
`https://<store-id>.public.blob.vercel-storage.com/models2/catalog.json`. Use
`VIEWER_VERCEL_BLOB_READ_WRITE_TOKEN` only for trusted local upload or
maintenance scripts. Hosted server metadata derives the viewer URL from
Vercel's system environment variables (`VERCEL_PROJECT_PRODUCTION_URL`,
`VERCEL_URL`, then `VERCEL_BRANCH_URL`).

Upload a catalog and supported viewer assets from a local directory with
`npm --prefix viewer run upload:blob -- models`.
The repo-level `scripts/catalog/upload-models-catalog.sh` command uploads
`models/` to the configured Blob prefix. Uploads exclude `mechbench/`,
`mechbench2/`, `7dof_arm/`, and Python source files by default; public Blob
catalogs omit Python source paths and URLs.

Production builds contain the frontend and initial catalog module only. CAD
assets are served by a backend and are not copied into `dist/`.

## Reference Docs

- [Backend storage](./docs/backend.md): local filesystem and Vercel Blob backend
  contracts.
- [Browser storage](./docs/storage.md): URL, `localStorage`, and
  `sessionStorage` ownership.
- [MoveIt2 server](./docs/moveit2-server.md): optional SRDF websocket backend.
- `cadjs` render pipeline: shared render APIs used by the viewer, docs, and
  snapshot runtime. In this workbench, see
  `../packages/cadjs/docs/render-pipeline.md`.

## Verification

Run the focused viewer checks before handing off viewer changes:

```bash
npm run test
npm run build
npm run runtime:check
```

For UI behavior changes, also open a representative file with `npm run
dev:ensure` and check that the app renders, selection works, and the browser
console is clean.

When changing Viewer source that feeds the cad-viewer skill runtime, refresh the
generated runtime from the repository root:

```bash
scripts/build/build-cad-viewer-skill.sh
scripts/build/build-cad-viewer-skill.sh --check
```
