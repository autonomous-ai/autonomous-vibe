// Multi-project file tree state for the workspace sidebar.
//
// The Rust catalog is scoped to ONE active project (`catalog_read`). To show
// every project as an expandable subtree, this hook:
//   - lists projects from the projects store,
//   - uses the live active-project catalog (passed in) for the active node so
//     generation/artifact updates appear immediately,
//   - lazily loads each NON-active project's files via `project_catalog_read`
//     when its node is first expanded, caching the result,
//   - builds a per-project directory tree and applies the search filter
//     (matching project names AND files).
//
// Directory-expansion + selection-reveal for the ACTIVE project stays owned by
// CadWorkspace (its persisted `expandedDirectoryIds` and auto-reveal effects);
// this hook only routes the active project's directory toggles back to it and
// owns directory expansion for non-active projects internally.

import { useCallback, useEffect, useMemo, useState } from "react";
import { transport } from "@/lib/transport";
import { withRenderableMeshHashes } from "@/lib/cadCatalogBackendTauri.js";
import { useProjectsStore } from "@/store/projects.ts";
import { sortProjects } from "@/components/library/projectListHelpers.js";
import { isPrintableModelEntry } from "@/workbench/isPrintableModelEntry.js";
import {
  computeProjectNode,
  projectNameMatches,
  EMPTY_ENTRIES,
  EMPTY_DIR_SET,
} from "./projectFileTree.js";

/**
 * @param {object} params
 * @param {string} params.activeProjectId
 * @param {object} params.activeEntriesTree  Pre-filtered directory tree for the active project.
 * @param {Array}  params.activeEntries      Pre-filtered flat entries for the active project.
 * @param {Set<string>} params.activeExpandedDirectoryIds  CadWorkspace-owned dir expansion.
 * @param {(dirId: string) => void} params.onToggleActiveDirectory
 * @param {string} params.query
 */
