import { buildCadRefToken, parseCadRefToken } from "cadjs/lib/cadRefs.js";
import { normalizeViewerDefaultFile } from "cadjs/lib/viewerConfig.mjs";
import { entrySourceFormat, RENDER_FORMAT } from "cadjs/lib/fileFormats.js";

const CAD_QUERY_PARAM = "file";
const CAD_REF_QUERY_PARAM = "refs";

export function fileKey(entry) {
  return String(entry?.file || "").trim();
}

export function cadPathForEntry(entry) {
  const file = fileKey(entry);
  return file.replace(/\.(step|stp|stl|3mf|glb|gcode|dxf|urdf|srdf|sdf)$/i, "");
}

// The workspace-relative `.stl` for a catalog entry, or "" when the entry has no
// sliceable mesh on disk. An STL entry (standalone model or an assembly part) is
// its own file; a STEP entry renders its archival B-rep but slices/prints from
// the sibling preview `.stl` — the catalog attaches that as `artifact.stlUrl`
// only when the file exists, so deriving `<stem>.stl` is safe. Other kinds (DXF,
// gcode, URDF, …) have no STL. Lets a model opened from the library (no chat
// artifacts this session) still resolve a file to hand to Bambu Studio.
export function entryStlFile(entry) {
  if (!entry) {
    return "";
  }
  const format = entrySourceFormat(entry);
  if (format === RENDER_FORMAT.STL) {
    return fileKey(entry);
  }
  if (format === RENDER_FORMAT.STEP && entry.artifact?.stlUrl) {
    return `${cadPathForEntry(entry)}.stl`;
  }
  return "";
}

// Map a `.gcode` entry back to the workspace-relative `.stl` it was sliced from,
// or "" when no matching model is in the catalog. The slicer names a toolpath
// `<dir>/<stem>.gcode` after its source mesh (`commands/slicer.rs`), so the model
// shares the gcode's stem and directory. We confirm the STL exists by matching it
// against `entries` (an `.stl` entry, or a `.step` entry whose sibling preview
// STL resolves there) rather than trusting the derived name blindly — so viewing
// a sliced gcode from the library can still open its model in Bambu Studio.
export function gcodeSourceStl(gcodeEntry, entries) {
  if (entrySourceFormat(gcodeEntry) !== RENDER_FORMAT.GCODE) {
    return "";
  }
  const stem = cadPathForEntry(gcodeEntry);
  if (!stem) {
    return "";
  }
  const target = `${stem}.stl`;
  const list = Array.isArray(entries) ? entries : [];
  return list.some((entry) => entryStlFile(entry) === target) ? target : "";
}

// The project's single printable STL, or "" when it has zero or more than one.
// A last-resort fallback for the Bambu Studio handoff: when the precise resolvers
// (selected entry / gcode→source) and the chat history all come up empty — e.g. a
// one-model project opened from the library, viewed via its gcode — an
// unambiguous lone model is still the obvious thing to open. Stays silent when
// the choice is ambiguous (multiple models) so we never open the wrong one.
export function soleCatalogStl(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const seen = [];
  for (const entry of list) {
    const stl = entryStlFile(entry);
    if (stl && !seen.includes(stl)) {
      seen.push(stl);
      if (seen.length > 1) {
        return "";
      }
    }
  }
  return seen.length === 1 ? seen[0] : "";
}

function replaceUrl(url) {
  const nextSearch = url.searchParams.toString();
  window.history.replaceState({}, "", `${url.pathname}${nextSearch ? `?${nextSearch}` : ""}${url.hash}`);
}

function normalizeUrlPath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

export function normalizeCadFileQueryParam(value) {
  return normalizeUrlPath(value);
}

function sourceExtensionForPath(value) {
  const match = /\.([^.\/]+)$/.exec(String(value || "").trim());
  return match ? `.${match[1]}` : "";
}

function appendExtension(value, extension) {
  const normalizedValue = normalizeUrlPath(value);
  const normalizedExtension = String(extension || "").trim();
  if (!normalizedValue || !normalizedExtension) {
    return normalizedValue;
  }
  return normalizedValue.toLowerCase().endsWith(normalizedExtension.toLowerCase())
    ? normalizedValue
    : `${normalizedValue}${normalizedExtension}`;
}

