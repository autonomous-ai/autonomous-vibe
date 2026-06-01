import path from "node:path";

import {
  DEFAULT_VIEWER_ROOT_DIR,
  normalizeViewerRootDir,
  resolveViewerRoot,
} from "./cadDirectoryScanner.mjs";

export const VIEWER_SERVER_INFO_SCHEMA_VERSION = 1;
export const VIEWER_SERVER_APP_ID = "cad-viewer";
export const DEFAULT_VIEWER_HOST = "127.0.0.1";
export const DEFAULT_VIEWER_PORT = 4178;

export function normalizeViewerPort(value, fallback = DEFAULT_VIEWER_PORT) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
    return parsed;
  }
  return fallback;
}

export function buildViewerServerInfo({
  workspaceRoot,
  rootDir = DEFAULT_VIEWER_ROOT_DIR,
  port = DEFAULT_VIEWER_PORT,
  pid = process.pid,
  host = DEFAULT_VIEWER_HOST,
} = {}) {
  if (!workspaceRoot) {
    throw new Error("workspaceRoot is required");
  }
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const normalizedRootDir = normalizeViewerRootDir(rootDir);
  const resolvedViewerRoot = resolveViewerRoot(resolvedWorkspaceRoot, normalizedRootDir);
  const normalizedPort = normalizeViewerPort(port);
  return {
    schemaVersion: VIEWER_SERVER_INFO_SCHEMA_VERSION,
    app: VIEWER_SERVER_APP_ID,
    workspaceRoot: resolvedWorkspaceRoot,
    rootDir: resolvedViewerRoot.dir,
    rootPath: resolvedViewerRoot.rootPath,
    port: normalizedPort,
    pid: Number.isInteger(pid) ? pid : process.pid,
    url: `http://${host}:${normalizedPort}`,
  };
}

export function isViewerServerInfo(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    value.app === VIEWER_SERVER_APP_ID &&
    typeof value.rootPath === "string" &&
    Number.isInteger(value.port)
  );
}
