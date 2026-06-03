// Pure helpers for the multi-project sidebar tree (no React / transport / store
// imports), so the search + visibility rules are unit-testable under plain
// node. `useProjectsFileTree` composes these into stateful behavior.

import {
  buildSidebarDirectoryTree,
  fileKey,
  sidebarLabelForEntry,
} from "../../../workbench/sidebar.js";

export const EMPTY_ENTRIES = Object.freeze([]);
export const EMPTY_DIR_SET = Object.freeze(new Set());

export function projectNameMatches(name, query) {
  return String(name || "").toLowerCase().includes(query);
}

export function entryMatchesQuery(entry, query) {
  return (
    sidebarLabelForEntry(entry).toLowerCase().includes(query) ||
    String(entry.kind || "").toLowerCase().includes(query) ||
    fileKey(entry).toLowerCase().includes(query)
  );
}

/**
 * Pure per-project node builder for the sidebar tree. Returns a render-ready
 * node, or `null` when the project should be hidden under the current search.
 *
 * Active project: tree/entries are pre-filtered upstream (CadWorkspace). A
 * non-active project shows all its files when its NAME matches the query, only
 * its matching files when a file matches, and is hidden otherwise. Projects not
 * yet loaded contribute only via a name match (lazy: we don't load everything
 * just to search file contents).
 */
export function computeProjectNode({
  project,
  isActive,
  queryActive,
  normalizedQuery,
  userExpanded,
  activeEntries = EMPTY_ENTRIES,
  activeEntriesTree = null,
  activeExpandedDirectoryIds = EMPTY_DIR_SET,
  catalog,
  dirSet = EMPTY_DIR_SET,
}) {
  const nameMatch = queryActive && projectNameMatches(project.name, normalizedQuery);
  const expanded = queryActive ? true : Boolean(userExpanded);

  if (isActive) {
    const hasFiles = activeEntries.length > 0;
    if (queryActive && !nameMatch && !hasFiles) {
      return null;
    }
    return {
      id: project.id,
      name: project.name,
      isActive: true,
      expanded,
      status: "ready",
      error: "",
      tree: activeEntriesTree,
      hasFiles,
      expandedDirectoryIds: activeExpandedDirectoryIds,
    };
  }

  const status = catalog?.status || "idle";
  const entries = catalog?.entries || EMPTY_ENTRIES;
  let visibleEntries = entries;

  if (queryActive && !nameMatch) {
    if (!catalog || status === "loading") {
      return null; // not loaded and name doesn't match → can't contribute
    }
    const fileMatches = entries.filter((entry) => entryMatchesQuery(entry, normalizedQuery));
    if (!fileMatches.length) {
      return null;
    }
    visibleEntries = fileMatches;
  }

  return {
    id: project.id,
    name: project.name,
    isActive: false,
    expanded,
    status,
    error: catalog?.error || "",
    tree: buildSidebarDirectoryTree(visibleEntries),
    hasFiles: entries.length > 0,
    expandedDirectoryIds: dirSet,
  };
}
