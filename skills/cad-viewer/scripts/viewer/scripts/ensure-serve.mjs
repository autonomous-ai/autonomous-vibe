#!/usr/bin/env node

// viewer/scripts/ensure-serve.mjs
import { spawn } from "node:child_process";
import fs2 from "node:fs";
import http from "node:http";
import net from "node:net";
import path3 from "node:path";
import { fileURLToPath } from "node:url";

// viewer/packages/cadjs/src/lib/pathUtils.mjs
import path from "node:path";
function toPosixPath(value) {
  return String(value || "").split(path.sep).join("/");
}
function encodePathParam(value) {
  return toPosixPath(value).split("/").map((part) => encodeURIComponent(part)).join("/");
}
function relativePathStaysInsideRoot(relativePath) {
  return relativePath === "" || relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}
function pathIsInside(childPath, parentPath) {
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return Boolean(relativePath) && relativePathStaysInsideRoot(relativePath);
}
function pathIsInsideOrEqual(childPath, parentPath) {
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relativePathStaysInsideRoot(relativePath);
}
function resolveWorkspaceRoot({
  workspaceRoot = "",
  env = process.env,
  cwd = process.cwd(),
  appRoot = "",
  defaultWorkspaceRoot: defaultWorkspaceRoot2 = ""
} = {}) {
  const explicitRoot = workspaceRoot || env.VIEWER_LOCAL_WORKSPACE_ROOT || "";
  if (explicitRoot) {
    return path.resolve(cwd, explicitRoot);
  }
  const resolvedAppRoot = appRoot ? path.resolve(appRoot) : "";
  for (const candidate of [env.INIT_CWD, cwd]) {
    if (!candidate) {
      continue;
    }
    const resolvedCandidate = path.resolve(candidate);
    if (!resolvedAppRoot || resolvedCandidate !== resolvedAppRoot && !pathIsInside(resolvedCandidate, resolvedAppRoot)) {
      return resolvedCandidate;
    }
  }
  return defaultWorkspaceRoot2 ? path.resolve(defaultWorkspaceRoot2) : path.resolve(cwd);
}

// viewer/packages/cadjs/src/lib/viewerServerInfo.mjs
var VIEWER_SERVER_APP_ID = "cad-viewer";
var DEFAULT_VIEWER_HOST = "127.0.0.1";
var DEFAULT_VIEWER_PORT = 4178;
function normalizeViewerPort(value, fallback = DEFAULT_VIEWER_PORT) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
    return parsed;
  }
  return fallback;
}
function isViewerServerInfo(value) {
  return Boolean(
    value && typeof value === "object" && value.app === VIEWER_SERVER_APP_ID && typeof value.rootPath === "string" && Number.isInteger(value.port)
  );
}

// viewer/packages/cadjs/src/lib/viewerServerRegistry.mjs
import fs from "node:fs";
import os from "node:os";
import path2 from "node:path";
var VIEWER_SERVER_REGISTRY_VERSION = 1;
var VIEWER_SERVER_REGISTRY_FILENAME = "cad-viewer-servers.json";
function viewerServerRegistryPath(env = process.env) {
  const configuredPath = String(env.VIEWER_SERVER_REGISTRY || "").trim();
  return configuredPath ? path2.resolve(configuredPath) : path2.join(os.tmpdir(), VIEWER_SERVER_REGISTRY_FILENAME);
}
function viewerServerProcessIsAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return false;
  }
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
function normalizeRegistryServers(payload) {
  const sourceServers = Array.isArray(payload) ? payload : Array.isArray(payload?.servers) ? payload.servers : [];
  return sourceServers.map((server) => ({
    ...server,
    port: Number(server?.port),
    pid: Number(server?.pid)
  })).filter((server) => isViewerServerInfo(server)).sort((a, b) => a.port - b.port);
}
function readViewerServerRegistry({
  registryPath = viewerServerRegistryPath(),
  includeDead = false
} = {}) {
  try {
    const payload = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    return normalizeRegistryServers(payload).filter((server) => includeDead || viewerServerProcessIsAlive(server.pid));
  } catch {
    return [];
  }
}
function writeRegistryServers(servers, registryPath) {
  const payload = {
    version: VIEWER_SERVER_REGISTRY_VERSION,
    servers
  };
  fs.mkdirSync(path2.dirname(registryPath), { recursive: true });
  const tempPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}