function fileAliasesForEntry(entry) {
  const aliases = new Set();
  const addAlias = (value) => {
    const normalizedValue = normalizeUrlPath(value);
    if (normalizedValue) {
      aliases.add(normalizedValue);
    }
  };

  const file = fileKey(entry);
  addAlias(file);

  const cadPath = cadPathForEntry(entry);
  const extension = sourceExtensionForPath(file);
  addAlias(appendExtension(cadPath, extension));

  return aliases;
}

export function readDefaultCadParam() {
  return normalizeViewerDefaultFile(import.meta.env?.VIEWER_DEFAULT_FILE) || null;
}

export function normalizeCadRefQueryParams(values) {
  const sourceValues = Array.isArray(values) ? values : [values];
  const seenTokens = new Set();
  const tokens = [];

  for (const sourceValue of sourceValues) {
    const lines = String(sourceValue || "").split(/\r?\n/);
    for (const line of lines) {
      const normalizedLine = String(line || "").trim();
      const parsedToken = parseCadRefToken(normalizedLine) || parseCadRefToken(`@cad[${normalizedLine}]`);
      const token = String(
        parsedToken
          ? buildCadRefToken({ cadPath: parsedToken.cadPath, selectors: parsedToken.selectors })
          : ""
      ).trim();
      if (!token || seenTokens.has(token)) {
        continue;
      }
      seenTokens.add(token);
      tokens.push(token);
    }
  }

  return tokens;
}

function cadRefQueryValueFromToken(token) {
  const parsedToken = parseCadRefToken(token);
  return parsedToken?.token
    ? parsedToken.token.slice("@cad[".length, -1)
    : "";
}

export function readCadParam() {
  if (typeof window === "undefined") {
    return null;
  }
  const params = new URLSearchParams(window.location.search);
  const value = params.get(CAD_QUERY_PARAM);
  const normalizedValue = typeof value === "string"
    ? normalizeCadFileQueryParam(value)
    : "";
  return normalizedValue || null;
}

export function readCadRefQueryParams() {
  if (typeof window === "undefined") {
    return [];
  }
  const params = new URLSearchParams(window.location.search);
  return normalizeCadRefQueryParams(params.getAll(CAD_REF_QUERY_PARAM));
}

export function findEntryByUrlPath(entries, urlPath) {
  const normalizedUrlPath = normalizeCadFileQueryParam(urlPath);
  if (!normalizedUrlPath) {
    return null;
  }
  return entries.find((entry) => fileAliasesForEntry(entry).has(normalizedUrlPath)) || null;
}

export function shouldDeferFileParamSelection({
  explicitFileParam = "",
  matchingEntry = null,
  selectedEntry = null,
  catalogHydrated = false,
  catalogRefreshing = false
} = {}) {
  const normalizedFileParam = normalizeCadFileQueryParam(explicitFileParam);
  if (!normalizedFileParam || selectedEntry) {
    return false;
  }
  if (matchingEntry) {
    return true;
  }
  return !catalogHydrated || catalogRefreshing;
}

export function missingFileRefForCatalog({
  explicitFileParam = "",
  matchingEntry = null,
  selectedEntry = null,
  catalogHydrated = false,
  catalogRefreshing = false,
  catalogEntryCount = null
} = {}) {
  const normalizedFileParam = normalizeCadFileQueryParam(explicitFileParam);
  if (
    !normalizedFileParam ||
    selectedEntry ||
    matchingEntry ||
    !catalogHydrated ||
    catalogRefreshing ||
    // An empty catalog (e.g. a freshly created project with no model yet) has
    // no file for the param to be "missing" from — show the empty state, not a
    // spurious "File does not exist" error left over from the previous project's
    // `?file=` param. `null` means the count was not supplied; preserve legacy
    // behavior and only suppress when we explicitly know the catalog is empty.
    catalogEntryCount === 0
  ) {
    return "";
  }
  return normalizedFileParam;
}