export function useProjectsFileTree({
  activeProjectId,
  activeEntriesTree,
  activeEntries = EMPTY_ENTRIES,
  activeExpandedDirectoryIds,
  onToggleActiveDirectory,
  query = "",
}) {
  const projects = useProjectsStore((state) => state.projects);
  const sortedProjects = useMemo(() => sortProjects(projects), [projects]);
  const normalizedQuery = query.trim().toLowerCase();
  const queryActive = normalizedQuery.length > 0;

  // Which project nodes are expanded. The active project starts expanded.
  const [expandedProjectIds, setExpandedProjectIds] = useState(
    () => new Set(activeProjectId ? [activeProjectId] : []),
  );
  // Per-project file caches for NON-active projects.
  // Map<projectId, { entries, status: "loading"|"ready"|"error", error }>
  const [catalogs, setCatalogs] = useState(() => new Map());
  // Per-project directory expansion for NON-active projects.
  const [dirsByProject, setDirsByProject] = useState(() => new Map());

  // Keep the active project auto-expanded as it changes, and drop any cached
  // catalog for it: while active it renders from the live catalog, so evicting
  // the snapshot guarantees a fresh reload (not stale data from a prior visit)
  // when it is later demoted to non-active.
  useEffect(() => {
    if (!activeProjectId) return;
    setExpandedProjectIds((current) => {
      if (current.has(activeProjectId)) return current;
      const next = new Set(current);
      next.add(activeProjectId);
      return next;
    });
    setCatalogs((current) => {
      if (!current.has(activeProjectId)) return current;
      const next = new Map(current);
      next.delete(activeProjectId);
      return next;
    });
  }, [activeProjectId]);

  const loadProjectCatalog = useCallback((projectId) => {
    setCatalogs((current) => {
      const existing = current.get(projectId);
      if (existing && (existing.status === "loading" || existing.status === "ready")) {
        return current;
      }
      const next = new Map(current);
      next.set(projectId, { entries: EMPTY_ENTRIES, status: "loading", error: "" });
      return next;
    });
    transport
      .project_catalog_read(projectId)
      .then((rawCatalog) => {
        // Synthesize the per-asset `hash` the Rust catalog omits — exactly as
        // the active project's catalog does (cadCatalogBackendTauri.js). Without
        // it `entryHasMesh` is false for every entry, so the sidebar paints each
        // file with the "pending"/loading spinner even though its STL exists.
        const catalog = withRenderableMeshHashes(rawCatalog);
        const entries = Array.isArray(catalog?.entries)
          ? catalog.entries.filter(isPrintableModelEntry)
          : [];
        setCatalogs((current) => {
          const next = new Map(current);
          next.set(projectId, { entries, status: "ready", error: "" });
          return next;
        });
      })
      .catch((err) => {
        // Tauri rejects an unregistered command with a bare string (no
        // `.message`); surface it verbatim instead of a generic fallback so a
        // stale binary ("…not found") is obvious rather than cryptic.
        const message =
          typeof err === "string"
            ? err
            : err?.message
              ? String(err.message)
              : "Failed to load files";
        setCatalogs((current) => {
          const next = new Map(current);
          next.set(projectId, {
            entries: EMPTY_ENTRIES,
            status: "error",
            error: message,
          });
          return next;
        });
      });
  }, []);

  // Lazy-load any expanded NON-active project that isn't cached yet. Besides the
  // first-expand case (handled in `toggleProject`), this covers the project that
  // was just demoted from active: it had been rendered from the live active
  // catalog and never cached, so without this it would render empty ("No models
  // yet") the moment another project becomes active. (Declared after
  // `loadProjectCatalog` — referencing that const from an effect placed above
  // its declaration throws a TDZ error when the deps array is read at render.)
  useEffect(() => {
    for (const projectId of expandedProjectIds) {
      if (projectId !== activeProjectId && !catalogs.has(projectId)) {
        loadProjectCatalog(projectId);
      }
    }
  }, [expandedProjectIds, activeProjectId, catalogs, loadProjectCatalog]);

  const toggleProject = useCallback(
    (projectId) => {
      let willExpand = false;
      setExpandedProjectIds((current) => {
        const next = new Set(current);
        if (next.has(projectId)) {
          next.delete(projectId);
        } else {
          next.add(projectId);
          willExpand = true;
        }
        return next;
      });
      // Lazy-load a non-active project's files the first time it expands.
      if (willExpand && projectId !== activeProjectId) {
        loadProjectCatalog(projectId);
      }
    },
    [activeProjectId, loadProjectCatalog],
  );

  const onToggleDirectory = useCallback(
    (projectId, dirId) => {
      if (projectId === activeProjectId) {
        onToggleActiveDirectory?.(dirId);
        return;
      }
      setDirsByProject((current) => {
        const next = new Map(current);
        const dirs = new Set(next.get(projectId) || []);
        if (dirs.has(dirId)) {
          dirs.delete(dirId);
        } else {
          dirs.add(dirId);
        }
        next.set(projectId, dirs);
        return next;
      });
    },
    [activeProjectId, onToggleActiveDirectory],
  );

  // Under an active search, load non-active projects whose NAME matches so we
  // can show their files (lazy-friendly: we do not load every project just to
  // search file contents — only name matches and already-loaded projects).
  useEffect(() => {
    if (!queryActive) return;
    for (const project of sortedProjects) {
      if (
        project.id !== activeProjectId &&
        projectNameMatches(project.name, normalizedQuery) &&
        !catalogs.has(project.id)
      ) {
        loadProjectCatalog(project.id);
      }
    }
  }, [queryActive, normalizedQuery, sortedProjects, activeProjectId, catalogs, loadProjectCatalog]);

  const projectNodes = useMemo(() => {
    const nodes = [];
    for (const project of sortedProjects) {
      const isActive = project.id === activeProjectId;
      const node = computeProjectNode({
        project,
        isActive,
        queryActive,
        normalizedQuery,
        userExpanded: expandedProjectIds.has(project.id),
        activeEntries,
        activeEntriesTree,
        activeExpandedDirectoryIds,
        catalog: isActive ? undefined : catalogs.get(project.id),
        dirSet: dirsByProject.get(project.id) || EMPTY_DIR_SET,
      });
      if (node) {
        nodes.push(node);
      }
    }
    return nodes;
  }, [
    sortedProjects,
    activeProjectId,
    queryActive,
    normalizedQuery,
    activeEntries,
    activeEntriesTree,
    activeExpandedDirectoryIds,
    expandedProjectIds,
    catalogs,
    dirsByProject,
  ]);

  return { projectNodes, toggleProject, onToggleDirectory };
}
