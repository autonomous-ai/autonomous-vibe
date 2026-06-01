import { entryStepSourceKind } from "./entryIconStatus.js";
import {
  normalizeRelativePath as normalizedRelativePath,
  stripViewerRootDirPrefix,
  viewerRootRelativePath
} from "./pathPresentation.js";
import { fileKey } from "./sidebar.js";

function basenameFromFileRef(value) {
  const normalized = normalizedRelativePath(value);
  return normalized.split("/").filter(Boolean).pop() || "";
}

function dirnameFromFileRef(value) {
  const parts = normalizedRelativePath(value).split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function joinRelativePath(...parts) {
  return parts
    .map((part) => normalizedRelativePath(part))
    .filter(Boolean)
    .join("/");
}

function sameStemPythonFilename(value) {
  const filename = basenameFromFileRef(value);
  return filename.replace(/\.(step|stp)$/i, ".py");
}

function sameStemPythonFileRef(value) {
  const dirname = dirnameFromFileRef(value);
  const filename = sameStemPythonFilename(value);
  return joinRelativePath(dirname, filename);
}

function isStepFileRef(value) {
  return /\.(step|stp)$/i.test(normalizedRelativePath(value));
}

function filenameFromUrl(value) {
  try {
    return basenameFromFileRef(new URL(String(value || "")).pathname);
  } catch {
    return "";
  }
}

function explicitSourceFileRef(entry) {
  return (
    normalizedRelativePath(entry?.sourceFile) ||
    normalizedRelativePath(entry?.source?.file) ||
    normalizedRelativePath(entry?.source?.path) ||
    filenameFromUrl(entry?.sourceUrl || entry?.source?.url)
  );
}

function explicitSourceWorkspaceFileRef(entry) {
  return (
    normalizedRelativePath(entry?.sourceWorkspaceFile) ||
    normalizedRelativePath(entry?.source?.workspaceFile) ||
    normalizedRelativePath(entry?.source?.sourcePath)
  );
}

function artifactFileRef(entry, viewerServerInfo = {}) {
  return viewerRootRelativePath(entry?.url, viewerServerInfo, { anchorFile: entry?.file });
}

function localPathSeparator(basePath) {
  return String(basePath || "").includes("\\") ? "\\" : "/";
}

function joinLocalPath(basePath, relativePath) {
  const base = String(basePath || "").trim();
  const relative = normalizedRelativePath(relativePath);
  if (!base || !relative) {
    return base || relative;
  }
  const separator = localPathSeparator(base);
  const normalizedBase = base.replace(/[\\/]+$/, "");
  const normalizedRelative = relative.replace(/\//g, separator);
  return `${normalizedBase}${separator}${normalizedRelative}`;
}

function workspacePathIsInsideViewerRoot(workspaceRelativePath, rootDir) {
  const workspacePath = normalizedRelativePath(workspaceRelativePath);
  const normalizedRootDir = normalizedRelativePath(rootDir);
  if (!workspacePath) {
    return false;
  }
  if (!normalizedRootDir) {
    return true;
  }
  return workspacePath === normalizedRootDir || workspacePath.startsWith(`${normalizedRootDir}/`);
}

function rootRelativePathFromWorkspaceRelativePath(workspaceRelativePath, rootDir) {
  return workspacePathIsInsideViewerRoot(workspaceRelativePath, rootDir)
    ? stripViewerRootDirPrefix(workspaceRelativePath, rootDir)
    : "";
}

export function fileAccessAssetsForEntry(entry, {
  stepSourceStatus = null,
  viewerServerInfo = {},
} = {}) {
  const fileRef = fileKey(entry);
  if (!fileRef) {
    return {
      artifact: null,
      output: null,
      source: null,
    };
  }

  const outputFileRef = viewerRootRelativePath(entry?.file || fileRef, viewerServerInfo) ||
    normalizedRelativePath(entry?.file || fileRef);
  const outputFilename = basenameFromFileRef(outputFileRef);
  const artifactRef = artifactFileRef(entry, viewerServerInfo);
  const artifactFilename = basenameFromFileRef(artifactRef);
  const sourceKind = String(stepSourceStatus?.sourceKind || entryStepSourceKind(entry)).trim().toLowerCase();
  const stepSourcePath = normalizedRelativePath(stepSourceStatus?.sourcePath);
  const explicitSourceRef = explicitSourceFileRef(entry);
  const explicitSourceWorkspaceRef = explicitSourceWorkspaceFileRef(entry);
  const inferredSourceRootRef = sourceKind === "python" && isStepFileRef(outputFileRef)
    ? sameStemPythonFileRef(outputFileRef)
    : "";
  const sourceRef = explicitSourceRef || stepSourcePath || inferredSourceRootRef;
  const sourceWorkspaceRef = stepSourcePath || explicitSourceWorkspaceRef;
  const hasViewerPathContext = Boolean(
    viewerServerInfo?.rootDir ||
    viewerServerInfo?.rootPath ||
    viewerServerInfo?.workspaceRoot
  );
  const sourceRootRef = sourceRef
    ? hasViewerPathContext
      ? (viewerRootRelativePath(sourceRef, viewerServerInfo, { anchorFile: outputFileRef }) || sourceRef)
      : sourceWorkspaceRef ? "" : (explicitSourceRef || inferredSourceRootRef)
    : "";
  const sourceFilename = sourceRootRef || sourceRef
    ? (basenameFromFileRef(sourceRootRef || sourceRef) || sameStemPythonFilename(outputFileRef))
    : "";

  return {
    artifact: artifactFilename ? {
      asset: "artifact",
      fileRef,
      filename: artifactFilename,
      label: artifactFilename,
      rootRelativePath: artifactRef,
    } : null,
    output: {
      asset: "output",
      fileRef,
      filename: outputFilename || "download",
      label: outputFilename || "download",
      rootRelativePath: outputFileRef,
    },
    source: sourceFilename ? {
      asset: "source",
      fileRef,
      filename: sourceFilename,
      label: sourceFilename,
      rootRelativePath: sourceRootRef,
      workspaceRelativePath: sourceWorkspaceRef,
    } : null,
  };
}

export function downloadUrlForFileAsset(fileRef, asset = "output", baseUrl = "") {
  const path = `/__cad/download?file=${encodeURIComponent(fileRef)}&asset=${encodeURIComponent(asset || "output")}`;
  if (!baseUrl) {
    return path;
  }
  try {
    return new URL(path, baseUrl).toString();
  } catch {
    return path;
  }
}

export function openUrlForFileAsset(fileRef, asset = "output", baseUrl = "") {
  const path = `/__cad/reveal?file=${encodeURIComponent(fileRef)}&asset=${encodeURIComponent(asset || "output")}`;
  if (!baseUrl) {
    return path;
  }
  try {
    return new URL(path, baseUrl).toString();
  } catch {
    return path;
  }
}

export function copyTargetsForFileAccessAsset(asset, viewerServerInfo = {}) {
  const rootDir = normalizedRelativePath(viewerServerInfo?.rootDir);
  const workspaceRelativePath = normalizedRelativePath(asset?.workspaceRelativePath);
  const workspaceRootRelativePath = rootRelativePathFromWorkspaceRelativePath(workspaceRelativePath, rootDir);
  const rawRootRelativePath = workspaceRootRelativePath || normalizedRelativePath(asset?.rootRelativePath);
  const rootRelativePath = rawRootRelativePath
    ? viewerRootRelativePath(rawRootRelativePath, viewerServerInfo, { anchorFile: asset?.fileRef })
    : "";
  const relativePath = rootRelativePath || workspaceRelativePath;
  const absolutePath = rootRelativePath && viewerServerInfo?.rootPath
      ? joinLocalPath(viewerServerInfo.rootPath, rootRelativePath)
      : workspaceRelativePath && viewerServerInfo?.workspaceRoot
        ? joinLocalPath(viewerServerInfo.workspaceRoot, workspaceRelativePath)
        : "";

  return {
    path: absolutePath,
    relativePath,
  };
}
