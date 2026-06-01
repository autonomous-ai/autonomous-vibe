// Pure breadcrumb-node construction for the workspace top bar.
//
// Kept JSX-free (and separate from CadWorkspaceTopBar.js) so the node
// model is unit-testable with `node:test`, mirroring how the sidebar tree
// logic lives in `sidebar.js`. The top bar renders these nodes; it does
// not decide their structure.

import { sidebarDirectoryIdForEntry, sidebarDirectoryPath } from "./sidebar.js";

export function directoryTitle(directory) {
  return String(directory?.id || directory?.name || "Workspace");
}

// Build the ordered breadcrumb nodes for the current selection.
//
// Each `directory`/`placeholder` node carries a `menuDirectory` that the
// top bar turns into a browse dropdown of that level's sibling entries —
// this is how the breadcrumb lets you switch between models. `entry` nodes
// are leaves (no dropdown).
//
// A selected entry that lives at the workspace root has no named ancestor
// directory, so we anchor a browse node on the root itself; otherwise the
// breadcrumb would collapse to just the file name with no way to reach
// sibling root-level parts (e.g. multiple STLs the cadcode pipeline writes
// as bare filenames). See breadcrumb.test.js.
export function buildBreadcrumbNodes({
  directoryTree,
  selectedEntry,
  selectedFileLabel,
  selectedFileTitle
}) {
  if (!directoryTree) {
    return [{
      type: "placeholder",
      label: selectedFileLabel,
      title: selectedFileTitle,
      menuDirectory: null
    }];
  }

  if (!selectedEntry) {
    return [{
      type: "placeholder",
      label: selectedFileLabel,
      title: selectedFileTitle,
      menuDirectory: directoryTree
    }];
  }

  const directoryId = sidebarDirectoryIdForEntry(selectedEntry);
  const directoryPath = sidebarDirectoryPath(directoryTree, directoryId);
  const directoryNodes = directoryPath.filter((directory) => String(directory.id || "").trim()).map((directory) => ({
    type: "directory",
    id: String(directory.id || ""),
    label: String(directory.name || "Folder"),
    title: directoryTitle(directory),
    directory,
    menuDirectory: directory
  }));

  // Root-level selection: keep a browsable crumb anchored on the workspace
  // root so its sibling entries stay reachable from the breadcrumb.
  const browseNodes = directoryNodes.length
    ? directoryNodes
    : [{
        type: "directory",
        id: "",
        label: String(directoryTree.name || "Workspace"),
        title: directoryTitle(directoryTree),
        directory: directoryTree,
        menuDirectory: directoryTree
      }];

  return [
    ...browseNodes,
    {
      type: "entry",
      label: selectedFileLabel,
      title: selectedFileTitle,
      entry: selectedEntry,
      menuDirectory: null
    }
  ];
}
