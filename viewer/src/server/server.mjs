#!/usr/bin/env node
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLocalAssetBackend } from "./localAssetBackend.mjs";
import {
  buildHostedViewerServerInfo,
} from "./vercelApi.mjs";
import { createVercelBlobAssetBackend } from "./vercelBlobAssetBackend.mjs";
import {
  createCadViewerApiMiddleware,
  createLocalAssetMiddleware,
  serveDistAsset,
} from "./httpHandlers.mjs";
import {
  DEFAULT_VIEWER_PORT,
  buildViewerServerInfo,
  normalizeViewerPort,
} from "cadjs/lib/viewerServerInfo.mjs";
import {
  normalizeViewerDefaultFile,
  normalizeViewerGithubUrl,
} from "cadjs/lib/viewerConfig.mjs";
import { resolveWorkspaceRoot } from "cadjs/lib/pathUtils.mjs";
import {
  normalizeViewerAssetBackend,
  rootDirForAssetBackend,
  vercelBlobConfigFromEnv,
  VIEWER_ASSET_BACKENDS,
} from "./viewerEnv.mjs";
import {
  closeHttpServer,
  normalizeServerLifetimeMs,
  scheduleProcessShutdown,
} from "./serverLifetime.mjs";

const serverModuleDir = path.dirname(fileURLToPath(import.meta.url));
const viewerAppRoot = path.basename(path.dirname(serverModuleDir)) === "src"
  ? path.resolve(serverModuleDir, "..", "..")
  : path.resolve(serverModuleDir, "..");
const defaultWorkspaceRoot = path.resolve(viewerAppRoot, "..");
const workspaceRoot = resolveWorkspaceRoot({
  env: process.env,
  cwd: process.cwd(),
  appRoot: viewerAppRoot,
  defaultWorkspaceRoot,
});
const backendKind = normalizeViewerAssetBackend(process.env.VIEWER_ASSET_BACKEND);
const rootDir = rootDirForAssetBackend(backendKind, process.env);
const port = normalizeViewerPort(process.env.VIEWER_PORT, DEFAULT_VIEWER_PORT);
const host = process.env.VIEWER_HOST || "127.0.0.1";
const serverLifetimeMs = normalizeServerLifetimeMs(process.env.VIEWER_SERVER_LIFETIME_MS);
const distRoot = path.resolve(viewerAppRoot, "dist");
const backend = backendKind === VIEWER_ASSET_BACKENDS.VERCEL_BLOB
  ? createVercelBlobAssetBackend({
      ...vercelBlobConfigFromEnv(process.env),
      readOnly: true,
    })
  : createLocalAssetBackend({
      workspaceRoot,
      rootDir,
      defaultFile: normalizeViewerDefaultFile(process.env.VIEWER_DEFAULT_FILE || ""),
      githubUrl: normalizeViewerGithubUrl(process.env.VIEWER_GITHUB_URL || ""),
    });
const localAssetBackendEnabled = backend.kind === "local-fs";
const stepArtifactBackendEnabled = localAssetBackendEnabled && typeof backend.generateStepArtifact === "function";

if (localAssetBackendEnabled && typeof backend.refreshCatalog === "function") {
  backend.refreshCatalog({ rootDir });
}

const middlewares = [
  createCadViewerApiMiddleware({
    backend,
    rootDir,
    enableStepArtifactBackend: stepArtifactBackendEnabled,
    claimDisabledStepArtifactRoute: true,
    serverInfo: () => (
      localAssetBackendEnabled
        ? buildViewerServerInfo({
            workspaceRoot,
            rootDir,
            port,
            pid: process.pid,
          })
        : buildHostedViewerServerInfo({ backend, env: process.env, rootDir })
    ),
  }),
  ...(localAssetBackendEnabled ? [createLocalAssetMiddleware({ backend, rootDir })] : []),
  serveDistAsset({ distRoot }),
];

function runMiddleware(index, req, res) {
  const middleware = middlewares[index];
  if (!middleware) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }
  middleware(req, res, () => runMiddleware(index + 1, req, res));
}

const server = http.createServer((req, res) => runMiddleware(0, req, res));

server.listen(port, host, () => {
  console.log(`CAD Viewer backend listening on http://${host}:${port}/ (${backend.kind})`);
  if (serverLifetimeMs !== null) {
    scheduleProcessShutdown({
      lifetimeMs: serverLifetimeMs,
      label: "CAD Viewer backend",
      close: () => closeHttpServer(server),
    });
  }
});
