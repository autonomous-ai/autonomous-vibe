import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  CAD_CATALOG_SCHEMA_VERSION,
  DEFAULT_VIEWER_ROOT_DIR,
  catalogFileRefForPath,
  isServedCadAsset,
  normalizeViewerRootDir,
  readStepSourceStatus,
  repoRelativePath,
  resolveViewerRoot,
  scanCadDirectory,
  scanCadFile,
  sortCatalogEntries,
} from "cadjs/lib/cadDirectoryScanner.mjs";
import {
  generationStatusDir as resolveGenerationStatusDir,
  isGenerationStatusPath,
  readGenerationStatus,
} from "cadjs/lib/generationStatus.mjs";
import { pathIsInside } from "cadjs/lib/pathUtils.mjs";
import { ensureStepTopologyArtifact } from "cadjs/lib/step/stepArtifactCompiler.mjs";
import { readTextToCadStepMetadataFile } from "cadjs/lib/step/stepMetadata.mjs";

function normalizedFileRef(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

function catalogEntryForFileRef(catalog, fileRef) {
  const normalized = normalizedFileRef(fileRef);
  if (!normalized || !Array.isArray(catalog?.entries)) {
    return null;
  }
  return catalog.entries.find((entry) => normalizedFileRef(entry?.file) === normalized) || null;
}

function ensurePathInsideRoot(filePath, resolvedRoot) {
  if (!(filePath === resolvedRoot.rootPath || pathIsInside(filePath, resolvedRoot.rootPath))) {
    throw new Error("Requested file is outside the active CAD Viewer root");
  }
}

function normalizedFileAssetKind(value) {
  const asset = String(value || "output").trim().toLowerCase();
  if (asset === "asset") {
    return "artifact";
  }
  if (asset === "output" || asset === "source" || asset === "artifact") {
    return asset;
  }
  throw new Error(`Unsupported file asset: ${asset || "(missing)"}`);
}

function fileHasGenStep(filePath) {
  try {
    return /\bgen_step\s*\(/.test(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return false;
  }
}

function sameStemPythonGeneratorPath(stepPath) {
  const extension = path.extname(stepPath).toLowerCase();
  if (extension !== ".step" && extension !== ".stp") {
    return "";
  }
  const candidate = path.join(path.dirname(stepPath), `${path.basename(stepPath, extension)}.py`);
  return fileHasGenStep(candidate) ? candidate : "";
}

function stepArtifactGenerationError(result) {
  const directError = String(result?.error || "").trim();
  if (directError) {
    return directError;
  }
  const validationError = result?.validation?.error;
  const validationMessage = String(validationError?.message || "").trim();
  if (validationMessage) {
    return validationMessage;
  }
  const reason = String(result?.reason || "").trim();
  if (reason) {
    return `STEP artifact was not generated: ${reason}`;
  }
  return "STEP artifact generation failed.";
}

function entryIsPythonBackedStep(entry) {
  const artifactSourceKind = String(entry?.artifact?.sourceKind || "").trim().toLowerCase();
  if (artifactSourceKind === "python") {
    return true;
  }
  const sourceKind = String(entry?.sourceKind || entry?.stepSourceKind || "").trim().toLowerCase();
  if (sourceKind === "python") {
    return true;
  }
  const sourcePath = String(entry?.source?.sourcePath || entry?.source?.file || "").trim().toLowerCase();
  return sourcePath.endsWith(".py");
}

function stepFileHasPythonSourceMetadata(stepPath) {
  try {
    const metadata = readTextToCadStepMetadataFile(stepPath);
    return String(metadata?.sourcePath || "").trim().toLowerCase().endsWith(".py");
  } catch {
    return false;
  }
}

function contentTypeForPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".js" || extension === ".mjs") {
    return "text/javascript; charset=utf-8";
  }
  if (extension === ".json") {
    return "application/json; charset=utf-8";
  }
  if (extension === ".wasm") {
    return "application/wasm";
  }
  if (extension === ".glb") {
    return "model/gltf-binary";
  }
  if (extension === ".stl") {
    return "model/stl";
  }
  if (extension === ".3mf") {
    return "model/3mf";
  }
  if (extension === ".step" || extension === ".stp") {
    return "application/step";
  }
  if (extension === ".dxf") {
    return "application/dxf";
  }
  if (extension === ".gcode" || extension === ".py") {
    return "text/plain; charset=utf-8";
  }
  if (extension === ".urdf" || extension === ".srdf" || extension === ".sdf") {
    return "application/xml; charset=utf-8";
  }
  if (extension === ".svg") {
    return "image/svg+xml";
  }
  if (extension === ".png") {
    return "image/png";
  }
  return "application/octet-stream";
}

function defaultSourceFileOpener(filePath) {
  let command = "";
  let args = [];
  if (process.platform === "darwin") {
    command = "open";
    args = ["-R", filePath];
  } else if (process.platform === "win32") {
    command = "explorer.exe";
    args = [`/select,${filePath}`];
  } else {
    command = "xdg-open";
    args = [path.dirname(filePath)];
  }
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return {
    command,
  };
}

function emptyCatalog() {
  return {
    schemaVersion: CAD_CATALOG_SCHEMA_VERSION,
    entries: [],
  };
}

function normalizeCatalog(catalog) {
  return {
    schemaVersion: CAD_CATALOG_SCHEMA_VERSION,
    entries: Array.isArray(catalog?.entries) ? catalog.entries : [],
  };
}

export function createLocalAssetBackend({
  workspaceRoot,
  rootDir = DEFAULT_VIEWER_ROOT_DIR,
  defaultFile = "",
  githubUrl = "",
  stepArtifactGenerator = ensureStepTopologyArtifact,
  sourceFileOpener = defaultSourceFileOpener,
} = {}) {
  if (!workspaceRoot) {
    throw new Error("createLocalAssetBackend requires workspaceRoot");
  }
  const repoRoot = path.resolve(workspaceRoot);
  const defaultRootDir = normalizeViewerRootDir(rootDir);
  const catalogCache = new Map();

  function resolveRoot(nextRootDir = defaultRootDir) {
    return resolveViewerRoot(repoRoot, nextRootDir);
  }

  function readCatalog({ rootDir: nextRootDir = defaultRootDir } = {}) {
    const normalizedDir = normalizeViewerRootDir(nextRootDir);
    if (!catalogCache.has(normalizedDir)) {
      return refreshCatalog({ rootDir: normalizedDir });
    }
    return catalogCache.get(normalizedDir);
  }

  function readCatalogSafe({ rootDir: nextRootDir = defaultRootDir } = {}) {
    try {
      return readCatalog({ rootDir: nextRootDir });
    } catch {
      return emptyCatalog();
    }
  }

  function refreshCatalog({ rootDir: nextRootDir = defaultRootDir } = {}) {
    const normalizedDir = normalizeViewerRootDir(nextRootDir);
    const catalog = normalizeCatalog(scanCadDirectory({
      repoRoot,
      rootDir: normalizedDir,
      includeArtifactStatus: false,
    }));
    catalogCache.set(normalizedDir, catalog);
    return catalog;
  }

  function replaceCatalogEntry(catalog, fileRef, nextEntry) {
    const normalizedRef = normalizedFileRef(fileRef);
    if (!normalizedRef) {
      return normalizeCatalog(catalog);
    }
    const previousEntries = Array.isArray(catalog?.entries) ? catalog.entries : [];
    const entries = previousEntries.filter((entry) => normalizedFileRef(entry?.file) !== normalizedRef);
    if (nextEntry) {
      entries.push(nextEntry);
    }
    return normalizeCatalog({
      ...catalog,
      entries: sortCatalogEntries(entries),
    });
  }

  function refreshCatalogEntryForFile({ rootDir: nextRootDir = defaultRootDir, filePath } = {}) {
    const normalizedDir = normalizeViewerRootDir(nextRootDir);
    const currentCatalog = readCatalog({ rootDir: normalizedDir });
    const nextEntry = scanCadFile({
      repoRoot,
      rootDir: normalizedDir,
      filePath,
      includeArtifactStatus: false,
    });
    const fileRef = nextEntry?.file || catalogFileRefForPath({ repoRoot, rootDir: normalizedDir, filePath });
    if (!fileRef) {
      return currentCatalog;
    }
    const nextCatalog = replaceCatalogEntry(currentCatalog, fileRef, nextEntry);
    catalogCache.set(normalizedDir, nextCatalog);
    return nextCatalog;
  }

  function refreshCatalogForPythonSource({ rootDir: nextRootDir = defaultRootDir, filePath } = {}) {
    const normalizedDir = normalizeViewerRootDir(nextRootDir);
    const resolvedRoot = resolveRoot(normalizedDir);
    const resolvedFilePath = path.resolve(filePath);
    const sourcePath = repoRelativePath(repoRoot, resolvedFilePath);
    const currentCatalog = readCatalog({ rootDir: normalizedDir });
    const matchingFileRefs = new Set(
      currentCatalog.entries
        .filter((entry) => normalizedFileRef(entry?.source?.sourcePath || entry?.source?.file) === sourcePath)
        .map((entry) => normalizedFileRef(entry.file))
        .filter(Boolean)
    );
    const sameStemStepPath = path.join(path.dirname(resolvedFilePath), `${path.basename(resolvedFilePath, ".py")}.step`);
    if (sameStemStepPath === resolvedRoot.rootPath || pathIsInside(sameStemStepPath, resolvedRoot.rootPath)) {
      const sameStemEntry = scanCadFile({
        repoRoot,
        rootDir: normalizedDir,
        filePath: sameStemStepPath,
        includeArtifactStatus: false,
      });
      const sameStemFileRef = sameStemEntry?.file || catalogFileRefForPath({ repoRoot, rootDir: normalizedDir, filePath: sameStemStepPath });
      if (sameStemEntry || catalogEntryForFileRef(currentCatalog, sameStemFileRef)) {
        matchingFileRefs.add(sameStemFileRef);
      }
    }
    if (!matchingFileRefs.size) {
      return refreshCatalog({ rootDir: normalizedDir });
    }

    let nextCatalog = currentCatalog;
    for (const fileRef of matchingFileRefs) {
      const outputPath = path.resolve(resolvedRoot.rootPath, fileRef);
      nextCatalog = replaceCatalogEntry(
        nextCatalog,
        fileRef,
        scanCadFile({
          repoRoot,
          rootDir: normalizedDir,
          filePath: outputPath,
          includeArtifactStatus: false,
        })
      );
    }
    catalogCache.set(normalizedDir, nextCatalog);
    return nextCatalog;
  }

  function refreshCatalogForPath({ rootDir: nextRootDir = defaultRootDir, filePath } = {}) {
    const extension = path.extname(String(filePath || "")).toLowerCase();
    if (extension === ".py") {
      return refreshCatalogForPythonSource({ rootDir: nextRootDir, filePath });
    }
    return refreshCatalogEntryForFile({ rootDir: nextRootDir, filePath });
  }

  function resolveStepSource(fileRef, { resolvedRoot = resolveRoot(), catalog = null } = {}) {
    const relativeFileRef = normalizedFileRef(fileRef);
    if (!relativeFileRef) {
      throw new Error("Missing STEP file");
    }

    const rawRef = String(fileRef || "").trim().replace(/\\/g, "/");
    const candidates = path.isAbsolute(rawRef)
      ? [
          path.resolve(rawRef),
          path.resolve(resolvedRoot.rootPath, relativeFileRef),
          path.resolve(repoRoot, relativeFileRef),
        ]
      : [
          path.resolve(resolvedRoot.rootPath, relativeFileRef),
          path.resolve(repoRoot, relativeFileRef),
        ];

    for (const candidatePath of [...new Set(candidates)]) {
      if (
        (candidatePath === resolvedRoot.rootPath || pathIsInside(candidatePath, resolvedRoot.rootPath)) &&
        fs.existsSync(candidatePath)
      ) {
        const extension = path.extname(candidatePath).toLowerCase();
        if (extension === ".py") {
          if (!fileHasGenStep(candidatePath)) {
            throw new Error(`Python generator is not a gen_step() source: ${relativeFileRef}`);
          }
          return {
            stepPath: path.join(path.dirname(candidatePath), `${path.basename(candidatePath, extension)}.step`),
            sourcePath: candidatePath,
            skipStepWrite: true,
          };
        }
        if (extension !== ".step" && extension !== ".stp") {
          throw new Error("Only STEP/STP sources or same-stem Python generators can generate STEP topology artifacts");
        }
        const generatorPath = sameStemPythonGeneratorPath(candidatePath);
        return {
          stepPath: candidatePath,
          sourcePath: generatorPath,
          skipStepWrite: Boolean(generatorPath),
        };
      }
    }

    const candidatePath = candidates.find((candidate) => (
      candidate === resolvedRoot.rootPath || pathIsInside(candidate, resolvedRoot.rootPath)
    ));
    if (candidatePath) {
      const extension = path.extname(candidatePath).toLowerCase();
      const generatorPath = sameStemPythonGeneratorPath(candidatePath);
      if ((extension === ".step" || extension === ".stp") && generatorPath) {
        return { stepPath: candidatePath, sourcePath: generatorPath, skipStepWrite: true };
      }
      throw new Error(`STEP file not found: ${relativeFileRef}`);
    }
    throw new Error("Requested STEP file is outside the active CAD Viewer root");
  }

  function resolveStepSourceStatus(fileRef, { resolvedRoot = resolveRoot(), catalog = null } = {}) {
    try {
      return resolveStepSource(fileRef, { resolvedRoot, catalog });
    } catch (error) {
      const relativeFileRef = normalizedFileRef(fileRef);
      if (!relativeFileRef) {
        throw error;
      }
      const rawRef = String(fileRef || "").trim().replace(/\\/g, "/");
      const candidates = path.isAbsolute(rawRef)
        ? [
            path.resolve(rawRef),
            path.resolve(resolvedRoot.rootPath, relativeFileRef),
            path.resolve(repoRoot, relativeFileRef),
          ]
        : [
            path.resolve(resolvedRoot.rootPath, relativeFileRef),
            path.resolve(repoRoot, relativeFileRef),
          ];
      const candidatePath = candidates.find((candidate) => (
        candidate === resolvedRoot.rootPath || pathIsInside(candidate, resolvedRoot.rootPath)
      ));
      if (!candidatePath) {
        throw error;
      }
      const extension = path.extname(candidatePath).toLowerCase();
      if (extension !== ".step" && extension !== ".stp") {
        throw error;
      }
      const generatorPath = sameStemPythonGeneratorPath(candidatePath);
      return {
        stepPath: candidatePath,
        sourcePath: generatorPath,
        skipStepWrite: Boolean(generatorPath),
      };
    }
  }

  function requireCatalogEntryForFileRef(fileRef, {
    resolvedRoot = resolveRoot(),
    rootDir: nextRootDir = defaultRootDir,
    catalog = null,
  } = {}) {
    const relativeFileRef = normalizedFileRef(fileRef);
    if (!relativeFileRef) {
      throw new Error("Missing file");
    }

    const currentCatalog = catalog || readCatalogSafe({ rootDir: nextRootDir });
    const entry = catalogEntryForFileRef(currentCatalog, relativeFileRef);
    if (!entry) {
      throw new Error(`CAD catalog entry not found: ${relativeFileRef}`);
    }
    return { entry, relativeFileRef, currentCatalog, resolvedRoot };
  }

  function resolveOutputFilePath(fileRef, options = {}) {
    const { entry, relativeFileRef, resolvedRoot } = requireCatalogEntryForFileRef(fileRef, options);
    const outputRef = normalizedFileRef(entry?.file || relativeFileRef);
    const outputPath = path.resolve(resolvedRoot.rootPath, outputRef);
    ensurePathInsideRoot(outputPath, resolvedRoot);
    if (!fs.existsSync(outputPath) || !fs.statSync(outputPath).isFile()) {
      throw new Error(`Output file not found: ${outputRef || relativeFileRef}`);
    }
    return outputPath;
  }

  function artifactFileRefFromEntry(entry, rootDir) {
    const rawUrl = String(entry?.url || "").trim();
    if (!rawUrl) {
      throw new Error("Artifact asset is not available for this file");
    }

    let artifactRef = "";
    try {
      artifactRef = normalizedFileRef(new URL(rawUrl, "http://cad.local").pathname);
    } catch {
      artifactRef = normalizedFileRef(rawUrl.split("?")[0]);
    }

    const normalizedRootDir = normalizedFileRef(rootDir);
    if (normalizedRootDir && artifactRef.startsWith(`${normalizedRootDir}/`)) {
      artifactRef = artifactRef.slice(normalizedRootDir.length + 1);
    }
    return artifactRef;
  }

  function resolveArtifactFilePath(fileRef, options = {}) {
    const { entry, relativeFileRef, resolvedRoot } = requireCatalogEntryForFileRef(fileRef, options);
    const artifactRef = artifactFileRefFromEntry(entry, options.rootDir || defaultRootDir);
    if (!artifactRef) {
      throw new Error(`Artifact asset is not available for ${relativeFileRef}`);
    }
    const artifactPath = path.resolve(resolvedRoot.rootPath, artifactRef);
    ensurePathInsideRoot(artifactPath, resolvedRoot);
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
      throw new Error(`Artifact file not found: ${artifactRef}`);
    }
    return artifactPath;
  }

  function resolveSourceCodeFilePath(fileRef, options = {}) {
    const { entry, relativeFileRef, currentCatalog, resolvedRoot } = requireCatalogEntryForFileRef(fileRef, options);
    const explicitSourceRef = normalizedFileRef(entry?.source?.file || entry?.sourceFile || "");
    if (explicitSourceRef) {
      const candidatePaths = [
        path.resolve(resolvedRoot.rootPath, explicitSourceRef),
        path.resolve(repoRoot, explicitSourceRef),
      ];
      for (const sourcePath of [...new Set(candidatePaths)]) {
        if (
          (sourcePath === resolvedRoot.rootPath || pathIsInside(sourcePath, resolvedRoot.rootPath)) &&
          fs.existsSync(sourcePath) &&
          fs.statSync(sourcePath).isFile()
        ) {
          return sourcePath;
        }
      }
    }
    const extension = path.extname(relativeFileRef).toLowerCase();
    if (extension === ".step" || extension === ".stp") {
      const { stepPath, sourcePath } = resolveStepSourceStatus(relativeFileRef, { resolvedRoot, catalog: currentCatalog });
      if (sourcePath && fs.existsSync(sourcePath) && fs.statSync(sourcePath).isFile()) {
        ensurePathInsideRoot(sourcePath, resolvedRoot);
        return sourcePath;
      }
      ensurePathInsideRoot(stepPath, resolvedRoot);
    }

    throw new Error(`Source code is not available for ${relativeFileRef}`);
  }

  function resolveFileAssetAccess({
    fileRef,
    asset = "output",
    resolvedRoot = resolveRoot(),
    rootDir: nextRootDir = defaultRootDir,
    catalog = null,
  } = {}) {
    const assetKind = normalizedFileAssetKind(asset);
    const filePath = assetKind === "source"
      ? resolveSourceCodeFilePath(fileRef, { resolvedRoot, rootDir: nextRootDir, catalog })
      : assetKind === "artifact"
        ? resolveArtifactFilePath(fileRef, { resolvedRoot, rootDir: nextRootDir, catalog })
        : resolveOutputFilePath(fileRef, { resolvedRoot, rootDir: nextRootDir, catalog });
    const file = path.relative(resolvedRoot.rootPath, filePath).split(path.sep).join("/");
    return {
      asset: assetKind,
      file,
      path: filePath,
      filename: path.basename(filePath),
      contentType: contentTypeForPath(filePath),
    };
  }

  async function openFileAsset(request = {}) {
    const access = resolveFileAssetAccess(request);
    await sourceFileOpener(access.path);
    return {
      asset: access.asset,
      file: access.file,
      filename: access.filename,
      opened: true,
    };
  }

  function resolveSourceFileAccess(request = {}) {
    return resolveFileAssetAccess({ ...request, asset: "source" });
  }

  async function openSourceFile(request = {}) {
    return openFileAsset({ ...request, asset: "source" });
  }

  async function generateStepArtifact({ fileRef, force = false, resolvedRoot = resolveRoot(), catalog = null } = {}) {
    const { stepPath, sourcePath, skipStepWrite } = resolveStepSource(fileRef, { resolvedRoot, catalog });
    const relativeFileRef = normalizedFileRef(fileRef);
    const currentCatalog = catalog || readCatalogSafe();
    const entry = catalogEntryForFileRef(currentCatalog, relativeFileRef);
    if (
      sourcePath ||
      entryIsPythonBackedStep(entry) ||
      stepFileHasPythonSourceMetadata(stepPath)
    ) {
      throw new Error(
        "CAD Viewer only regenerates GLB artifacts for imported STEP files. Regenerate Python-backed STEP files with their generator script."
      );
    }
    const result = await stepArtifactGenerator({
      repoRoot,
      stepPath,
      sourcePath,
      force,
      skipStepWrite,
      writeStepAfterArtifact: Boolean(skipStepWrite),
    });
    return {
      ok: Boolean(result?.ok),
      error: result?.ok ? "" : stepArtifactGenerationError(result),
      result,
      stepPath,
    };
  }

  function readStepSourceStatusForFile({ fileRef, resolvedRoot = resolveRoot(), catalog = null } = {}) {
    const { stepPath, sourcePath } = resolveStepSourceStatus(fileRef, { resolvedRoot, catalog });
    return readStepSourceStatus({
      repoRoot,
      stepPath,
      pythonSourcePath: sourcePath,
    });
  }

  function readGeneratorStatus({ rootDir: nextRootDir = defaultRootDir } = {}) {
    return readGenerationStatus({
      repoRoot,
      rootDir: nextRootDir,
    });
  }

  function generatorStatusDir() {
    return resolveGenerationStatusDir(repoRoot, defaultRootDir);
  }

  function entryForSourcePath(catalog, resolvedRoot, sourcePath) {
    const fileRef = path.relative(resolvedRoot.rootPath, sourcePath).split(path.sep).join("/");
    return Array.isArray(catalog?.entries)
      ? catalog.entries.find((entry) => String(entry?.file || "") === fileRef) || null
      : null;
  }

  function assetPathForRequestPath(requestPath, { resolvedRoot = resolveRoot() } = {}) {
    const decodedPath = decodeURIComponent(String(requestPath || "").replace(/\?.*$/, ""));
    const candidatePath = path.resolve(repoRoot, decodedPath.replace(/^\/+/, ""));
    if (!isServedCadAsset(candidatePath)) {
      return null;
    }
    if (!(candidatePath === resolvedRoot.rootPath || pathIsInside(candidatePath, resolvedRoot.rootPath))) {
      const error = new Error("Forbidden");
      error.statusCode = 403;
      throw error;
    }
    return candidatePath;
  }

  async function writeAsset({ fileRef, body, resolvedRoot = resolveRoot() } = {}) {
    const relativeFileRef = normalizedFileRef(fileRef);
    if (!relativeFileRef) {
      throw new Error("Missing asset path");
    }
    const filePath = path.resolve(resolvedRoot.rootPath, relativeFileRef);
    if (!(filePath === resolvedRoot.rootPath || pathIsInside(filePath, resolvedRoot.rootPath))) {
      throw new Error("Asset writes must stay inside the active CAD Viewer root");
    }
    if (!isServedCadAsset(filePath)) {
      throw new Error(`Unsupported CAD Viewer asset write: ${relativeFileRef}`);
    }
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body || "");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, bytes);
    return {
      path: filePath,
      bytes: bytes.length,
      contentType: contentTypeForPath(filePath),
    };
  }

  return {
    kind: "local-fs",
    canGenerateStepArtifacts: true,
    repoRoot,
    rootDir: defaultRootDir,
    resolveRoot,
    readCatalog,
    readCatalogSafe,
    refreshCatalog,
    refreshCatalogForPath,
    resolveStepSource,
    readStepSourceStatus: readStepSourceStatusForFile,
    resolveFileAssetAccess,
    openFileAsset,
    resolveSourceFileAccess,
    openSourceFile,
    readGenerationStatus: readGeneratorStatus,
    generationStatusDir: generatorStatusDir,
    isGenerationStatusPath: (filePath) => isGenerationStatusPath(filePath, repoRoot),
    generateStepArtifact,
    entryForSourcePath,
    assetPathForRequestPath,
    writeAsset,
    contentTypeForPath,
  };
}

export { contentTypeForPath };
