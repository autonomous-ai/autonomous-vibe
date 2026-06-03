# Sidebar Project Tree — Design

**Date:** 2026-06-03
**Status:** Approved (design); pending implementation plan

## Problem

Today the workspace sidebar ("Models" rail) shows the files of a single
**active project** only. To work on a different project the user opens a
top-bar dropdown (`ProjectMenu`) and switches; the dropdown also offers
create/delete. The catalog is scoped to one project at a time on the Rust
backend (`catalog_read` scans only `state.active_project()`).

We want the sidebar to show **all projects** as a tree: every project is a
top-level node, expandable to reveal its file/directory subtree. The top-bar
dropdown shrinks to just **New project** + **Delete project**.

## Goals

- Sidebar lists every project; each expands to show its files.
- Clicking a file opens it in the 3D viewer and switches the active project so
  chat + viewer follow it.
- Files for non-active projects load lazily (on expand), without changing which
  project is active.
- Search matches both project names and files.
- Top-bar dropdown contains only New project + Delete project; trigger still
  shows the active project's name.

## Non-goals

- Per-project right-click / inline delete affordance (delete stays in the
  dropdown, targeting the active project).
- Decoupling the 3D viewer from the chat session (clicking a file switches the
  full active-project context, matching today's one-active-project model).
- Eager scanning of all projects' files up front.

## Decisions (from brainstorming)

1. **File loading:** lazy per-project read — a new IPC reads a specific
   project's files on demand, without making it active.
2. **Click a file:** switches the active project (chat session, 3D viewer, and
   generation all follow the clicked file's project).
3. **Search scope:** matches project names **and** files; a project-name match
   surfaces and auto-loads that project, file matches auto-expand their project.
4. **Dropdown:** New project + Delete project only; trigger shows active project
   name.
5. **Header label:** rename "Models" → "Projects" (the rail is now
   project-rooted).

## Architecture

### 1. New IPC command — `project_catalog_read(id)`

`catalog_read()` scans only the active project. Add a sibling that scans an
explicit project by id, with no state mutation.

- **Rust** — `desktop/src-tauri/src/commands/catalog.rs`:
  ```
  #[tauri::command]
  pub async fn project_catalog_read(id: String) -> IpcResult<Catalog>
  ```
  Resolves `paths::project_root(&id)`, `create_dir_all`, then reuses the
  existing `scan_workspace(&root)`. Returns the same `Catalog { entries,
  rootPath, revision }` shape. `revision` can be `0` (or the global revision);
  non-active subtrees do not need cache-busting since they are not rendered in
  the 3D pane until selected (which switches them to active and re-reads through
  `cadManifestStore`). Register in `desktop/src-tauri/src/lib.rs`.
- **transport.ts** — mirror as
  `project_catalog_read: (id) => invoke<Catalog>("project_catalog_read", { id })`,
  plus a browser-dev stub returning `{ entries: [], rootPath, revision: 0 }`.
- **docs/panda-interfaces.md §2** — document the new command.
  ⚠️ This **extends the v1-frozen IPC contract**; the contract doc must be
  updated in the same change (the doc instructs reading it before crossing
  layers).

The asset URLs returned by `scan_workspace` are `pandaasset://` URLs that
resolve against the **open** project's dir (`asset_protocol.rs`). For non-active
projects these URLs are only used for tree display (labels/icons), not for
loading bytes; bytes are loaded only after a file is clicked, which first
switches the active project. So no asset-protocol change is required. (Confirm
during implementation that the tree does not eagerly fetch any bytes for
non-active entries.)

### 2. State & data flow — `useProjectsFileTree` hook

New hook under `viewer/src/client/components/workbench/hooks/`:

- Reads `projects` from `useProjectsStore` (already loaded in `main.jsx`).
- Maintains a per-project cache:
  `Map<projectId, { entries: CatalogEntry[], status: "idle"|"loading"|"ready"|"error", error: string }>`.
- **Lazy load:** when a project node is expanded for the first time (and it is
  not the active project), call `transport.project_catalog_read(projectId)`,
  filter the result through the existing `isPrintableModelEntry`, and cache it.
- **Active project:** entries come from the live `manifestEntries` prop (the
  `cadManifestStore` catalog), not the cache, so generation/artifact updates
  appear immediately.
- Each project's entries are turned into a directory tree with the existing
  `buildSidebarDirectoryTree(entries)`.

**Cross-project file selection:** `onSelectEntry` gains awareness of the file's
owning project.
- Same project as active → select immediately (current behavior).
- Different project → `await useProjectsStore.open(projectId)` +
  `setChatProject(projectId)`, then record the desired `selectedKey` in a
  pending-selection ref. When the new project's catalog finishes refreshing
  (`cadManifestStore` revision bumps / `catalogHydrated`), apply the pending
  selection. This handles the async catalog swap.

### 3. Sidebar UI — `FileViewerSidebar.js`

- The top level of the menu becomes **project nodes**. Each is a
  `Collapsible` + `SidebarMenuButton` (same pattern as `DirectoryNode`), with a
  project icon (e.g. `Boxes`/`Package`) and the project name. The active project
  is marked (`isActive`) and auto-expanded on load.
- Inside an expanded project, render its directory tree using the **existing**
  `DirectoryNode` / `FileEntryButton` components unchanged — they already handle
  nesting, icons, generation status, and the file-access context menu.
- Per-project subtree states: "Loading…", "No models yet", and an error line,
  mirroring the existing catalog loading/empty/error copy.
- Header label changes from "Models" to **"Projects"**. Search input placeholder
  stays "Search models…" or becomes "Search projects…" (implementer's choice;
  keep consistent with header).
- **Search:** the query filters across project names and the files of loaded
  projects. A project-name match keeps that project visible and triggers its
  lazy load; a file match auto-expands its project. While a query is active,
  matched projects render expanded (mirroring the existing `queryActive`
  directory behavior).
- **Expansion persistence:** extend the existing
  `fileViewerExpandedDirectoryIds` session state to namespace directory IDs by
  project (e.g. `"<projectId>/<dirId>"`), plus track which project nodes are
  expanded. The active project auto-expands even with no stored state.

### 4. Top-bar dropdown — `ProjectMenu.jsx`

- Remove the project-list section (`others.map(...)` and its separator).
- Keep only **New project** and **Delete project** menu items.
- Delete continues to target the active project (`currentProjectId`). Deleting a
  non-active project requires switching to it first — accepted limitation for
  this iteration.
- Trigger button unchanged (shows active project name + chevron).

## Data shapes

- `Catalog` (existing): `{ entries: CatalogEntry[], rootPath: string, revision: number }`.
- `ProjectSummary` (existing): `{ id, name, createdAt, updatedAt, hasModel }`.
- New per-project cache entry (frontend only):
  `{ entries: CatalogEntry[], status, error }`.

## Error handling

- `project_catalog_read` for a missing/invalid id: surface an `IpcError`; the
  hook stores `status: "error"` and the subtree shows an inline error line. The
  rest of the tree is unaffected.
- Cross-project open failure: log and leave the active project unchanged (mirror
  existing `switchTo` catch in `ProjectMenu`).

## Testing

- **Rust** (`commands/catalog.rs` tests): `project_catalog_read` scans the named
  project's dir and ignores the active-project state (scoping test analogous to
  the existing `scan_workspace` tests).
- **Viewer:**
  - `useProjectsFileTree`: lazy-loads a non-active project on expand; uses live
    `manifestEntries` for the active project; cross-project selection opens the
    project then applies the pending selection after catalog refresh.
  - Search: a project-name query surfaces and loads a non-active project; a file
    query auto-expands the owning project.
  - `ProjectMenu`: renders only New + Delete (no project-list items).

## Affected files

- `desktop/src-tauri/src/commands/catalog.rs` — new command.
- `desktop/src-tauri/src/lib.rs` — register command.
- `docs/panda-interfaces.md` — document new command (frozen-contract extension).
- `viewer/src/client/lib/transport.ts` — mirror command + stub.
- `viewer/src/client/components/workbench/hooks/useProjectsFileTree.(js|ts)` — new.
- `viewer/src/client/components/workbench/FileViewerSidebar.js` — project tree UI.
- `viewer/src/client/components/CadWorkspace.js` — wire hook, cross-project
  selection, expansion state.
- `viewer/src/client/components/project/ProjectMenu.jsx` — trim dropdown.