export function findEntryByCadRefParams(entries, cadRefs = readCadRefQueryParams()) {
  for (const cadRef of Array.isArray(cadRefs) ? cadRefs : [cadRefs]) {
    const cadPath = String(parseCadRefToken(cadRef)?.cadPath || "").trim();
    if (!cadPath) {
      continue;
    }
    const match = entries.find((entry) => cadPathForEntry(entry) === cadPath);
    if (match) {
      return match;
    }
  }
  return null;
}

export function selectedEntryKeyFromUrl(entries, { cadRefs = readCadRefQueryParams(), defaultFile = readDefaultCadParam() } = {}) {
  const explicitFilePath = readCadParam();
  if (explicitFilePath) {
    const match = findEntryByUrlPath(entries, explicitFilePath);
    return match ? fileKey(match) : "";
  }

  const match = findEntryByCadRefParams(entries, cadRefs) || findEntryByUrlPath(entries, normalizeCadFileQueryParam(defaultFile));
  return match ? fileKey(match) : "";
}

export function writeCadParam(urlPath) {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  if (urlPath) {
    url.searchParams.set(CAD_QUERY_PARAM, urlPath);
  } else {
    url.searchParams.delete(CAD_QUERY_PARAM);
  }
  replaceUrl(url);
}

export function writeCadRefQueryParams(cadRefs) {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.delete(CAD_REF_QUERY_PARAM);
  for (const token of Array.isArray(cadRefs) ? cadRefs : [cadRefs]) {
    const queryValue = cadRefQueryValueFromToken(token);
    if (queryValue) {
      url.searchParams.append(CAD_REF_QUERY_PARAM, queryValue);
    }
  }
  replaceUrl(url);
}

