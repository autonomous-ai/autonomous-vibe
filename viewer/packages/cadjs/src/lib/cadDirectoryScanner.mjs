import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inlineStepGlbArtifactPathForSource,
  isInlineStepGlbArtifactPath,
  isInlineStepParameterPath,
  isPathInsidePerStepViewerDirectory,
  isPerStepViewerDirectoryName,
  stepParameterPathForStepSource,
} from "../common/stepSidecars.mjs";
import {
  STEP_EDGE_BARYCENTRIC_ATTRIBUTE,
  STEP_EDGE_CLASS_ATTRIBUTE,
  STEP_EDGE_VISIBILITY_CLASSES,
  STEP_TOPOLOGY_EXTENSION,
  STEP_TOPOLOGY_SCHEMA_VERSION,
  isCurrentStepTopologySchemaVersion
} from "../common/stepTopology.mjs";
import { toPosixPath } from "./pathUtils.mjs";
import { readTextToCadStepMetadataFile } from "./step/stepMetadata.mjs";

export const DEFAULT_VIEWER_ROOT_DIR = "";
export const CAD_CATALOG_SCHEMA_VERSION = 4;

const SOURCE_EXTENSIONS = new Set([".step", ".stp", ".stl", ".3mf", ".glb", ".gcode", ".dxf", ".urdf", ".srdf", ".sdf"]);
const REGENERATE_STEP_COMMAND = "python -m cadpy.step_artifact --repo-root . --step";
const PYTHON_SOURCE_HASH_SKIPPED_PATH_PARTS = new Set([
  "__pycache__",
  ".cache",
  ".eggs",
  ".env",
  ".git",
  ".hg",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".svn",
  ".tox",
  ".venv",
  "build",
  "dist",
  "env",
  "node_modules",
  "site-packages",
  "venv",
]);
const CADJS_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const VIEWER_SKIPPED_DIRECTORIES = new Set([
  ".agents",
  ".cache",
  ".viewer",
  ".git",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "viewer",
]);
const SRDF_URDF_METADATA_PATTERN = /<\s*(?:tcad|explorer):urdf\b[^>]*\bpath\s*=\s*["']([^"']+)["'][^>]*>/i;
const STEP_EDGE_RENDER_CLASS_ORDER = Object.freeze(["feature", "tangent", "seam", "degenerate"]);
const TEXT_TO_CAD_COMMENT_METADATA_RE = /<!--\s*cadpy:([A-Za-z][A-Za-z0-9]*)=([\s\S]*?)-->/g;
const PYTHON_GENERATOR_BY_KIND = Object.freeze({
  dxf: "gen_dxf",
  step: "gen_step",
  stp: "gen_step",
  urdf: "gen_urdf",
  srdf: "gen_srdf",
  sdf: "gen_sdf",
});

