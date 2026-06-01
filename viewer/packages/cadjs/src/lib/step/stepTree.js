export const STEP_MODEL_ROOT_ID = "__step_model__";
export const STEP_MODEL_RENDER_PART_ID = "__model__";

function normalizeString(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function normalizePositiveInteger(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 1) {
    return null;
  }
  return Math.floor(numericValue);
}

function basename(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return "";
  }
  return normalized.split(/[\\/]/).filter(Boolean).pop() || normalized;
}

export function stepTreeNodeId(node) {
  return normalizeString(node?.id || node?.occurrenceId);
}

export function stepTreeNodeLabel(node) {
  return normalizeString(
    node?.displayName ||
    node?.name ||
    node?.label ||
    node?.sourcePath && basename(node.sourcePath) ||
    node?.partSourcePath && basename(node.partSourcePath) ||
    node?.id,
    "STEP"
  );
}

export function stepTreeNodeChildren(node) {
  return Array.isArray(node?.children) ? node.children : [];
}

export function stepTreeNodeHasChildren(node) {
  return stepTreeNodeChildren(node).length > 0;
}

export function stepTreeNodeLeafPartIds(node) {
  const declaredLeafPartIds = Array.isArray(node?.leafPartIds)
    ? node.leafPartIds.map((id) => normalizeString(id)).filter(Boolean)
    : [];
  if (declaredLeafPartIds.length) {
    return [...new Set(declaredLeafPartIds)];
  }
  const nodeType = normalizeString(node?.nodeType);
  const nodeId = stepTreeNodeId(node);
  if (nodeType === "part" && nodeId) {
    return [nodeId];
  }
  const leafPartIds = [];
  const stack = [...stepTreeNodeChildren(node)].reverse();
  while (stack.length) {
    const child = stack.pop();
    const childNodeType = normalizeString(child?.nodeType);
    const children = stepTreeNodeChildren(child);
    if (children.length) {
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push(children[index]);
      }
      continue;
    }
    if (childNodeType === "part") {
      const childId = stepTreeNodeId(child);
      if (childId) {
        leafPartIds.push(childId);
      }
    }
  }
  return [...new Set(leafPartIds)];
}

export function buildStepPartRoot({ selectedEntry = null, meshData = null } = {}) {
  const label = normalizeString(
    selectedEntry?.file && basename(selectedEntry.file) ||
    "STEP part"
  );
  return {
    id: STEP_MODEL_ROOT_ID,
    occurrenceId: "",
    nodeType: "part",
    displayName: label,
    name: label,
    sourceKind: "entry",
    leafPartIds: [STEP_MODEL_RENDER_PART_ID],
    bbox: meshData?.bounds || null,
    children: []
  };
}

export function buildStepTreeRoot({ selectedEntry = null, assemblyRoot = null, meshData = null } = {}) {
  if (assemblyRoot && typeof assemblyRoot === "object") {
    return assemblyRoot;
  }
  if (!meshData) {
    return null;
  }
  return buildStepPartRoot({ selectedEntry, meshData });
}

function nodeMatchesQuery(node, query) {
  if (!query) {
    return true;
  }
  const normalizedQuery = normalizeString(query).toLowerCase();
  if (!normalizedQuery) {
    return true;
  }
  const haystack = [
    stepTreeNodeLabel(node),
    stepTreeNodeId(node),
    node?.occurrenceId,
    node?.sourcePath,
    node?.partSourcePath
  ].map((value) => normalizeString(value).toLowerCase()).join(" ");
  return haystack.includes(normalizedQuery);
}

function subtreeMatchesQuery(node, query) {
  if (!query || nodeMatchesQuery(node, query)) {
    return true;
  }
  return stepTreeNodeChildren(node).some((child) => subtreeMatchesQuery(child, query));
}

function subtreeContainsNodeId(node, nodeId) {
  const normalizedNodeId = normalizeString(nodeId);
  if (!node || !normalizedNodeId) {
    return false;
  }
  if (stepTreeNodeId(node) === normalizedNodeId) {
    return true;
  }
  return stepTreeNodeChildren(node).some((child) => subtreeContainsNodeId(child, normalizedNodeId));
}

export function stepTreeRootChildIndexForNode(root, nodeId) {
  const normalizedNodeId = normalizeString(nodeId);
  if (!root || !normalizedNodeId) {
    return -1;
  }
  const children = stepTreeNodeChildren(root);
  for (let index = 0; index < children.length; index += 1) {
    if (subtreeContainsNodeId(children[index], normalizedNodeId)) {
      return index;
    }
  }
  return -1;
}

export function flattenVisibleStepTreeRows(root, expandedNodeIds = [], {
  query = "",
  omitRoot = false,
  rootChildLimit = null,
  showAllRootChildren = true
} = {}) {
  if (!root) {
    return [];
  }
  const expanded = new Set(
    (Array.isArray(expandedNodeIds) ? expandedNodeIds : [])
      .map((id) => normalizeString(id))
      .filter(Boolean)
  );
  const normalizedQuery = normalizeString(query).toLowerCase();
  const normalizedRootChildLimit = normalizePositiveInteger(rootChildLimit);
  const limitRootChildren = Boolean(
    normalizedRootChildLimit &&
    showAllRootChildren !== true &&
    !normalizedQuery
  );
  const rows = [];

  function rootChildrenForVisit(children) {
    return limitRootChildren
      ? children.slice(0, normalizedRootChildLimit)
      : children;
  }

  function visit(node, depth, options = {}) {
    if (normalizedQuery && !subtreeMatchesQuery(node, normalizedQuery)) {
      return;
    }
    const id = stepTreeNodeId(node);
    const children = stepTreeNodeChildren(node);
    const hasChildren = children.length > 0;
    const expandedByQuery = Boolean(normalizedQuery && hasChildren);
    const isExpanded = expandedByQuery || expanded.has(id);
    rows.push({
      id,
      node,
      label: stepTreeNodeLabel(node),
      depth,
      hasChildren,
      expanded: isExpanded,
      leafPartIds: stepTreeNodeLeafPartIds(node)
    });
    if (!hasChildren || !isExpanded) {
      return;
    }
    const childRows = options.isRoot ? rootChildrenForVisit(children) : children;
    for (const child of childRows) {
      visit(child, depth + 1);
    }
  }

  if (omitRoot) {
    for (const child of rootChildrenForVisit(stepTreeNodeChildren(root))) {
      visit(child, 0);
    }
  } else {
    visit(root, 0, { isRoot: true });
  }
  return rows;
}

export function collectStepTreeAncestorIds(root, nodeId) {
  const normalizedNodeId = normalizeString(nodeId);
  if (!root || !normalizedNodeId) {
    return [];
  }
  const path = [];
  function visit(node) {
    const id = stepTreeNodeId(node);
    path.push(id);
    if (id === normalizedNodeId) {
      return true;
    }
    for (const child of stepTreeNodeChildren(node)) {
      if (visit(child)) {
        return true;
      }
    }
    path.pop();
    return false;
  }
  return visit(root) ? path.slice(0, -1).filter(Boolean) : [];
}
