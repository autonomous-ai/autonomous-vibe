import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { transform as esbuildTransform } from "esbuild";
import react from "@vitejs/plugin-react";
import {
  isCatalogRelevantPath,
} from "cadjs/lib/cadDirectoryScanner.mjs";
import {
  normalizeViewerDefaultFile,
  normalizeViewerGithubUrl,
} from "cadjs/lib/viewerConfig.mjs";
import {
  DEFAULT_VIEWER_PORT,
  buildViewerServerInfo,
  normalizeViewerPort,
} from "cadjs/lib/viewerServerInfo.mjs";
import {
  removeViewerServerRegistryEntry,
  writeViewerServerRegistry,
} from "cadjs/lib/viewerServerRegistry.mjs";
import {
  pathIsInside,
  resolveWorkspaceRoot as resolveViewerWorkspaceRoot,
} from "cadjs/lib/pathUtils.mjs";
import { createLocalAssetBackend } from "./src/server/localAssetBackend.mjs";
import {
  createCadViewerApiMiddleware,
  createLocalAssetMiddleware,
} from "./src/server/httpHandlers.mjs";
import {
  localRootDirFromEnv,
  normalizeViewerAssetBackend,
  rootDirForAssetBackend,
} from "./src/server/viewerEnv.mjs";
import {
  normalizeServerLifetimeMs,
  scheduleProcessShutdown,
} from "./src/server/serverLifetime.mjs";

const viewerPort = normalizeViewerPort(process.env.VIEWER_PORT, DEFAULT_VIEWER_PORT);
const viewerAppRoot = path.dirname(fileURLToPath(import.meta.url));
const viewerClientRoot = path.join(viewerAppRoot, "src", "client");
const cadJsPackageRoot = resolveCadJsPackageRoot();
const viewerNodeModulesRoot = path.join(viewerAppRoot, "node_modules");
const defaultWorkspaceRoot = path.resolve(viewerAppRoot, "..");
const workspaceRoot = resolveWorkspaceRoot();
const repoRoot = workspaceRoot;
const buildViewerAssetBackend = normalizeViewerAssetBackend(process.env.VIEWER_ASSET_BACKEND);
const buildViewerRootDir = rootDirForAssetBackend(buildViewerAssetBackend, process.env);
const buildViewerDefaultFile = normalizeViewerDefaultFile(process.env.VIEWER_DEFAULT_FILE ?? "");
const buildViewerGithubUrl = normalizeViewerGithubUrl(process.env.VIEWER_GITHUB_URL ?? "");
const viewerAllowedHosts = normalizeViewerAllowedHosts(process.env.VIEWER_ALLOWED_HOSTS ?? "");
const viewerServerLifetimeMs = normalizeServerLifetimeMs(process.env.VIEWER_SERVER_LIFETIME_MS);
const localAssetBackend = createLocalAssetBackend({
  workspaceRoot,
  rootDir: localRootDirFromEnv(process.env),
  defaultFile: buildViewerDefaultFile,
  githubUrl: buildViewerGithubUrl,
});