function encodeUrlPath(repoRelativePath) {
  return `/${repoRelativePath.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}

function relativePathStaysInsideRoot(relativePath) {
  return relativePath === "" || (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function normalizeStepEdgeRenderVisibilityClasses(value) {
  const rawValues = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const validValues = new Set(Object.values(STEP_EDGE_VISIBILITY_CLASSES));
  const normalized = [];
  for (const raw of rawValues) {
    const classId = String(raw || "").trim();
    if (validValues.has(classId) && !normalized.includes(classId)) {
      normalized.push(classId);
    }
  }
  if (!normalized.includes(STEP_EDGE_VISIBILITY_CLASSES.FEATURE)) {
    normalized.unshift(STEP_EDGE_VISIBILITY_CLASSES.FEATURE);
  }
  return [
    ...STEP_EDGE_RENDER_CLASS_ORDER.filter((classId) => normalized.includes(classId)),
    ...normalized.filter((classId) => !STEP_EDGE_RENDER_CLASS_ORDER.includes(classId))
  ];
}

export function normalizeViewerRootDir(value = DEFAULT_VIEWER_ROOT_DIR) {
  const rawValue = String(value ?? "").trim();
  const slashNormalized = rawValue.replace(/\\/g, "/");
  const normalized = path.posix.normalize(slashNormalized);
  if (!normalized || normalized === ".") {
    return DEFAULT_VIEWER_ROOT_DIR;
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`CAD Viewer root directory must stay inside the workspace: ${rawValue}`);
  }
  return normalized.replace(/(?!^\/)\/+$/, "");
}

export function resolveViewerRoot(repoRoot, rootDir = DEFAULT_VIEWER_ROOT_DIR) {
  const normalizedDir = normalizeViewerRootDir(rootDir);
  const resolvedRepoRoot = path.resolve(repoRoot);
  const rootPath = normalizedDir
    ? path.resolve(resolvedRepoRoot, normalizedDir)
    : resolvedRepoRoot;
  const relativePath = path.relative(resolvedRepoRoot, rootPath);
  if (!relativePathStaysInsideRoot(relativePath)) {
    throw new Error(`CAD Viewer root directory must stay inside the workspace: ${normalizedDir}`);
  }
  return {
    dir: normalizedDir,
    rootPath,
    rootName: normalizedDir ? path.basename(rootPath) : path.basename(resolvedRepoRoot),
  };
}

export function repoRelativePath(repoRoot, filePath) {
  return toPosixPath(path.relative(path.resolve(repoRoot), path.resolve(filePath)));
}

function scanRelativePath(rootPath, filePath) {
  return toPosixPath(path.relative(path.resolve(rootPath), path.resolve(filePath)));
}

function fileStats(filePath) {
  try {
    const stats = fs.statSync(filePath, { bigint: true });
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
}

function fileVersion(filePath) {
  const stats = fileStats(filePath);
  if (!stats) {
    return "";
  }
  return `${stats.size.toString(36)}-${stats.mtimeNs.toString(36)}`;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function pathIsInside(filePath, rootPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(filePath));
  return relativePathStaysInsideRoot(relative);
}

function dedupePaths(paths) {
  const result = [];
  const seen = new Set();
  for (const rawPath of paths) {
    const resolved = path.resolve(rawPath);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      result.push(resolved);
    }
  }
  return result;
}

function pythonSourceSearchPaths(repoRoot, scriptPath) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const cadRoot = path.resolve(resolvedRepoRoot, "cad");
  const resolvedScriptPath = path.resolve(scriptPath);
  const paths = [
    resolvedRepoRoot,
    cadRoot,
    CADJS_PACKAGE_ROOT,
    path.resolve(resolvedRepoRoot, "skills", "cad", "scripts"),
    path.dirname(resolvedScriptPath),
  ];
  const stopAt = path.dirname(resolvedRepoRoot);
  let current = path.dirname(resolvedScriptPath);
  for (;;) {
    if (
      fs.existsSync(path.join(current, "STEP", "__init__.py")) ||
      fs.existsSync(path.join(current, "robot_common", "__init__.py"))
    ) {
      paths.push(current);
    }
    if (current === stopAt) {
      break;
    }
    const next = path.dirname(current);
    if (next === current) {
      break;
    }
    current = next;
  }
  return dedupePaths(paths);
}

function pythonSourceManifestRoots(repoRoot) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  return dedupePaths([
    path.resolve(resolvedRepoRoot, "cad"),
    resolvedRepoRoot,
    CADJS_PACKAGE_ROOT,
  ]);
}

function isTrackablePythonSource(filePath, allowedRoots) {
  const resolved = path.resolve(filePath);
  if (path.extname(resolved) !== ".py" || !fileStats(resolved)) {
    return false;
  }
  if (resolved.split(path.sep).some((part) => PYTHON_SOURCE_HASH_SKIPPED_PATH_PARTS.has(part))) {
    return false;
  }
  return allowedRoots.some((root) => pathIsInside(resolved, root));
}

function packageInitFiles(baseDir, packageParts, allowedRoots) {
  const files = new Set();
  for (let index = 1; index <= packageParts.length; index += 1) {
    const initPath = path.join(baseDir, ...packageParts.slice(0, index), "__init__.py");
    if (isTrackablePythonSource(initPath, allowedRoots)) {
      files.add(path.resolve(initPath));
    }
  }
  return files;
}

function resolvePythonModuleFromDirectory(baseDir, moduleName, allowedRoots) {
  const parts = String(moduleName || "").split(".").filter(Boolean);
  if (!parts.length) {
    return new Set();
  }
  const files = new Set();
  const moduleDir = path.join(baseDir, ...parts);
  const leafModule = `${moduleDir}.py`;
  if (isTrackablePythonSource(leafModule, allowedRoots)) {
    for (const filePath of packageInitFiles(baseDir, parts.slice(0, -1), allowedRoots)) {
      files.add(filePath);
    }
    files.add(path.resolve(leafModule));
    return files;
  }
  const packageInit = path.join(moduleDir, "__init__.py");
  if (isTrackablePythonSource(packageInit, allowedRoots)) {
    for (const filePath of packageInitFiles(baseDir, parts, allowedRoots)) {
      files.add(filePath);
    }
  }
  return files;
}

function resolvePythonModule(moduleName, searchPaths, allowedRoots) {
  const files = new Set();
  if (!moduleName) {
    return files;
  }
  for (const baseDir of searchPaths) {
    for (const filePath of resolvePythonModuleFromDirectory(baseDir, moduleName, allowedRoots)) {
      files.add(filePath);
    }
  }
  return files;
}

function splitPythonImportAliases(rawAliases) {
  return String(rawAliases || "")
    .replace(/[()]/g, "")
    .split(",")
    .map((alias) => alias.trim().split(/\s+as\s+/i)[0].trim())
    .filter((alias) => alias && alias !== "*");
}

function stripPythonStringAndCommentLiterals(text) {
  let result = "";
  for (let index = 0; index < text.length;) {
    const char = text[index];
    if (char === "#") {
      while (index < text.length && text[index] !== "\n") {
        result += " ";
        index += 1;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      const quote = char;
      const triple = text.slice(index, index + 3) === quote.repeat(3);
      const endToken = triple ? quote.repeat(3) : quote;
      const startLength = triple ? 3 : 1;
      result += " ".repeat(startLength);
      index += startLength;
      while (index < text.length) {
        if (!triple && text[index] === "\\") {
          result += " ";
          index += 1;
          if (index < text.length) {
            result += text[index] === "\n" ? "\n" : " ";
            index += 1;
          }
          continue;
        }
        if (text.slice(index, index + endToken.length) === endToken) {
          result += " ".repeat(endToken.length);
          index += endToken.length;
          break;
        }
        result += text[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

function normalizePythonImportText(text) {
  const stripped = stripPythonStringAndCommentLiterals(text).replace(/\\\r?\n/g, " ");
  let result = "";
  let parenDepth = 0;
  for (const char of stripped) {
    if (char === "(" || char === "[" || char === "{") {
      parenDepth += 1;
    } else if ((char === ")" || char === "]" || char === "}") && parenDepth > 0) {
      parenDepth -= 1;
    }
    result += char === "\n" && parenDepth > 0 ? " " : char;
  }
  return result;
}

function pythonImportDependencies(filePath, searchPaths, allowedRoots) {
  let text = "";
  try {
    text = normalizePythonImportText(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return [];
  }
  const dependencies = new Set();
  const importRe = /^\s*import\s+([^\n#]+)/gm;
  for (const match of text.matchAll(importRe)) {
    for (const alias of splitPythonImportAliases(match[1])) {
      for (const file of resolvePythonModule(alias, searchPaths, allowedRoots)) {
        dependencies.add(file);
      }
    }
  }
  const fromRe = /^\s*from\s+(\.*)([A-Za-z_][\w.]*)?\s+import\s+([^\n#]+)/gm;
  for (const match of text.matchAll(fromRe)) {
    const level = String(match[1] || "").length;
    const moduleName = String(match[2] || "");
    const aliases = splitPythonImportAliases(match[3]);
    if (level > 0) {
      let baseDir = path.dirname(filePath);
      for (let index = 1; index < level; index += 1) {
        baseDir = path.dirname(baseDir);
      }
      for (const file of resolvePythonModuleFromDirectory(baseDir, moduleName, allowedRoots)) {
        dependencies.add(file);
      }
      for (const alias of aliases) {
        const childName = moduleName ? `${moduleName}.${alias}` : alias;
        for (const file of resolvePythonModuleFromDirectory(baseDir, childName, allowedRoots)) {
          dependencies.add(file);
        }
      }
      continue;
    }
    for (const file of resolvePythonModule(moduleName, searchPaths, allowedRoots)) {
      dependencies.add(file);
    }
    for (const alias of aliases) {
      const childName = moduleName ? `${moduleName}.${alias}` : alias;
      for (const file of resolvePythonModule(childName, searchPaths, allowedRoots)) {
        dependencies.add(file);
      }
    }
  }
  return [...dependencies].sort();
}

function pythonSourceManifestPath(repoRoot, filePath) {
  const resolved = path.resolve(filePath);
  for (const root of pythonSourceManifestRoots(repoRoot)) {
    if (pathIsInside(resolved, root)) {
      return toPosixPath(path.relative(root, resolved));
    }
  }
  return toPosixPath(resolved);
}

function comparePythonSourceManifestPath(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function pythonSourceIdentity(repoRoot, scriptPath) {
  const resolvedScriptPath = path.resolve(scriptPath);
  const searchPaths = pythonSourceSearchPaths(repoRoot, resolvedScriptPath);
  const allowedRoots = searchPaths.map((entry) => path.resolve(entry));
  const queue = [resolvedScriptPath];
  const seen = new Set();
  const files = new Map();
  while (queue.length) {
    const current = path.resolve(queue.shift());
    if (seen.has(current) || !isTrackablePythonSource(current, allowedRoots)) {
      continue;
    }
    seen.add(current);
    files.set(current, sha256File(current));
    for (const dependency of pythonImportDependencies(current, searchPaths, allowedRoots)) {
      if (!seen.has(dependency)) {
        queue.push(dependency);
      }
    }
  }
  const manifestFiles = [...files.entries()]
    .map(([filePath, hash]) => ({ path: pythonSourceManifestPath(repoRoot, filePath), hash }))
    .sort((a, b) => comparePythonSourceManifestPath(a.path, b.path));
  const digest = crypto.createHash("sha256");
  for (const file of manifestFiles) {
    digest.update(file.path, "utf8");
    digest.update("\0");
    digest.update(file.hash, "ascii");
    digest.update("\0");
  }
  return {
    sourcePath: pythonSourceManifestPath(repoRoot, resolvedScriptPath),
    sourceHash: files.get(resolvedScriptPath) || "",
    sourceFingerprint: digest.digest("hex"),
    files: manifestFiles,
  };
}

function pythonSourceHash(repoRoot, scriptPath) {
  return pythonSourceIdentity(repoRoot, scriptPath).sourceFingerprint;
}

function resolveManifestSourcePath(repoRoot, manifestPath) {
  const value = String(manifestPath || "").trim();
  if (!value) {
    return null;
  }
  const resolved = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(repoRoot, value);
  const relative = path.relative(path.resolve(repoRoot), resolved);
  if (!relativePathStaysInsideRoot(relative)) {
    return null;
  }
  return resolved;
}

function sourcePathFromManifest(repoRoot, manifestPath) {
  const value = String(manifestPath || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!value || value === "." || value.startsWith("../")) {
    return { sourcePath: "", filePath: null };
  }
  const filePath = resolveManifestSourcePath(repoRoot, value);
  return {
    sourcePath: value,
    filePath,
  };
}

function fileHasGenStep(filePath) {
  try {
    return /\bgen_step\s*\(/.test(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return false;
  }
}

function generatorSourcePathFromManifest(repoRoot, manifestPath) {
  const candidate = sourcePathFromManifest(repoRoot, manifestPath);
  if (
    candidate.sourcePath &&
    candidate.filePath &&
    path.extname(candidate.filePath).toLowerCase() === ".py" &&
    path.basename(candidate.filePath) !== "__init__.py" &&
    fileHasGenStep(candidate.filePath)
  ) {
    return candidate;
  }
  return { sourcePath: "", filePath: null };
}

function fileHasPythonGenerator(filePath, generatorName) {
  if (!generatorName) {
    return false;
  }
  try {
    const source = fs.readFileSync(filePath, "utf-8");
    return new RegExp(`\\b${generatorName}\\s*\\(`).test(source);
  } catch {
    return false;
  }
}

function generatorSourcePathFromMetadata(repoRoot, manifestPath, generatorName) {
  const candidate = sourcePathFromManifest(repoRoot, manifestPath);
  if (
    candidate.sourcePath &&
    candidate.filePath &&
    path.extname(candidate.filePath).toLowerCase() === ".py" &&
    path.basename(candidate.filePath) !== "__init__.py" &&
    fileHasPythonGenerator(candidate.filePath, generatorName)
  ) {
    return candidate;
  }
  return { sourcePath: "", filePath: null };
}

function readXmlTextToCadMetadata(filePath) {
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    return {};
  }
  const metadata = {};
  for (const match of text.matchAll(TEXT_TO_CAD_COMMENT_METADATA_RE)) {
    metadata[String(match[1] || "").trim()] = String(match[2] || "").trim();
  }
  return metadata;
}

function readDxfTextToCadMetadata(filePath) {
  let lines = [];
  try {
    lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
  } catch {
    return {};
  }
  const metadata = {};
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (String(lines[index] || "").trim() !== "999") {
      continue;
    }
    const value = String(lines[index + 1] || "").trim();
    if (!value.startsWith("cadpy:")) {
      continue;
    }
    const [key, ...rest] = value.slice("cadpy:".length).split("=");
    const normalizedKey = String(key || "").trim();
    if (rest.length && /^[A-Za-z][A-Za-z0-9]*$/.test(normalizedKey)) {
      metadata[normalizedKey] = rest.join("=").trim();
    }
  }
  return metadata;
}

function readGeneratedFileMetadata(filePath, kind) {
  const normalizedKind = String(kind || "").trim().toLowerCase();
  if (normalizedKind === "dxf") {
    return readDxfTextToCadMetadata(filePath);
  }
  if (["urdf", "srdf", "sdf"].includes(normalizedKind)) {
    return readXmlTextToCadMetadata(filePath);
  }
  if (normalizedKind === "step" || normalizedKind === "stp") {
    try {
      return readTextToCadStepMetadataFile(filePath);
    } catch {
      return {};
    }
  }
  return {};
}

function generatedSourceStatusForFile({ repoRoot, sourcePath, kind }) {
  const normalizedKind = String(kind || "").trim().toLowerCase();
  const generatorName = PYTHON_GENERATOR_BY_KIND[normalizedKind] || "";
  if (!generatorName) {
    return null;
  }
  const metadata = readGeneratedFileMetadata(sourcePath, normalizedKind);
  const metadataSourcePath = String(metadata.sourcePath || "").trim();
  if (!metadataSourcePath) {
    return null;
  }
  const sourceIdentity = generatorSourcePathFromMetadata(repoRoot, metadataSourcePath, generatorName);
  const base = {
    sourceKind: "python",
    source: {
      file: sourceIdentity.sourcePath || metadataSourcePath,
      sourcePath: sourceIdentity.sourcePath || metadataSourcePath,
      ...(metadata.sourceHash ? { sourceHash: String(metadata.sourceHash) } : {}),
      ...(metadata.sourceFingerprint ? { sourceFingerprint: String(metadata.sourceFingerprint) } : {}),
    },
  };
  if (!sourceIdentity.filePath) {
    return {
      ...base,
      sourceStatus: {
        ok: false,
        status: "missing",
        stale: false,
        sourceKind: "python",
        sourcePath: metadataSourcePath,
        message: "Python generator source is unavailable.",
      },
    };
  }
  const currentIdentity = pythonSourceIdentity(repoRoot, sourceIdentity.filePath);
  const artifactFingerprint = String(metadata.sourceFingerprint || "").trim();
  if (!artifactFingerprint) {
    return {
      ...base,
      source: {
        ...base.source,
        file: sourceIdentity.sourcePath,
        sourcePath: sourceIdentity.sourcePath,
        sourceHash: String(metadata.sourceHash || ""),
        sourceFingerprint: "",
      },
      sourceStatus: {
        ok: false,
        status: "missing_identity",
        stale: false,
        sourceKind: "python",
        sourcePath: sourceIdentity.sourcePath,
        sourceHash: String(metadata.sourceHash || ""),
        currentSourceHash: currentIdentity.sourceHash,
        currentHash: currentIdentity.sourceFingerprint,
        message: "Generated file is missing Python sourceFingerprint metadata.",
      },
    };
  }
  const stale = Boolean(artifactFingerprint && artifactFingerprint !== currentIdentity.sourceFingerprint);
  return {
    ...base,
    source: {
      ...base.source,
      file: sourceIdentity.sourcePath,
      sourcePath: sourceIdentity.sourcePath,
      sourceHash: String(metadata.sourceHash || ""),
      sourceFingerprint: String(metadata.sourceFingerprint || ""),
    },
    sourceStatus: {
      ok: !stale,
      status: stale ? "stale" : "current",
      stale,
      sourceKind: "python",
      sourcePath: sourceIdentity.sourcePath,
      artifactHash: artifactFingerprint,
      currentHash: currentIdentity.sourceFingerprint,
      sourceHash: String(metadata.sourceHash || ""),
      currentSourceHash: currentIdentity.sourceHash,
      message: stale ? "Generated file doesn't match the Python generator fingerprint." : "",
    },
  };
}

function assetForPath(repoRoot, filePath) {
  const stats = fileStats(filePath);
  if (!stats) {
    return null;
  }
  const version = `${stats.size.toString(36)}-${stats.mtimeNs.toString(36)}`;
  const repoPath = repoRelativePath(repoRoot, filePath);
  return {
    url: `${encodeUrlPath(repoPath)}?v=${encodeURIComponent(version)}`,
    hash: sha256File(filePath),
    bytes: Number(stats.size),
  };
}

function assetUrlForPath(repoRoot, filePath) {
  return encodeUrlPath(repoRelativePath(repoRoot, filePath));
}

function readExact(fd, length, position) {
  const buffer = Buffer.alloc(length);
  const bytesRead = fs.readSync(fd, buffer, 0, length, position);
  return bytesRead === length ? buffer : null;
}

function glbBufferViewRange(gltf, binOffset, binLength, viewIndex) {
  const view = Array.isArray(gltf?.bufferViews) ? gltf.bufferViews[Number(viewIndex)] : null;
  if (!view || Number(view.buffer || 0) !== 0) {
    return null;
  }
  const byteOffset = binOffset + Number(view.byteOffset || 0);
  const byteLength = Number(view.byteLength || 0);
  if (!Number.isFinite(byteOffset) || !Number.isFinite(byteLength) || byteLength < 0) {
    return null;
  }
  if (byteOffset < binOffset || byteOffset + byteLength > binOffset + binLength) {
    return null;
  }
  return { byteOffset, byteLength };
}

function parseJsonBufferView(fd, gltf, binOffset, binLength, viewIndex, encoding = "utf-8") {
  const range = glbBufferViewRange(gltf, binOffset, binLength, viewIndex);
  if (!range) {
    throw new Error("STEP topology buffer view range is invalid");
  }
  const bytes = readExact(fd, range.byteLength, range.byteOffset);
  if (!bytes) {
    throw new Error("STEP topology buffer view range is invalid");
  }
  const payload = JSON.parse(bytes.toString(String(encoding || "utf-8")));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("STEP topology JSON buffer view is not an object");
  }
  return payload;
}

function gltfPrimitivesHaveSurfaceEdgeAttributes(gltf) {
  const meshes = Array.isArray(gltf?.meshes) ? gltf.meshes : [];
  let primitiveCount = 0;
  for (const mesh of meshes) {
    for (const primitive of Array.isArray(mesh?.primitives) ? mesh.primitives : []) {
      primitiveCount += 1;
      const attributes = primitive?.attributes || {};
      if (
        attributes[STEP_EDGE_BARYCENTRIC_ATTRIBUTE] === undefined ||
        attributes[STEP_EDGE_CLASS_ATTRIBUTE] === undefined
      ) {
        return false;
      }
    }
  }
  return primitiveCount > 0;
}

function readGlbTopologyContainer(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const header = readExact(fd, 12, 0);
    if (!header || header.readUInt32LE(0) !== 0x46546c67 || header.readUInt32LE(4) !== 2) {
      throw new Error("Not a GLB v2 file");
    }
    const totalLength = Math.min(header.readUInt32LE(8), fs.fstatSync(fd).size);
    let offset = 12;
    let gltf = null;
    let binOffset = 0;
    let binLength = 0;
    while (offset + 8 <= totalLength) {
      const chunkHeader = readExact(fd, 8, offset);
      if (!chunkHeader) {
        throw new Error("Invalid GLB chunk header");
      }
      const chunkLength = chunkHeader.readUInt32LE(0);
      const chunkType = chunkHeader.toString("latin1", 4, 8);
      offset += 8;
      if (offset + chunkLength > totalLength) {
        throw new Error("Invalid GLB chunk length");
      }
      if (chunkType === "JSON") {
        const jsonBytes = readExact(fd, chunkLength, offset);
        if (!jsonBytes) {
          throw new Error("GLB is missing JSON chunk");
        }
        gltf = JSON.parse(jsonBytes.toString("utf8").trim());
      } else if (chunkType === "BIN\u0000") {
        binOffset = offset;
        binLength = chunkLength;
      }
      offset += chunkLength;
    }
    return {
      fd,
      gltf,
      binOffset,
      binLength,
    };
  } catch {
    if (fd !== null) {
      fs.closeSync(fd);
    }
    throw new Error("Invalid GLB topology container");
  }
}

function stepArtifactError({ code, reason, repoRoot, cadPath, sourcePath, glbPath, details = {} }) {
  const glbRelPath = repoRelativePath(repoRoot, glbPath);
  return {
    ok: false,
    error: {
      code,
      message: `${reason}: ${glbRelPath}.`,
      cadPath,
      stepPath: repoRelativePath(repoRoot, sourcePath),
      glbPath: glbRelPath,
      regenerateCommand: REGENERATE_STEP_COMMAND,
      ...details,
    },
  };
}

function staleSourceIdentityError({
  repoRoot,
  cadPath,
  sourcePath,
  glbPath,
  sourceKind,
  manifestSourcePath = "",
  artifactHash,
  currentHash,
}) {
  const normalizedKind = String(sourceKind || "step").trim().toLowerCase() === "python" ? "python" : "step";
  const reason = normalizedKind === "python"
    ? "Generated GLB doesn't match the hash of the Python generator script"
    : "Generated GLB doesn't match the hash of the STEP file";
  return stepArtifactError({
    code: "stale_source_identity",
    reason,
    repoRoot,
    cadPath,
    sourcePath,
    glbPath,
    details: {
      stale: true,
      sourceKind: normalizedKind,
      ...(manifestSourcePath ? { sourcePath: manifestSourcePath } : {}),
      artifactHash,
      currentHash,
    },
  });
}

export function validateStepTopologyArtifact({ repoRoot, sourcePath, cadPath }) {
  const glbPath = inlineStepGlbArtifactPathForSource(sourcePath);
  let stepHash = "";
  let sourceHash = "";
  let artifactSourcePath = "";
  const fail = (code, reason) => ({
    topology: null,
    stepArtifact: stepArtifactError({ code, reason, repoRoot, cadPath, sourcePath, glbPath }),
    glbPath,
    stepHash,
    sourceHash,
  });

  if (!fileStats(glbPath)) {
    return fail(
      "missing_glb",
      "STEP topology validation requires the generated GLB artifact, but it is missing"
    );
  }

  let container = null;
  try {
    container = readGlbTopologyContainer(glbPath);
    const extension = container.gltf?.extensions?.[STEP_TOPOLOGY_EXTENSION];
    if (!extension || typeof extension !== "object" || Array.isArray(extension)) {
      return fail(
        "missing_step_topology",
        "STEP topology validation requires readable STEP_topology indexView in the GLB"
      );
    }
    if (!isCurrentStepTopologySchemaVersion(extension.schemaVersion)) {
      return fail(
        "unsupported_step_topology",
        `STEP topology validation requires STEP_topology schemaVersion ${STEP_TOPOLOGY_SCHEMA_VERSION} in the GLB`
      );
    }
    const manifest = parseJsonBufferView(
      container.fd,
      container.gltf,
      container.binOffset,
      container.binLength,
      extension.indexView,
      extension.encoding
    );
    const topology = {
      index: manifest,
      entryKind: String(extension.entryKind || manifest.entryKind || "").trim().toLowerCase(),
      hasSelector: false,
      hasDisplayEdges: false,
    };
    if (!isCurrentStepTopologySchemaVersion(manifest.schemaVersion)) {
      return {
        topology,
        stepArtifact: stepArtifactError({
          code: "unsupported_step_topology",
          reason: `STEP topology validation requires STEP_topology schemaVersion ${STEP_TOPOLOGY_SCHEMA_VERSION} in the GLB`,
          repoRoot,
          cadPath,
          sourcePath,
          glbPath,
        }),
        glbPath,
        stepHash,
      };
    }
    const artifactSourceKind = String(manifest.sourceKind || "step").trim().toLowerCase();
    const artifactUsesPythonSource = artifactSourceKind === "python";
    const artifactNormalizedSourceKind = artifactUsesPythonSource ? "python" : "step";
    const artifactIdentityDetails = () => ({
      sourceKind: artifactNormalizedSourceKind,
      ...(artifactSourcePath ? { sourcePath: artifactSourcePath } : {}),
    });
    const sourceIdentity = artifactUsesPythonSource
      ? generatorSourcePathFromManifest(repoRoot, manifest.sourcePath)
      : sourcePathFromManifest(repoRoot, manifest.sourcePath);
    artifactSourcePath = sourceIdentity.sourcePath;
    if (!artifactSourcePath || !sourceIdentity.filePath) {
      return {
        topology,
        stepArtifact: stepArtifactError({
          code: "missing_source_path",
          reason: "GLB STEP_topology is missing required sourcePath identity",
          repoRoot,
          cadPath,
          sourcePath,
          glbPath,
          details: {
            sourceKind: artifactNormalizedSourceKind,
          },
        }),
        glbPath,
        stepHash,
        sourceHash,
      };
    }
    stepHash = String(manifest.stepHash || "").trim();
    sourceHash = String(manifest.sourceHash || "").trim();
    const sourceFingerprint = String(manifest.sourceFingerprint || "").trim();
    const sourceIdentityPresent = artifactUsesPythonSource ? Boolean(sourceFingerprint) : Boolean(stepHash);
    if (!sourceIdentityPresent) {
      return {
        topology,
        stepArtifact: stepArtifactError({
          code: "missing_source_identity",
          reason: artifactUsesPythonSource
            ? "GLB STEP_topology is missing Python generator identity"
            : "GLB STEP_topology is missing STEP file identity",
          repoRoot,
          cadPath,
          sourcePath,
          glbPath,
          details: artifactIdentityDetails(),
        }),
        glbPath,
        stepHash,
          sourceHash,
          sourceFingerprint,
      };
    }
    const currentSourceIdentity = artifactUsesPythonSource
      ? pythonSourceIdentity(repoRoot, sourceIdentity.filePath)
      : null;
    const currentSourceFingerprint = artifactUsesPythonSource
      ? currentSourceIdentity?.sourceFingerprint || ""
      : (fileStats(sourcePath) ? sha256File(sourcePath) : "");
    const artifactSourceFingerprint = artifactUsesPythonSource ? sourceFingerprint : stepHash;
    if (currentSourceFingerprint && artifactSourceFingerprint !== currentSourceFingerprint) {
      return {
        topology,
        stepArtifact: staleSourceIdentityError({
          repoRoot,
          cadPath,
          sourcePath,
          glbPath,
          sourceKind: artifactSourceKind,
          manifestSourcePath: artifactSourcePath,
          artifactHash: artifactSourceFingerprint,
          currentHash: currentSourceFingerprint,
        }),
        glbPath,
        stepHash,
        sourceHash,
        sourceFingerprint,
      };
    }
    let edgeRendering = null;
    try {
      const edgeManifest = parseJsonBufferView(
        container.fd,
        container.gltf,
        container.binOffset,
        container.binLength,
        extension.edgeView,
        extension.encoding
      );
      const edgeVisibilityClasses = edgeManifest?.edgeRendering && typeof edgeManifest.edgeRendering === "object"
        ? normalizeStepEdgeRenderVisibilityClasses(edgeManifest.edgeRendering.visibilityClasses)
        : [];
      const indexEdgeVisibilityClasses = manifest?.edgeRendering && typeof manifest.edgeRendering === "object"
        ? normalizeStepEdgeRenderVisibilityClasses(manifest.edgeRendering.visibilityClasses)
        : [];
      if (
        !isCurrentStepTopologySchemaVersion(edgeManifest.schemaVersion) ||
        String(edgeManifest.profile || "") !== "surface-edges" ||
        String(edgeManifest.sourcePath || "").trim() !== String(manifest.sourcePath || "").trim() ||
        (artifactUsesPythonSource
          ? String(edgeManifest.sourceKind || "").trim().toLowerCase() !== "python" ||
            String(edgeManifest.sourceFingerprint || "").trim() !== sourceFingerprint
          : String(edgeManifest.stepHash || "").trim() !== stepHash) ||
        !edgeVisibilityClasses.length ||
        edgeVisibilityClasses.join("\n") !== indexEdgeVisibilityClasses.join("\n") ||
        !edgeVisibilityClasses.includes(STEP_EDGE_VISIBILITY_CLASSES.FEATURE) ||
        !edgeManifest?.buffers?.views?.surfaceHalfEdges
      ) {
        return {
          topology,
          stepArtifact: stepArtifactError({
            code: "missing_edge_topology",
          reason: `STEP topology validation requires STEP_topology edgeView schemaVersion ${STEP_TOPOLOGY_SCHEMA_VERSION} in the GLB`,
          repoRoot,
          cadPath,
          sourcePath,
          glbPath,
          details: artifactIdentityDetails(),
        }),
        glbPath,
        stepHash,
          sourceHash,
          sourceFingerprint,
        };
      }
      edgeRendering = edgeManifest.edgeRendering && typeof edgeManifest.edgeRendering === "object"
        ? {
            visibilityClasses: edgeVisibilityClasses,
            generatedVisibilityClasses: (Array.isArray(edgeManifest.edgeRendering.generatedVisibilityClasses)
              ? edgeManifest.edgeRendering.generatedVisibilityClasses
              : edgeVisibilityClasses
            )
              .map((classId) => String(classId || "").trim())
              .filter((classId, index, list) => (
                edgeVisibilityClasses.includes(classId) &&
                STEP_EDGE_RENDER_CLASS_ORDER.includes(classId) &&
                list.indexOf(classId) === index
              )),
            visibilityClassCounts: edgeManifest.edgeRendering.visibilityClassCounts || {},
            generatedVisibilityClassCounts: edgeManifest.edgeRendering.generatedVisibilityClassCounts || {},
          }
        : null;
      if (!gltfPrimitivesHaveSurfaceEdgeAttributes(container.gltf)) {
        return {
          topology,
          stepArtifact: stepArtifactError({
            code: "missing_surface_edge_attributes",
            reason: `STEP topology validation requires ${STEP_EDGE_BARYCENTRIC_ATTRIBUTE} and ${STEP_EDGE_CLASS_ATTRIBUTE} on every STEP mesh primitive`,
            repoRoot,
            cadPath,
            sourcePath,
            glbPath,
            details: artifactIdentityDetails(),
          }),
          glbPath,
          stepHash,
          sourceHash,
          sourceFingerprint,
        };
      }
    } catch {
      return {
        topology,
        stepArtifact: stepArtifactError({
          code: "missing_edge_topology",
          reason: "STEP topology validation requires readable STEP_topology edgeView in the GLB",
          repoRoot,
          cadPath,
          sourcePath,
          glbPath,
          details: artifactIdentityDetails(),
        }),
        glbPath,
        stepHash,
        sourceHash,
        sourceFingerprint,
      };
    }
    topology.hasDisplayEdges = true;
    try {
      const selectorManifest = parseJsonBufferView(
        container.fd,
        container.gltf,
        container.binOffset,
        container.binLength,
        extension.selectorView,
        extension.encoding
      );
      if (!isCurrentStepTopologySchemaVersion(selectorManifest.schemaVersion)) {
        return {
          topology,
          stepArtifact: stepArtifactError({
            code: "unsupported_step_topology",
            reason: `STEP topology validation requires STEP_topology schemaVersion ${STEP_TOPOLOGY_SCHEMA_VERSION} in the GLB`,
            repoRoot,
            cadPath,
            sourcePath,
            glbPath,
            details: artifactIdentityDetails(),
          }),
          glbPath,
          stepHash,
          sourceHash,
          sourceFingerprint,
        };
      }
    } catch {
      return {
        topology,
        stepArtifact: stepArtifactError({
          code: "missing_selector_topology",
          reason: "STEP topology validation requires readable STEP_topology selectorView in the GLB",
          repoRoot,
          cadPath,
          sourcePath,
          glbPath,
          details: artifactIdentityDetails(),
        }),
        glbPath,
        stepHash,
        sourceHash,
        sourceFingerprint,
      };
    }
    topology.hasSelector = true;
    const stepArtifact = {
      ok: true,
      glbPath: repoRelativePath(repoRoot, glbPath),
      ...(artifactSourcePath ? { sourcePath: artifactSourcePath } : {}),
      sourceKind: artifactUsesPythonSource ? "python" : "step",
      ...(edgeRendering ? { edgeRendering } : {}),
      ...(artifactUsesPythonSource
        ? {
            sourceHash,
            ...(sourceFingerprint ? { sourceFingerprint } : {}),
          }
        : {
            stepHash,
          }),
    };
    return {
      topology,
      stepArtifact,
      glbPath,
      stepHash,
      sourceHash,
      sourceFingerprint,
    };
  } catch {
    return fail(
      "missing_step_topology",
      "STEP topology validation requires readable STEP_topology indexView in the GLB"
    );
  } finally {
    if (container?.fd !== null && container?.fd !== undefined) {
      try {
        fs.closeSync(container.fd);
      } catch {
        // Ignore close failures during catalog scanning.
      }
    }
  }
}

export function readStepSourceStatus({
  repoRoot,
  stepPath,
  pythonSourcePath = "",
  cadPath = "",
} = {}) {
  if (!repoRoot) {
    throw new Error("repoRoot is required");
  }
  if (!stepPath) {
    throw new Error("stepPath is required");
  }
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedStepPath = path.resolve(stepPath);
  const extension = path.extname(resolvedStepPath) || ".step";
  const normalizedCadPath = cadPath || cadPathForStepSource(resolvedRepoRoot, resolvedStepPath, extension);
  const validation = validateStepTopologyArtifact({
    repoRoot: resolvedRepoRoot,
    sourcePath: resolvedStepPath,
    cadPath: normalizedCadPath,
  });
  const stepArtifact = validation.stepArtifact || {};
  const stepArtifactError = stepArtifact.error && typeof stepArtifact.error === "object"
    ? stepArtifact.error
    : {};
  const artifact = catalogArtifactFromValidation(stepArtifact) || null;
  let resolvedPythonSourcePath = pythonSourcePath ? path.resolve(pythonSourcePath) : "";
  const artifactSourceKind = String(
    stepArtifact.sourceKind ||
    stepArtifactError.sourceKind ||
    "",
  ).trim().toLowerCase();
  if (artifactSourceKind === "step") {
    resolvedPythonSourcePath = "";
  } else if (!resolvedPythonSourcePath && artifactSourceKind === "python") {
    const manifestSourcePath = String(stepArtifact.sourcePath || stepArtifactError.sourcePath || "").trim();
    if (manifestSourcePath) {
      resolvedPythonSourcePath = path.resolve(resolvedRepoRoot, manifestSourcePath);
    }
  }
  const sourceKind = resolvedPythonSourcePath || artifactSourceKind === "python" ? "python" : "step";
  const file = repoRelativePath(resolvedRepoRoot, resolvedStepPath);
  const base = {
    ok: true,
    file,
    stepPath: file,
    sourceKind,
    artifact,
    ...(resolvedPythonSourcePath ? { sourcePath: repoRelativePath(resolvedRepoRoot, resolvedPythonSourcePath) } : {}),
  };

  if (!fileStats(resolvedStepPath)) {
    return {
      ...base,
      ok: false,
      step: {
        ok: false,
        status: "missing",
        missing: true,
        stale: false,
        message: "STEP file is missing.",
      },
    };
  }

  if (sourceKind !== "python") {
    return {
      ...base,
      step: {
        ok: true,
        status: "current",
        missing: false,
        stale: false,
      },
    };
  }

  if (!resolvedPythonSourcePath || !fileStats(resolvedPythonSourcePath)) {
    return {
      ...base,
      step: {
        ok: true,
        status: "unknown",
        missing: false,
        stale: false,
        message: "Python source identity is unavailable.",
      },
    };
  }

  const currentIdentity = pythonSourceIdentity(resolvedRepoRoot, resolvedPythonSourcePath);
  const currentHash = currentIdentity.sourceFingerprint;
  let metadata = {};
  try {
    metadata = readTextToCadStepMetadataFile(resolvedStepPath);
  } catch {
    metadata = {};
  }
  const stepSourceHash = String(metadata.sourceHash || "").trim();
  const stepSourceFingerprint = String(metadata.sourceFingerprint || "").trim();
  if (!stepSourceFingerprint) {
    return {
      ...base,
      ok: false,
      step: {
        ok: false,
        status: "missing_identity",
        missing: false,
        stale: false,
        metadataMissing: true,
        sourceHash: stepSourceHash,
        currentHash,
        currentSourceHash: currentIdentity.sourceHash,
        message: "STEP file is missing Python source identity metadata.",
      },
    };
  }
  if (stepSourceFingerprint !== currentHash) {
    return {
      ...base,
      ok: false,
      step: {
        ok: false,
        status: "stale",
        missing: false,
        stale: true,
        artifactHash: stepSourceFingerprint,
        currentHash,
        sourceHash: stepSourceHash,
        currentSourceHash: currentIdentity.sourceHash,
        message: stepSourceFingerprint
          ? "STEP file doesn't match the hash of the Python generator script."
          : "STEP file is missing Python source identity metadata.",
      },
    };
  }

  return {
    ...base,
    step: {
      ok: true,
      status: "current",
      missing: false,
      stale: false,
      currentHash,
      sourceHash: stepSourceHash,
      currentSourceHash: currentIdentity.sourceHash,
    },
  };
}

function stepKindFromTopology(topology) {
  const index = topology?.index && typeof topology.index === "object" ? topology.index : topology;
  if (topology?.entryKind === "assembly" || index?.entryKind === "assembly") {
    return "assembly";
  }
  return index?.assembly?.root && typeof index.assembly.root === "object"
    ? "assembly"
    : "part";
}

function sourceFormatFromExtension(extension) {
  const normalized = extension.toLowerCase().replace(/^\./, "");
  return normalized === "stp" ? "stp" : normalized;
}

function isPerUrdfViewerDirectoryName(name) {
  const normalized = String(name || "").toLowerCase();
  return normalized.startsWith(".") && normalized.endsWith(".urdf");
}

function isHiddenDirectoryName(name) {
  return String(name || "").startsWith(".");
}

function isPathInsidePerUrdfViewerDirectory(filePath) {
  return String(filePath || "")
    .split(path.sep)
    .some((part) => isPerUrdfViewerDirectoryName(part));
}

function fileRefForSource(rootPath, sourcePath) {
  return scanRelativePath(rootPath, sourcePath);
}

function cadPathForStepSource(repoRoot, sourcePath, extension) {
  const relativePath = repoRelativePath(repoRoot, sourcePath);
  return relativePath.slice(0, -extension.length);
}

function sourcePathForInlineStepGlbArtifact(glbPath) {
  const name = path.basename(glbPath);
  if (!isInlineStepGlbArtifactPath(glbPath)) {
    return null;
  }
  return path.join(path.dirname(glbPath), name.slice(1, -".glb".length));
}

function sourcePathForInlineStepParameter(parameterPath) {
  const name = path.basename(parameterPath);
  if (!isInlineStepParameterPath(parameterPath)) {
    return null;
  }
  return path.join(path.dirname(parameterPath), name.slice(1, -".js".length));
}

function catalogArtifactFromValidation(stepArtifact) {
  if (!stepArtifact || typeof stepArtifact !== "object") {
    return undefined;
  }
  if (stepArtifact.ok) {
    return undefined;
  }
  const rawError = stepArtifact.error && typeof stepArtifact.error === "object"
    ? stepArtifact.error
    : {};
  const error = String(rawError.code || stepArtifact.error || "step_artifact_error").trim();
  const message = String(rawError.message || "").trim();
  const sourceKind = String(rawError.sourceKind || "").trim();
  const artifactHash = String(rawError.artifactHash || "").trim();
  const currentHash = String(rawError.currentHash || "").trim();
  const sourceHash = String(rawError.sourceHash || "").trim();
  const sourceFingerprint = String(rawError.sourceFingerprint || "").trim();
  const stepPath = String(rawError.stepPath || "").trim();
  const glbPath = String(rawError.glbPath || "").trim();
  const cadPath = String(rawError.cadPath || "").trim();
  return {
    ok: false,
    error,
    ...(rawError.stale ? { stale: true } : {}),
    ...(stepPath ? { stepPath } : {}),
    ...(glbPath ? { glbPath } : {}),
    ...(cadPath ? { cadPath } : {}),
    ...(sourceKind ? { sourceKind } : {}),
    ...(sourceHash ? { sourceHash } : {}),
    ...(sourceFingerprint ? { sourceFingerprint } : {}),
    ...(artifactHash ? { artifactHash } : {}),
    ...(currentHash ? { currentHash } : {}),
    ...(message ? { message } : {}),
  };
}

function readStepCatalogMetadata({ repoRoot, glbPath } = {}) {
  if (!fileStats(glbPath)) {
    return {};
  }
  let container = null;
  try {
    container = readGlbTopologyContainer(glbPath);
    const extension = container.gltf?.extensions?.[STEP_TOPOLOGY_EXTENSION];
    if (!extension || typeof extension !== "object" || Array.isArray(extension)) {
      return {};
    }
    if (!isCurrentStepTopologySchemaVersion(extension.schemaVersion)) {
      return {};
    }
    const manifest = parseJsonBufferView(
      container.fd,
      container.gltf,
      container.binOffset,
      container.binLength,
      extension.indexView,
      extension.encoding
    );
    const sourceKind = String(manifest?.sourceKind || "step").trim().toLowerCase() === "python"
      ? "python"
      : "step";
    const sourceIdentity = sourceKind === "python"
      ? generatorSourcePathFromManifest(repoRoot, manifest?.sourcePath)
      : sourcePathFromManifest(repoRoot, manifest?.sourcePath);
    return {
      topology: {
        index: manifest,
        entryKind: String(extension.entryKind || manifest?.entryKind || "").trim().toLowerCase(),
        hasSelector: Boolean(extension.selectorView),
        hasDisplayEdges: Boolean(extension.edgeView),
      },
      sourceKind,
      sourcePath: sourceIdentity.sourcePath,
      sourceHash: String(manifest?.sourceHash || ""),
      sourceFingerprint: String(manifest?.sourceFingerprint || ""),
      stepHash: String(manifest?.stepHash || ""),
    };
  } catch {
    return {};
  } finally {
    if (container?.fd !== null && container?.fd !== undefined) {
      try {
        fs.closeSync(container.fd);
      } catch {
        // Ignore close failures during lightweight catalog metadata reads.
      }
    }
  }
}

function pythonStepSourceFromStepMetadata(repoRoot, stepPath) {
  const metadata = readGeneratedFileMetadata(stepPath, "step");
  const metadataSourcePath = String(metadata.sourcePath || "").trim();
  if (!metadataSourcePath) {
    return null;
  }
  const sourceIdentity = sourcePathFromManifest(repoRoot, metadataSourcePath);
  if (!sourceIdentity.sourcePath) {
    return null;
  }
  const sourceExtension = path.extname(sourceIdentity.filePath || sourceIdentity.sourcePath).toLowerCase();
  if (sourceExtension !== ".py") {
    return null;
  }
  return {
    sourcePath: sourceIdentity.sourcePath,
    sourceHash: String(metadata.sourceHash || ""),
    sourceFingerprint: String(metadata.sourceFingerprint || ""),
  };
}

function createStepEntry({ repoRoot, rootPath, sourcePath, extension, includeArtifactStatus = true }) {
  const cadPath = cadPathForStepSource(repoRoot, sourcePath, extension);
  const validation = includeArtifactStatus
    ? validateStepTopologyArtifact({
        repoRoot,
        sourcePath,
        cadPath,
      })
    : null;
  const glbPath = validation?.glbPath || inlineStepGlbArtifactPathForSource(sourcePath);
  const catalogMetadata = includeArtifactStatus
    ? {}
    : readStepCatalogMetadata({ repoRoot, glbPath });
  const topology = validation?.topology || catalogMetadata.topology || null;
  const stepArtifact = validation?.stepArtifact || {};
  const glbAsset = assetForPath(repoRoot, glbPath);
  const stepModuleAsset = assetForPath(repoRoot, stepParameterPathForStepSource(sourcePath));
  const artifact = includeArtifactStatus ? catalogArtifactFromValidation(stepArtifact) : undefined;
  const artifactSourceKind = String(
    stepArtifact.sourceKind ||
    stepArtifact.error?.sourceKind ||
    catalogMetadata.sourceKind ||
    artifact?.sourceKind ||
    "",
  ).trim().toLowerCase();
  const metadataPythonSource = (!includeArtifactStatus || artifact) && artifactSourceKind !== "python"
    ? pythonStepSourceFromStepMetadata(repoRoot, sourcePath)
    : null;
  const sourceKind = artifactSourceKind === "python" || metadataPythonSource ? "python" : "step";
  const artifactSourcePath = String(
    stepArtifact.sourcePath ||
    stepArtifact.error?.sourcePath ||
    catalogMetadata.sourcePath ||
    ""
  ).trim();
  const pythonSourcePath = artifactSourcePath || metadataPythonSource?.sourcePath || "";
  return {
    file: fileRefForSource(rootPath, sourcePath),
    kind: stepKindFromTopology(topology),
    url: glbAsset?.url || assetUrlForPath(repoRoot, glbPath),
    hash: glbAsset?.hash || "",
    bytes: glbAsset?.bytes || 0,
    sourceKind,
    ...(sourceKind === "python" && pythonSourcePath ? {
      source: {
        file: pythonSourcePath,
        sourcePath: pythonSourcePath,
        ...((stepArtifact.sourceHash || catalogMetadata.sourceHash || metadataPythonSource?.sourceHash)
          ? { sourceHash: stepArtifact.sourceHash || catalogMetadata.sourceHash || metadataPythonSource.sourceHash }
          : {}),
        ...((stepArtifact.sourceFingerprint || catalogMetadata.sourceFingerprint || metadataPythonSource?.sourceFingerprint)
          ? { sourceFingerprint: stepArtifact.sourceFingerprint || catalogMetadata.sourceFingerprint || metadataPythonSource.sourceFingerprint }
          : {}),
      },
    } : {}),
    ...(stepModuleAsset ? { moduleUrl: stepModuleAsset.url } : {}),
    ...(artifact ? { artifact } : {}),
  };
}

function linkedUrdfPathForSrdf(sourcePath, repoRoot) {
  let xmlText = "";
  try {
    xmlText = fs.readFileSync(sourcePath, "utf-8");
  } catch {
    return null;
  }
  const match = SRDF_URDF_METADATA_PATTERN.exec(xmlText);
  const rawRef = String(match?.[1] || "").trim();
  if (!rawRef || rawRef.includes("\\") || rawRef.startsWith("/")) {
    return null;
  }
  const resolved = path.resolve(path.dirname(sourcePath), rawRef);
  const relativeToRepo = path.relative(path.resolve(repoRoot), resolved);
  if (!relativePathStaysInsideRoot(relativeToRepo) || path.extname(resolved).toLowerCase() !== ".urdf") {
    return null;
  }
  return fileStats(resolved) ? resolved : null;
}

function createSingleAssetEntry({ repoRoot, rootPath, sourcePath, extension }) {
  const kind = sourceFormatFromExtension(extension);
  const asset = assetForPath(repoRoot, sourcePath);
  const file = fileRefForSource(rootPath, sourcePath);
  const generatedSource = generatedSourceStatusForFile({ repoRoot, sourcePath, kind });
  const entry = {
    file,
    kind,
    url: asset?.url || assetUrlForPath(repoRoot, sourcePath),
    hash: asset?.hash || "",
    bytes: asset?.bytes || 0,
    ...(generatedSource?.sourceKind === "python" ? { sourceKind: "python" } : {}),
    ...(generatedSource?.source ? { source: generatedSource.source } : {}),
    ...(generatedSource?.sourceStatus ? { sourceStatus: generatedSource.sourceStatus } : {}),
  };
  if (kind === "srdf") {
    const linkedUrdfPath = linkedUrdfPathForSrdf(sourcePath, repoRoot);
    if (linkedUrdfPath) {
      const urdfAsset = assetForPath(repoRoot, linkedUrdfPath);
      if (urdfAsset) {
        entry.relations = {
          urdf: {
            file: fileRefForSource(rootPath, linkedUrdfPath),
            ...urdfAsset,
          },
        };
      }
    }
  }
  return entry;
}

function shouldSkipDirectory(name) {
  return VIEWER_SKIPPED_DIRECTORIES.has(name) || isHiddenDirectoryName(name) || isPerStepViewerDirectoryName(name) || isPerUrdfViewerDirectoryName(name);
}

function scanPathIncluded(includePath, rootPath, entryPath, isDirectory) {
  if (typeof includePath !== "function") {
    return true;
  }
  return includePath({
    filePath: entryPath,
    relativePath: scanRelativePath(rootPath, entryPath),
    isDirectory,
  }) !== false;
}

function collectCadSourceFiles(rootPath, { scanRootPath = rootPath, includePath = null } = {}, result = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(entry.name) && scanPathIncluded(includePath, scanRootPath, entryPath, true)) {
        collectCadSourceFiles(entryPath, { scanRootPath, includePath }, result);
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!scanPathIncluded(includePath, scanRootPath, entryPath, false)) {
      continue;
    }
    const extension = path.extname(entry.name).toLowerCase();
    if (isInlineStepGlbArtifactPath(entryPath)) {
      const sourcePath = sourcePathForInlineStepGlbArtifact(entryPath);
      if (sourcePath && !fileStats(sourcePath)) {
        result.push(entryPath);
      }
      continue;
    }
    if (SOURCE_EXTENSIONS.has(extension) && !isInlineStepGlbArtifactPath(entryPath)) {
      result.push(entryPath);
      continue;
    }
  }
  return result;
}

function compareEntries(a, b) {
  return String(a.file || "").localeCompare(String(b.file || ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function pathHasSkippedDirectory(rootPath, filePath) {
  const relativePath = scanRelativePath(rootPath, filePath);
  if (!relativePathStaysInsideRoot(relativePath)) {
    return true;
  }
  const parts = relativePath.split("/").filter(Boolean);
  return parts.slice(0, -1).some((part) => shouldSkipDirectory(part));
}

function logicalStepSourcePathForInlineArtifactPath(filePath) {
  if (isInlineStepGlbArtifactPath(filePath)) {
    return sourcePathForInlineStepGlbArtifact(filePath);
  }
  if (isInlineStepParameterPath(filePath)) {
    return sourcePathForInlineStepParameter(filePath);
  }
  return null;
}

function logicalStepSourceExistsForSidecar(sourcePath) {
  return Boolean(
    sourcePath &&
    (
      fileStats(sourcePath) ||
      fileStats(inlineStepGlbArtifactPathForSource(sourcePath)) ||
      fileStats(stepParameterPathForStepSource(sourcePath))
    )
  );
}

export function catalogFileRefForPath({ repoRoot, rootDir = DEFAULT_VIEWER_ROOT_DIR, filePath } = {}) {
  if (!repoRoot) {
    throw new Error("repoRoot is required");
  }
  if (!filePath) {
    throw new Error("filePath is required");
  }
  const resolved = resolveViewerRoot(repoRoot, rootDir);
  const resolvedFilePath = path.resolve(filePath);
  if (!pathIsInside(resolvedFilePath, resolved.rootPath) || pathHasSkippedDirectory(resolved.rootPath, resolvedFilePath)) {
    return "";
  }
  const logicalStepSourcePath = logicalStepSourcePathForInlineArtifactPath(resolvedFilePath);
  if (logicalStepSourcePath) {
    return fileRefForSource(resolved.rootPath, logicalStepSourcePath);
  }
  if (isPathInsidePerStepViewerDirectory(resolvedFilePath) || isPathInsidePerUrdfViewerDirectory(resolvedFilePath)) {
    return "";
  }
  const extension = path.extname(resolvedFilePath).toLowerCase();
  return SOURCE_EXTENSIONS.has(extension)
    ? fileRefForSource(resolved.rootPath, resolvedFilePath)
    : "";
}

export function scanCadFile({
  repoRoot,
  rootDir = DEFAULT_VIEWER_ROOT_DIR,
  filePath,
  includeArtifactStatus = true,
} = {}) {
  if (!repoRoot) {
    throw new Error("repoRoot is required");
  }
  if (!filePath) {
    throw new Error("filePath is required");
  }
  const resolved = resolveViewerRoot(repoRoot, rootDir);
  const resolvedFilePath = path.resolve(filePath);
  if (!pathIsInside(resolvedFilePath, resolved.rootPath) || pathHasSkippedDirectory(resolved.rootPath, resolvedFilePath)) {
    return null;
  }

  const logicalStepSourcePath = logicalStepSourcePathForInlineArtifactPath(resolvedFilePath);
  if (logicalStepSourcePath) {
    if (!logicalStepSourceExistsForSidecar(logicalStepSourcePath)) {
      return null;
    }
    return createStepEntry({
      repoRoot,
      rootPath: resolved.rootPath,
      sourcePath: logicalStepSourcePath,
      extension: path.extname(logicalStepSourcePath).toLowerCase(),
      includeArtifactStatus,
    });
  }

  if (isPathInsidePerStepViewerDirectory(resolvedFilePath) || isPathInsidePerUrdfViewerDirectory(resolvedFilePath)) {
    return null;
  }

  const extension = path.extname(resolvedFilePath).toLowerCase();
  if (!SOURCE_EXTENSIONS.has(extension) || !fileStats(resolvedFilePath)) {
    if ((extension === ".step" || extension === ".stp") && fileStats(inlineStepGlbArtifactPathForSource(resolvedFilePath))) {
      return createStepEntry({
        repoRoot,
        rootPath: resolved.rootPath,
        sourcePath: resolvedFilePath,
        extension,
        includeArtifactStatus,
      });
    }
    return null;
  }
  if (extension === ".step" || extension === ".stp") {
    return createStepEntry({
      repoRoot,
      rootPath: resolved.rootPath,
      sourcePath: resolvedFilePath,
      extension,
      includeArtifactStatus,
    });
  }
  return createSingleAssetEntry({
    repoRoot,
    rootPath: resolved.rootPath,
    sourcePath: resolvedFilePath,
    extension,
  });
}

export function scanCadDirectory({
  repoRoot,
  rootDir = DEFAULT_VIEWER_ROOT_DIR,
  includePath = null,
  includeArtifactStatus = true,
} = {}) {
  if (!repoRoot) {
    throw new Error("repoRoot is required");
  }
  const resolved = resolveViewerRoot(repoRoot, rootDir);
  const entries = collectCadSourceFiles(resolved.rootPath, {
    scanRootPath: resolved.rootPath,
    includePath,
  })
    .map((sourcePath) => {
      const logicalSourcePath = isInlineStepGlbArtifactPath(sourcePath)
        ? sourcePathForInlineStepGlbArtifact(sourcePath)
        : sourcePath;
      const extension = path.extname(logicalSourcePath).toLowerCase();
      if (extension === ".step" || extension === ".stp") {
        return createStepEntry({
          repoRoot,
          rootPath: resolved.rootPath,
          sourcePath: logicalSourcePath,
          extension,
          includeArtifactStatus,
        });
      }
      return createSingleAssetEntry({
        repoRoot,
        rootPath: resolved.rootPath,
        sourcePath,
        extension,
      });
    })
    .sort(compareEntries);

  return {
    schemaVersion: CAD_CATALOG_SCHEMA_VERSION,
    entries,
  };
}

export function sortCatalogEntries(entries) {
  return [...(Array.isArray(entries) ? entries : [])].sort(compareEntries);
}

export function isServedCadAsset(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (isInlineStepGlbArtifactPath(filePath)) {
    return true;
  }
  if (isInlineStepParameterPath(filePath)) {
    return true;
  }
  if (isPathInsidePerStepViewerDirectory(filePath)) {
    return false;
  }
  if (isPathInsidePerUrdfViewerDirectory(filePath)) {
    return false;
  }
  if (SOURCE_EXTENSIONS.has(extension)) {
    return true;
  }
  return false;
}

function isCatalogRelevantPythonSource(filePath) {
  const resolved = path.resolve(filePath);
  if (path.extname(resolved).toLowerCase() !== ".py") {
    return false;
  }
  return !resolved.split(path.sep).some((part) => PYTHON_SOURCE_HASH_SKIPPED_PATH_PARTS.has(part));
}

export function isCatalogRelevantPath(filePath) {
  return isServedCadAsset(filePath) || isCatalogRelevantPythonSource(filePath);
}
