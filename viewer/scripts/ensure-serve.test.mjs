import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_SERVER_LIFETIME_MS,
  buildProductionSpawnOptions,
  catalogHasFile,
  parseEnsureServeArgs,
  parseServerLifetimeMs,
  resolveEnsureServeRequest,
  resolveRootDir,
  selectViewerServer,
} from "./ensure-serve.mjs";

test("parseEnsureServeArgs accepts root-dir launcher option", () => {
  assert.deepEqual(
    parseEnsureServeArgs([
      "--root-dir", "/tmp/viewer-root",
      "--file", "sample.step",
      "--port=4180",
      "--port-end", "4188",
      "--shutdown-after", "2h",
      "--json",
    ]),
    {
      rootDir: "/tmp/viewer-root",
      file: "sample.step",
      port: 4180,
      portEnd: 4188,
      shutdownAfterMs: 2 * 60 * 60 * 1000,
      json: true,
      help: false,
    }
  );
});

test("parseServerLifetimeMs accepts explicit durations and rejects invalid values", () => {
  assert.equal(parseServerLifetimeMs("750"), 750);
  assert.equal(parseServerLifetimeMs("45s"), 45_000);
  assert.equal(parseServerLifetimeMs("1.5h"), 90 * 60 * 1000);
  assert.throws(() => parseServerLifetimeMs("0"), /between 1ms/);
  assert.throws(() => parseServerLifetimeMs("forever"), /positive duration/);
});

test("parseEnsureServeArgs requires root-dir", () => {
  assert.throws(
    () => parseEnsureServeArgs(["--file", "sample.step"]),
    /--root-dir is required/
  );
  assert.doesNotThrow(() => parseEnsureServeArgs(["--help"]));
});

test("parseEnsureServeArgs rejects repeated file flags", () => {
  assert.throws(
    () => parseEnsureServeArgs(["--file", "first.step", "--file", "second.step"]),
    /--file may only be provided once/
  );
  assert.throws(
    () => parseEnsureServeArgs(["--file=first.step", "--file=second.step"]),
    /--file may only be provided once/
  );
});

test("resolveRootDir resolves explicit roots from INIT_CWD before npm prefix cwd", () => {
  assert.equal(
    resolveRootDir({
      rootDir: "models",
      cwd: "/tmp/repo/viewer",
      env: { INIT_CWD: "/tmp/repo" },
      appRoot: "/tmp/repo/viewer",
    }),
    path.resolve("/tmp/repo/models")
  );
});

test("resolveEnsureServeRequest uses the default shutdown lifetime unless specified", () => {
  const defaultRequest = resolveEnsureServeRequest({
    options: {
      rootDir: "models",
    },
    cwd: "/tmp/repo/viewer",
    env: { INIT_CWD: "/tmp/repo" },
    appRoot: "/tmp/repo/viewer",
  });
  assert.equal(defaultRequest.shutdownAfterMs, DEFAULT_SERVER_LIFETIME_MS);

  const explicitRequest = resolveEnsureServeRequest({
    options: {
      rootDir: "models",
      shutdownAfterMs: 5000,
    },
    cwd: "/tmp/repo/viewer",
    env: { INIT_CWD: "/tmp/repo" },
    appRoot: "/tmp/repo/viewer",
  });
  assert.equal(explicitRequest.shutdownAfterMs, 5000);
});

test("catalogHasFile matches normalized catalog file refs", () => {
  assert.equal(catalogHasFile({ entries: [{ file: "models/part.step" }] }, "models/part.step"), true);
  assert.equal(catalogHasFile({ entries: [{ file: "models/part.step" }] }, "/models\\part.step"), true);
  assert.equal(catalogHasFile({ entries: [{ file: "models/part.step" }] }, "other.step"), false);
});

test("selectViewerServer skips matching roots that cannot serve the requested file", async () => {
  const rootPath = path.resolve("/tmp/work-a");
  const selection = await selectViewerServer({
    rootPath,
    fileParam: "arm.step",
    port: 4178,
    portEnd: 4179,
    probeServer: async (port) => port === 4178
      ? { app: "cad-viewer", rootPath, port, url: "http://127.0.0.1:4178" }
      : null,
    probeCatalogForFile: async () => false,
    canBind: async (port) => port === 4179,
  });

  assert.equal(selection.action, "start");
  assert.equal(selection.port, 4179);
});

test("selectViewerServer does not reuse stale registry-only matches when another port can bind", async () => {
  const rootPath = path.resolve("/tmp/work-a");
  const selection = await selectViewerServer({
    rootPath,
    port: 4178,
    portEnd: 4179,
    probeServer: async () => null,
    canBind: async (port) => port === 4179,
    registeredServers: [
      { app: "cad-viewer", rootPath, port: 4178, pid: process.pid, url: "http://127.0.0.1:4178" }
    ],
  });

  assert.equal(selection.action, "start");
  assert.equal(selection.port, 4179);
});

test("selectViewerServer reuses registered viewers when probes and binding are permission-blocked", async () => {
  const rootPath = path.resolve("/tmp/work-a");
  const selection = await selectViewerServer({
    rootPath,
    port: 4178,
    portEnd: 4180,
    probeServer: async () => null,
    canBind: async () => ({ canBind: false, errorCode: "EPERM" }),
    registeredServers: [
      { app: "cad-viewer", rootPath, port: 4180, pid: process.pid, url: "http://127.0.0.1:4180" }
    ],
  });

  assert.equal(selection.action, "reuse");
  assert.equal(selection.port, 4180);
});

test("buildProductionSpawnOptions passes default and explicit shutdown lifetimes", () => {
  const defaultOptions = buildProductionSpawnOptions({
    rootDir: "/tmp/workspace-root/models",
    port: 4182,
    env: {
      PATH: "/bin",
      VIEWER_LOCAL_WORKSPACE_ROOT: "/tmp/legacy-root",
      VIEWER_SERVER_LIFETIME_MS: "1",
    },
  });
  assert.equal(defaultOptions.options.env.VIEWER_ASSET_BACKEND, "local-fs");
  assert.equal("VIEWER_LOCAL_WORKSPACE_ROOT" in defaultOptions.options.env, false);
  assert.equal(defaultOptions.options.env.VIEWER_LOCAL_ROOT_DIR, "/tmp/workspace-root/models");
  assert.equal(defaultOptions.options.env.VIEWER_PORT, "4182");
  assert.equal(defaultOptions.options.env.VIEWER_SERVER_LIFETIME_MS, String(DEFAULT_SERVER_LIFETIME_MS));

  const explicitOptions = buildProductionSpawnOptions({
    rootDir: "/tmp/workspace-root/models",
    port: 4182,
    shutdownAfterMs: 60_000,
    env: { PATH: "/bin" },
  });
  assert.equal(explicitOptions.options.env.VIEWER_SERVER_LIFETIME_MS, "60000");
});