function compareSidebarLabels(a, b) {
  return String(a || "").localeCompare(String(b || ""), undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

function entryLeafName(entry) {
  const file = fileKey(entry);
  if (!file) {
    return "";
  }
  const parts = file.split("/");
  return parts[parts.length - 1] || file;
}

function normalizedEntryStem(entry) {
  return entryLeafName(entry)
    .replace(/\.step\.json$/i, "")
    .replace(/\.urdf\.json$/i, "")
    .replace(/\.(step|stp|stl|3mf|glb|gcode|dxf|urdf|srdf|sdf|py)$/i, "");
}

export function sidebarDirectoryIdForEntry(entry) {
  const file = fileKey(entry);
  const parts = file.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function sourceExtensionForEntry(entry) {
  const leafName = entryLeafName(entry);
  const match = /\.([^.]+)$/.exec(leafName);
  return String(match?.[1] || "").trim().toLowerCase();
}

export function filenameLabelForEntry(entry) {
  const stem = normalizedEntryStem(entry);
  if (!stem) {
    return "";
  }
  const kind = String(entry?.kind || "").trim().toLowerCase();
  const directSourceFormats = new Set(["dxf", "urdf", "srdf", "sdf", "stl", "3mf", "glb", "gcode"]);
  const sourceFormat = directSourceFormats.has(kind)
    ? kind
    : String(sourceExtensionForEntry(entry) || "step").trim().toLowerCase();

  if (sourceFormat === "dxf") {
    return `${stem}.dxf`;
  }
  if (sourceFormat === "urdf" || entry?.kind === "urdf") {
    return `${stem}.urdf`;
  }
  if (sourceFormat === "srdf" || entry?.kind === "srdf") {
    return `${stem}.srdf`;
  }
  if (sourceFormat === "sdf" || entry?.kind === "sdf") {
    return `${stem}.sdf`;
  }
  if (sourceFormat === "stl" || entry?.kind === "stl") {
    return `${stem}.stl`;
  }
  if (sourceFormat === "3mf" || entry?.kind === "3mf") {
    return `${stem}.3mf`;
  }
  if (sourceFormat === "glb" || entry?.kind === "glb") {
    return `${stem}.glb`;
  }
  if (sourceFormat === "gcode" || entry?.kind === "gcode") {
    return `${stem}.gcode`;
  }
  return `${stem}.${sourceFormat === "stp" ? "stp" : "step"}`;
}

// Consumer-facing label for a part in the rail / breadcrumb. Users think in
// "parts", not file formats, so we show the bare stem (no .stl/.step/.glb/.3mf
// extension). `filenameLabelForEntry` remains available for tooltips/contexts
// that need the real on-disk filename.
export function sidebarLabelForEntry(entry) {
  return normalizedEntryStem(entry) || filenameLabelForEntry(entry);
}

function compareSidebarEntries(a, b) {
  const nameDiff = sidebarLabelForEntry(a).localeCompare(sidebarLabelForEntry(b), undefined, {
    numeric: true,
    sensitivity: "base"
  });
  if (nameDiff !== 0) {
    return nameDiff;
  }
  return fileKey(a).localeCompare(fileKey(b), undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

function createSidebarDirectoryNode(id, name) {
  return {
    id,
    name,
    entries: [],
    children: new Map()
  };
}

function finalizeSidebarDirectoryNode(node) {
  return {
    id: node.id,
    name: node.name,
    entries: [...node.entries].sort(compareSidebarEntries),
    directories: [...node.children.values()]
      .map(finalizeSidebarDirectoryNode)
      .sort((a, b) => compareSidebarLabels(a.name, b.name))
  };
}

export function buildSidebarDirectoryTree(entries, { rootName = "Workspace" } = {}) {
  const root = createSidebarDirectoryNode("", String(rootName || "Workspace"));

  for (const entry of entries) {
    const directoryId = sidebarDirectoryIdForEntry(entry);
    const directoryParts = directoryId ? directoryId.split("/") : [];
    let currentNode = root;
    let currentId = "";

    for (const part of directoryParts) {
      currentId = currentId ? `${currentId}/${part}` : part;
      const childNode = currentNode.children.get(part) || createSidebarDirectoryNode(currentId, part);
      currentNode.children.set(part, childNode);
      currentNode = childNode;
    }

    currentNode.entries.push(entry);
  }

  return finalizeSidebarDirectoryNode(root);
}

export function collectSidebarDirectoryIds(directoryNode, result = []) {
  for (const directory of directoryNode.directories || []) {
    result.push(directory.id);
    collectSidebarDirectoryIds(directory, result);
  }
  return result;
}

export function findSidebarDirectoryById(directoryNode, directoryId) {
  const targetId = String(directoryId || "").trim();
  if (!directoryNode) {
    return null;
  }
  if (String(directoryNode.id || "") === targetId) {
    return directoryNode;
  }

  for (const childDirectory of directoryNode.directories || []) {
    const match = findSidebarDirectoryById(childDirectory, targetId);
    if (match) {
      return match;
    }
  }

  return null;
}

export function sidebarDirectoryPath(directoryNode, directoryId) {
  const targetId = String(directoryId || "").trim();
  if (!directoryNode) {
    return [];
  }
  if (!targetId) {
    return [directoryNode];
  }

  const result = [];
  const visit = (node) => {
    result.push(node);
    if (String(node.id || "") === targetId) {
      return true;
    }

    for (const childDirectory of node.directories || []) {
      if (visit(childDirectory)) {
        return true;
      }
    }

    result.pop();
    return false;
  };

  return visit(directoryNode) ? result : [];
}

export function listSidebarItems(directory) {
  return [
    ...(directory.directories || []).map((childDirectory) => ({
      type: "directory",
      key: `directory:${childDirectory.id}`,
      label: childDirectory.name,
      value: childDirectory
    })),
    ...(directory.entries || []).map((entry) => ({
      type: "entry",
      key: `entry:${fileKey(entry)}`,
      label: sidebarLabelForEntry(entry),
      value: entry
    }))
  ].sort((a, b) => {
    const labelDiff = compareSidebarLabels(a.label, b.label);
    if (labelDiff !== 0) {
      return labelDiff;
    }
    return a.key.localeCompare(b.key, undefined, {
      numeric: true,
      sensitivity: "base"
    });
  });
}

export function collectAncestorDirectoryIds(directoryId) {
  if (!directoryId) {
    return [];
  }

  const parts = String(directoryId).split("/").filter(Boolean);
  const ancestorIds = [];
  let currentId = "";

  for (const part of parts) {
    currentId = currentId ? `${currentId}/${part}` : part;
    ancestorIds.push(currentId);
  }

  return ancestorIds;
}