function normalizeViewerAllowedHosts(value) {
  return String(value || "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
}

function findRootPackageSrc(packageDirName) {
  let current = viewerAppRoot;
  for (;;) {
    const candidate = path.join(current, "packages", packageDirName, "src");
    if (
      fs.existsSync(candidate) &&
      fs.existsSync(path.join(current, "packages", packageDirName, "package.json"))
    ) {
      return candidate;
    }
    const next = path.dirname(current);
    if (next === current) {
      return "";
    }
    current = next;
  }
}

function resolveCadJsPackageRoot() {
  const installedPackageSrc = path.join(viewerAppRoot, "node_modules", "cadjs", "src");
  if (fs.existsSync(installedPackageSrc)) {
    return installedPackageSrc;
  }
  const rootPackageSrc = findRootPackageSrc("cadjs");
  return rootPackageSrc || path.resolve(viewerAppRoot, "../packages/cadjs/src");
}

function resolveWorkspaceRoot() {
  return resolveViewerWorkspaceRoot({
    env: process.env,
    cwd: process.cwd(),
    appRoot: viewerAppRoot,
    defaultWorkspaceRoot,
  });
}

function viteServerPort(server) {
  const address = server?.httpServer?.address?.();
  return address && typeof address === "object" && Number.isInteger(address.port)
    ? address.port
    : viewerPort;
}

function cadCatalogPlugin({ enableStepArtifactBackend = false } = {}) {
  const activeDirectories = new Map();
  const refreshTimers = new Map();
  const pendingRefreshes = new Map();

  function activateDirectory(server, rootDir) {
    const resolved = localAssetBackend.resolveRoot(rootDir);
    const wasActive = activeDirectories.has(resolved.rootPath);
    activeDirectories.set(resolved.rootPath, resolved.dir);
    if (!wasActive) {
      server.watcher.add(resolved.rootPath);
    }
    return resolved;
  }

  function scheduleCatalogRefresh(server, rootPath, dir, changedPath = "") {
    if (refreshTimers.has(rootPath)) {
      clearTimeout(refreshTimers.get(rootPath));
    }
    const pending = pendingRefreshes.get(rootPath) || {
      dir,
      paths: new Set(),
      full: false,
    };
    pending.dir = dir;
    if (changedPath) {
      pending.paths.add(path.resolve(changedPath));
    } else {
      pending.full = true;
    }
    pendingRefreshes.set(rootPath, pending);
    refreshTimers.set(rootPath, setTimeout(() => {
      refreshTimers.delete(rootPath);
      const nextRefresh = pendingRefreshes.get(rootPath) || {
        dir,
        paths: new Set(),
        full: true,
      };
      pendingRefreshes.delete(rootPath);
      try {
        if (nextRefresh.full || typeof localAssetBackend.refreshCatalogForPath !== "function") {
          localAssetBackend.refreshCatalog({ rootDir: nextRefresh.dir });
        } else {
          for (const filePath of nextRefresh.paths) {
            localAssetBackend.refreshCatalogForPath({
              rootDir: nextRefresh.dir,
              filePath,
            });
          }
        }
      } catch (error) {
        console.warn("Failed to refresh CAD catalog", error);
      }
      server.ws.send({
        type: "custom",
        event: "cad-catalog:changed",
        data: { dir: nextRefresh.dir },
      });
    }, 150));
  }

  function notifyChangedPath(server, changedPath) {
    const resolvedChangedPath = path.resolve(changedPath);
    if (localAssetBackend.isGenerationStatusPath?.(resolvedChangedPath)) {
      server.ws.send({
        type: "custom",
        event: "cad-generation-status:changed",
      });
      return;
    }
    if (!isCatalogRelevantPath(resolvedChangedPath)) {
      return;
    }
    for (const [rootPath, dir] of activeDirectories.entries()) {
      if (resolvedChangedPath === rootPath || pathIsInside(resolvedChangedPath, rootPath)) {
        scheduleCatalogRefresh(server, rootPath, dir, resolvedChangedPath);
      }
    }
  }

  return {
    name: "cad-catalog",
    configureServer(server) {
      const servedViewerRoot = activateDirectory(server, buildViewerRootDir);
      server.watcher.add(localAssetBackend.generationStatusDir());
      localAssetBackend.refreshCatalog({ rootDir: buildViewerRootDir });
      let activeServerInfo = null;
      const currentServerInfo = () => {
        activeServerInfo = buildViewerServerInfo({
          workspaceRoot: repoRoot,
          rootDir: buildViewerRootDir,
          port: viteServerPort(server),
          pid: process.pid,
        });
        return activeServerInfo;
      };
      const registerServer = () => {
        writeViewerServerRegistry(currentServerInfo());
      };
      if (server.httpServer?.listening) {
        registerServer();
      } else {
        server.httpServer?.once("listening", registerServer);
      }
      server.httpServer?.once("close", () => {
        removeViewerServerRegistryEntry(activeServerInfo || currentServerInfo());
      });
      server.middlewares.use(createCadViewerApiMiddleware({
        backend: localAssetBackend,
        rootDir: buildViewerRootDir,
        enableStepArtifactBackend,
        serverInfo: currentServerInfo,
        onCatalogChanged: (resolvedRoot) => {
          scheduleCatalogRefresh(server, resolvedRoot.rootPath, resolvedRoot.dir);
        },
      }));
      server.middlewares.use(createLocalAssetMiddleware({
        backend: localAssetBackend,
        rootDir: servedViewerRoot.dir,
      }));
      for (const eventName of ["add", "change", "unlink"]) {
        server.watcher.on(eventName, (changedPath) => notifyChangedPath(server, changedPath));
      }
    },
  };
}

// Panda owns a handful of .ts/.tsx sources (transport + zustand stores).
// The viewer's existing esbuild config has `loader: "jsx"` over all .[jt]sx?
// files, which does not strip TypeScript type syntax. This tiny plugin
// runs esbuild with the proper TS loader for those files so they make it
// through rollup. Track C's Tauri command bindings live in TypeScript too.
function typescriptSourcePlugin() {
  return {
    name: "panda-typescript-source",
    enforce: "pre",
    async transform(code, id) {
      const queryless = id.split("?", 1)[0];
      if (!/\.(ts|tsx)$/.test(queryless)) {
        return null;
      }
      const result = await esbuildTransform(code, {
        loader: queryless.endsWith("x") ? "tsx" : "ts",
        sourcefile: id,
        sourcemap: true,
        target: "es2020",
        jsx: "automatic",
      });
      return {
        code: result.code,
        map: result.map || null,
      };
    },
  };
}

function serverLifetimePlugin() {
  return {
    name: "cad-viewer-server-lifetime",
    configureServer(server) {
      if (viewerServerLifetimeMs === null) {
        return;
      }
      let shutdownTimer = null;
      const scheduleShutdown = () => {
        shutdownTimer = scheduleProcessShutdown({
          lifetimeMs: viewerServerLifetimeMs,
          label: "CAD Viewer dev server",
          close: () => server.close(),
        });
      };
      if (server.httpServer?.listening) {
        scheduleShutdown();
      } else {
        server.httpServer?.once("listening", scheduleShutdown);
      }
      server.httpServer?.once("close", () => {
        if (shutdownTimer) {
          clearTimeout(shutdownTimer);
        }
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  root: viewerAppRoot,
  envPrefix: "VIEWER_",
  plugins: [
    typescriptSourcePlugin(),
    react(),
    cadCatalogPlugin({ enableStepArtifactBackend: command === "serve" }),
    serverLifetimePlugin(),
  ],
  resolve: {
    alias: {
      "@": viewerClientRoot,
      "cadjs": cadJsPackageRoot,
      "clsx": path.join(viewerNodeModulesRoot, "clsx"),
      "gifenc": path.join(viewerNodeModulesRoot, "gifenc", "dist", "gifenc.esm.js"),
      "tailwind-merge": path.join(viewerNodeModulesRoot, "tailwind-merge"),
      "three": path.join(viewerNodeModulesRoot, "three"),
      "three/examples": path.join(viewerNodeModulesRoot, "three", "examples"),
    },
  },
  esbuild: {
    loader: "jsx",
    include: /\.jsx?$/,
    exclude: [],
  },
  optimizeDeps: {
    esbuildOptions: {
      loader: {
        ".js": "jsx",
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined;
          }
          if (id.includes("/three/")) {
            return "vendor-three";
          }
          if (id.includes("/react/") || id.includes("/react-dom/")) {
            return "vendor-react";
          }
          if (id.includes("/radix-ui/") || id.includes("/@radix-ui/")) {
            return "vendor-ui";
          }
          if (id.includes("/lucide-react/")) {
            return "vendor-icons";
          }
          return undefined;
        },
      },
    },
  },
  worker: {
    format: "es",
  },
  server: {
    host: "127.0.0.1",
    port: viewerPort,
    strictPort: true,
    allowedHosts: viewerAllowedHosts,
    watch: {
      // Never watch Rust build output. The viewer dev server watches the
      // workspace root for CAD-artifact changes (see serverLifetimePlugin's
      // `watcher.add`); bundling skills/ as a Tauri resource makes the build
      // copy them — including cad-viewer's vendored web viewer (index.html +
      // cadjs) — into desktop/src-tauri/target/, and watching that triggers
      // spurious full-page reloads in the Tauri webview.
      ignored: ["**/target/**"],
    },
  },
  preview: {
    host: "127.0.0.1",
    port: viewerPort,
    strictPort: true,
    allowedHosts: viewerAllowedHosts,
  },
}));