`);
  fs.renameSync(tempPath, registryPath);
}
function writeViewerServerRegistry(serverInfo, {
  registryPath = viewerServerRegistryPath()
} = {}) {
  if (!isViewerServerInfo(serverInfo)) {
    return false;
  }
  try {
    const currentServers = readViewerServerRegistry({ registryPath });
    const nextServers = currentServers.filter((server) => server.port !== serverInfo.port && server.pid !== serverInfo.pid).concat({
      ...serverInfo,
      registeredAt: (/* @__PURE__ */ new Date()).toISOString()
    }).sort((a, b) => a.port - b.port);
    writeRegistryServers(nextServers, registryPath);
    return true;
  } catch {
    return false;
  }
}

// viewer/scripts/ensure-serve.mjs
var DEFAULT_PORT_END = 4198;
var DEFAULT_ADAPTIVE_PORT_COUNT = 80;
var DEFAULT_PROBE_TIMEOUT_MS = 200;
var DEFAULT_START_TIMEOUT_MS = 3e4;
var DEFAULT_READY_INTERVAL_MS = 100;
var DEFAULT_SERVER_LIFETIME_MS = 12 * 60 * 60 * 1e3;
var MAX_SERVER_LIFETIME_MS = 2147483647;
var scriptPath = fileURLToPath(import.meta.url);
var viewerAppRoot = path3.resolve(path3.dirname(scriptPath), "..");
var defaultWorkspaceRoot = path3.resolve(viewerAppRoot, "..");
var sourceServerEntryPath = path3.join(viewerAppRoot, "src", "server", "server.mjs");
var serverEntryPath = fs2.existsSync(sourceServerEntryPath) ? sourceServerEntryPath : path3.join(viewerAppRoot, "backend", "server.mjs");
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function parseRequiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}
function parsePort(value, flag) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`${flag} must be a TCP port from 1 to 65535`);
  }
  return parsed;
}
function parseServerLifetimeMs(value, flag = "--shutdown-after") {
  const rawValue = String(value ?? "").trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(rawValue);
  if (!match) {
    throw new Error(`${flag} must be a positive duration such as 30m, 2h, or 43200000.`);
  }
  const amount = Number.parseFloat(match[1]);
  const unit = match[2] || "ms";
  const multiplier = {
    ms: 1,
    s: 1e3,
    m: 60 * 1e3,
    h: 60 * 60 * 1e3
  }[unit];
  const parsed = Math.round(amount * multiplier);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_SERVER_LIFETIME_MS) {
    throw new Error(`${flag} must be between 1ms and ${MAX_SERVER_LIFETIME_MS}ms.`);
  }
  return parsed;
}
function requireRootDirOption(options) {
  if (!options.help && !String(options.rootDir || "").trim()) {
    throw new Error("--root-dir is required; pass the project root directory that owns the model files.");
  }
}
function parseEnsureServeArgs(argv = []) {
  const options = {
    rootDir: "",
    file: "",
    port: null,
    portEnd: null,
    shutdownAfterMs: DEFAULT_SERVER_LIFETIME_MS,
    json: false,
    help: false
  };
  let fileSeen = false;
  function setFile(value) {
    if (fileSeen) {
      throw new Error("--file may only be provided once; run serve:ensure once per file.");
    }
    fileSeen = true;
    options.file = value;
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg.startsWith("--root-dir=")) {
      options.rootDir = arg.slice("--root-dir=".length);
      continue;
    }
    if (arg === "--root-dir") {
      options.rootDir = parseRequiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--file=")) {
      setFile(arg.slice("--file=".length));
      continue;
    }
    if (arg === "--file") {
      setFile(parseRequiredValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      options.port = parsePort(arg.slice("--port=".length), "--port");
      continue;
    }
    if (arg === "--port") {
      options.port = parsePort(parseRequiredValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--port-end=")) {
      options.portEnd = parsePort(arg.slice("--port-end=".length), "--port-end");
      continue;
    }
    if (arg === "--port-end") {
      options.portEnd = parsePort(parseRequiredValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--shutdown-after=")) {
      options.shutdownAfterMs = parseServerLifetimeMs(arg.slice("--shutdown-after=".length), "--shutdown-after");
      continue;
    }
    if (arg === "--shutdown-after") {
      options.shutdownAfterMs = parseServerLifetimeMs(parseRequiredValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  requireRootDirOption(options);
  return options;
}
function resolveRootDir({
  rootDir = "",
  env = process.env,
  cwd = process.cwd(),
  appRoot = viewerAppRoot
} = {}) {
  return resolveRootSelection({ rootDir, env, cwd, appRoot }).rootPath;
}
function resolveRootSelection({
  rootDir = "",
  env = process.env,
  cwd = process.cwd(),
  appRoot = viewerAppRoot
} = {}) {
  const effectiveEnv = { ...env };
  delete effectiveEnv.VIEWER_LOCAL_WORKSPACE_ROOT;
  const workspaceRoot = resolveWorkspaceRoot({
    env: effectiveEnv,
    cwd,
    appRoot,
    defaultWorkspaceRoot
  });
  if (!rootDir) {
    return {
      workspaceRoot,
      rootDir: "",
      rootPath: workspaceRoot
    };
  }
  const rootPath = path3.resolve(env.INIT_CWD || cwd, rootDir);
  return {
    workspaceRoot,
    rootDir: rootPath,
    rootPath
  };
}
function callerRoot(env = process.env, cwd = process.cwd()) {
  return env.INIT_CWD || cwd;
}
function chooseFileCandidate(rawFile, { rootPath, cwd, callerCwd }) {
  const candidates = [];
  if (path3.isAbsolute(rawFile)) {
    candidates.push(path3.resolve(rawFile));
  } else {
    candidates.push(path3.resolve(rootPath, rawFile));
    candidates.push(path3.resolve(callerCwd, rawFile));
    candidates.push(path3.resolve(cwd, rawFile));
  }
  const uniqueCandidates = [...new Set(candidates)];
  const insideCandidates = uniqueCandidates.filter((candidate) => pathIsInsideOrEqual(candidate, rootPath));
  if (!insideCandidates.length) {
    throw new Error(`CAD Viewer file must be inside the viewer root: ${rawFile}`);
  }
  return insideCandidates.find((candidate) => fs2.existsSync(candidate)) || insideCandidates[0];
}
function resolveEnsureServeRequest({
  options = {},
  env = process.env,
  cwd = process.cwd(),
  appRoot = viewerAppRoot
} = {}) {
  const rootSelection = resolveRootSelection({
    rootDir: options.rootDir,
    env,
    cwd,
    appRoot
  });
  const rootPath = rootSelection.rootPath;
  let fileParam = "";
  if (options.file) {
    const filePath = chooseFileCandidate(options.file, {
      rootPath,
      cwd,
      callerCwd: callerRoot(env, cwd)
    });
    fileParam = toPosixPath(path3.relative(rootPath, filePath));
  }
  const port = options.port || normalizeViewerPort(env.VIEWER_PORT, DEFAULT_VIEWER_PORT);
  const envPortEnd = env.VIEWER_PORT_END ? parsePort(env.VIEWER_PORT_END, "VIEWER_PORT_END") : DEFAULT_PORT_END;
  const configuredPortEnd = options.portEnd || envPortEnd;
  const hasExplicitPortEnd = Boolean(options.portEnd || env.VIEWER_PORT_END);
  const portEnd = hasExplicitPortEnd ? configuredPortEnd : Math.max(configuredPortEnd, port + DEFAULT_ADAPTIVE_PORT_COUNT);
  if (portEnd < port) {
    throw new Error("--port-end must be greater than or equal to --port");
  }
  return {
    workspaceRoot: rootSelection.workspaceRoot,
    rootDir: rootSelection.rootDir,
    rootPath,
    fileParam,
    port,
    portEnd,
    shutdownAfterMs: options.shutdownAfterMs ?? DEFAULT_SERVER_LIFETIME_MS
  };
}
function buildViewerUrl(serverInfo, fileParam = "") {
  const url = new URL(serverInfo?.url || `http://${DEFAULT_VIEWER_HOST}:${serverInfo.port}`);
  url.pathname = "/";
  url.search = "";
  if (fileParam) {
    url.search = `?file=${encodePathParam(fileParam)}`;
  }
  return url.href;
}
function probeViewerServer(port, {
  host = DEFAULT_VIEWER_HOST,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS
} = {}) {
  return new Promise((resolve) => {
    const req = http.get({
      hostname: host,
      port,
      path: "/__cad/server",
      timeout: timeoutMs
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) {
          req.destroy();
          resolve(null);
        }
      });
      res.on("end", () => {
        try {
          const payload = JSON.parse(body);
          resolve(isViewerServerInfo(payload) ? payload : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}
function normalizedCatalogFileRef(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
}
function catalogHasFile(catalog, fileParam = "") {
  const requestedFile = normalizedCatalogFileRef(fileParam);
  if (!requestedFile) {
    return true;
  }
  return Array.isArray(catalog?.entries) && catalog.entries.some((entry) => normalizedCatalogFileRef(entry?.file) === requestedFile);
}
function probeViewerCatalog(serverInfo, {
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS
} = {}) {
  return new Promise((resolve) => {
    let catalogUrl;
    try {
      catalogUrl = new URL("/__cad/catalog", serverInfo?.url || `http://${DEFAULT_VIEWER_HOST}:${serverInfo?.port}`);
    } catch {
      resolve(null);
      return;
    }
    const req = http.get({
      hostname: catalogUrl.hostname,
      port: catalogUrl.port,
      path: catalogUrl.pathname,
      protocol: catalogUrl.protocol,
      timeout: timeoutMs
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 2 * 1024 * 1024) {
          req.destroy();
          resolve(null);
        }
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}
async function probeViewerCatalogForFile(serverInfo, fileParam = "", options = {}) {
  if (!normalizedCatalogFileRef(fileParam)) {
    return true;
  }
  return catalogHasFile(await probeViewerCatalog(serverInfo, options), fileParam);
}
function canBindPort(port, { host = DEFAULT_VIEWER_HOST } = {}) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error) => resolve({
      canBind: false,
      errorCode: error?.code || "UNKNOWN",
      message: error?.message || ""
    }));
    server.once("listening", () => {
      server.close(() => resolve({ canBind: true }));
    });
    server.listen(port, host);
  });
}
function normalizeBindResult(result) {
  if (typeof result === "boolean") {
    return { canBind: result, errorCode: "", message: "" };
  }
  return {
    canBind: Boolean(result?.canBind),
    errorCode: typeof result?.errorCode === "string" ? result.errorCode : "",
    message: typeof result?.message === "string" ? result.message : ""
  };
}
function bindFailureIsPermissionDenied(errorCode) {
  return errorCode === "EPERM" || errorCode === "EACCES";
}
function summarizeBindFailures(bindFailures) {
  const byCode = /* @__PURE__ */ new Map();
  for (const failure of bindFailures) {
    const code = failure.errorCode || "UNKNOWN";
    const current = byCode.get(code) || { count: 0, ports: [] };
    current.count += 1;
    if (current.ports.length < 5) {
      current.ports.push(failure.port);
    }
    byCode.set(code, current);
  }
  return [...byCode.entries()].map(([code, value]) => `${code} on ${value.count} port${value.count === 1 ? "" : "s"} (${value.ports.join(", ")}${value.count > value.ports.length ? ", ..." : ""})`).join("; ");
}
function buildNoAvailablePortError({ port, portEnd, bindFailures }) {
  const deniedFailures = bindFailures.filter((failure) => ["EPERM", "EACCES"].includes(failure.errorCode));
  if (deniedFailures.length) {
    return new Error(
      `No available CAD Viewer port found in ${port}-${portEnd}; local port binding was denied (${summarizeBindFailures(deniedFailures)}). Rerun serve:ensure with local binding permission/escalation, or point --port at an already-running CAD Viewer server.`
    );
  }
  if (bindFailures.length) {
    return new Error(
      `No available CAD Viewer port found in ${port}-${portEnd}; bind failures: ${summarizeBindFailures(bindFailures)}`
    );
  }
  return new Error(`No available CAD Viewer port found in ${port}-${portEnd}`);
}
async function selectViewerServer({
  rootPath,
  fileParam = "",
  port,
  portEnd,
  probeServer = probeViewerServer,
  probeCatalogForFile = probeViewerCatalogForFile,
  canBind = canBindPort,
  registeredServers = readViewerServerRegistry()
} = {}) {
  const resolvedRootPath = path3.resolve(rootPath);
  const normalizedRegisteredServers = (Array.isArray(registeredServers) ? registeredServers : []).filter((server) => isViewerServerInfo(server)).sort((a, b) => a.port - b.port);
  const bindFailures = [];
  const registeredMatchesByPort = /* @__PURE__ */ new Map();
  for (let candidatePort = port; candidatePort <= portEnd; candidatePort += 1) {
    const serverInfo = await probeServer(candidatePort);
    if (isViewerServerInfo(serverInfo)) {
      if (path3.resolve(serverInfo.rootPath) === resolvedRootPath && await probeCatalogForFile(serverInfo, fileParam)) {
        return {
          action: "reuse",
          port: candidatePort,
          serverInfo
        };
      }
      continue;
    }
    if (!normalizedCatalogFileRef(fileParam)) {
      const registeredMatch = normalizedRegisteredServers.find((server) => server.port === candidatePort && path3.resolve(server.rootPath) === resolvedRootPath) || null;
      if (registeredMatch) {
        registeredMatchesByPort.set(candidatePort, registeredMatch);
      }
    }
  }
  let permissionDeniedRegisteredMatch = null;
  for (let candidatePort = port; candidatePort <= portEnd; candidatePort += 1) {
    const bindResult = normalizeBindResult(await canBind(candidatePort));
    if (bindResult.canBind) {
      return {
        action: "start",
        port: candidatePort,
        serverInfo: null
      };
    }
    if (bindResult.errorCode) {
      bindFailures.push({ port: candidatePort, ...bindResult });
      const registeredMatch = registeredMatchesByPort.get(candidatePort) || null;
      if (registeredMatch && bindFailureIsPermissionDenied(bindResult.errorCode)) {
        permissionDeniedRegisteredMatch ??= registeredMatch;
      }
    }
  }
  if (permissionDeniedRegisteredMatch) {
    return {
      action: "reuse",
      port: permissionDeniedRegisteredMatch.port,
      serverInfo: permissionDeniedRegisteredMatch
    };
  }
  throw buildNoAvailablePortError({ port, portEnd, bindFailures });
}
function buildViewerProcessEnv({
  rootDir,
  port,
  shutdownAfterMs = DEFAULT_SERVER_LIFETIME_MS,
  env = process.env
} = {}) {
  const nextEnv = {
    ...env,
    VIEWER_ASSET_BACKEND: "local-fs",
    VIEWER_LOCAL_ROOT_DIR: rootDir || "",
    VIEWER_PORT: String(port),
    VIEWER_SERVER_LIFETIME_MS: String(shutdownAfterMs)
  };
  delete nextEnv.VIEWER_LOCAL_WORKSPACE_ROOT;
  return nextEnv;
}
function buildProductionSpawnOptions({
  rootDir,
  port,
  shutdownAfterMs = DEFAULT_SERVER_LIFETIME_MS,
  env = process.env
} = {}) {
  return {
    command: process.execPath,
    args: [serverEntryPath],
    options: {
      cwd: viewerAppRoot,
      detached: true,
      stdio: "ignore",
      env: buildViewerProcessEnv({ rootDir, port, shutdownAfterMs, env })
    }
  };
}
function startProductionServer(request, spawnImpl = spawn) {
  const spawnOptions = buildProductionSpawnOptions(request);
  const child = spawnImpl(spawnOptions.command, spawnOptions.args, spawnOptions.options);
  child.unref?.();
  return child;
}
async function waitForMatchingServer({
  rootPath,
  fileParam = "",
  port,
  timeoutMs = DEFAULT_START_TIMEOUT_MS,
  intervalMs = DEFAULT_READY_INTERVAL_MS,
  probeServer = probeViewerServer,
  probeCatalogForFile = probeViewerCatalogForFile
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const resolvedRootPath = path3.resolve(rootPath);
  while (Date.now() < deadline) {
    const serverInfo = await probeServer(port);
    if (isViewerServerInfo(serverInfo) && path3.resolve(serverInfo.rootPath) === resolvedRootPath && await probeCatalogForFile(serverInfo, fileParam)) {
      return serverInfo;
    }
    await sleep(intervalMs);
  }
  throw new Error(`CAD Viewer did not become ready on port ${port}`);
}
function formatEnsureServeResult({ action, serverInfo, fileParam, json = false } = {}) {
  const url = buildViewerUrl(serverInfo, fileParam);
  if (json) {
    return `${JSON.stringify({
      action,
      url,
      server: serverInfo
    }, null, 2)}
`;
  }
  return `${url}
`;
}
function helpText() {
  return `Usage: npm run serve:ensure -- [options]

Options:
  --root-dir <path>        Required. Viewer root directory to scan.
  --file <path>            File to open; pass one --file per command.
  --port <number>          First port to probe. Defaults to 4178 or VIEWER_PORT.
  --port-end <number>      Last port to probe. Defaults to 4198, then auto-expands
                           to 80 more ports unless VIEWER_PORT_END is set.
  --shutdown-after <time>  Server lifetime before automatic shutdown. Defaults
                           to 12h. Accepts ms, s, m, or h suffixes.
  --json                   Print structured JSON instead of just the Viewer URL.
`;
}
async function runEnsureServe(argv = process.argv.slice(2), {
  env = process.env,
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  spawnImpl = spawn
} = {}) {
  const options = parseEnsureServeArgs(argv);
  if (options.help) {
    stdout.write(helpText());
    return 0;
  }
  const request = resolveEnsureServeRequest({ options, env, cwd });
  const selection = await selectViewerServer(request);
  let serverInfo = selection.serverInfo;
  if (selection.action === "start") {
    startProductionServer({
      rootDir: request.rootDir,
      port: selection.port,
      shutdownAfterMs: request.shutdownAfterMs,
      env
    }, spawnImpl);
    serverInfo = await waitForMatchingServer({
      rootPath: request.rootPath,
      fileParam: request.fileParam,
      port: selection.port
    });
  }
  writeViewerServerRegistry(serverInfo);
  stdout.write(formatEnsureServeResult({
    action: selection.action === "start" ? "started" : "reused",
    serverInfo,
    fileParam: request.fileParam,
    json: options.json
  }));
  return 0;
}
if (process.argv[1] && path3.resolve(process.argv[1]) === scriptPath) {
  runEnsureServe().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
    process.exitCode = 1;
  });
}
export {
  DEFAULT_ADAPTIVE_PORT_COUNT,
  DEFAULT_PORT_END,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_READY_INTERVAL_MS,
  DEFAULT_SERVER_LIFETIME_MS,
  DEFAULT_START_TIMEOUT_MS,
  MAX_SERVER_LIFETIME_MS,
  buildProductionSpawnOptions,
  buildViewerUrl,
  canBindPort,
  catalogHasFile,
  formatEnsureServeResult,
  helpText,
  parseEnsureServeArgs,
  parseServerLifetimeMs,
  probeViewerCatalog,
  probeViewerCatalogForFile,
  probeViewerServer,
  resolveEnsureServeRequest,
  resolveRootDir,
  runEnsureServe,
  selectViewerServer,
  startProductionServer,
  waitForMatchingServer
};
