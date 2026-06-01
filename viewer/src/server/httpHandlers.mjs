import fs from "node:fs";
import path from "node:path";

const STATIC_CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
]);

export function contentTypeForStaticAsset(filePath) {
  return STATIC_CONTENT_TYPES.get(path.extname(String(filePath || "")).toLowerCase()) || "";
}

export function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

function downloadFilename(value) {
  const rawFilename = path.basename(String(value || "").replace(/\\/g, "/")) || "download";
  return rawFilename.replace(/[\x00-\x1f"\\]/g, "_");
}

function encodeContentDispositionFilename(value) {
  return encodeURIComponent(value).replace(/['()*]/g, (char) => (
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

function attachmentContentDisposition(filename) {
  const safeFilename = downloadFilename(filename);
  const quotedFilename = safeFilename.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${quotedFilename}"; filename*=UTF-8''${encodeContentDispositionFilename(safeFilename)}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function fileAssetRequest(backend, requestUrl, {
  rootDir,
  catalog,
} = {}) {
  const request = {
    fileRef: requestUrl.searchParams.get("file"),
    asset: requestUrl.searchParams.get("asset") || "output",
    rootDir,
    catalog,
  };
  if (typeof backend.resolveRoot === "function") {
    request.resolvedRoot = backend.resolveRoot(rootDir);
  }
  return request;
}

function sendBufferDownload(res, {
  body,
  filename,
  contentType,
} = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body || "");
  res.statusCode = 200;
  res.setHeader("content-type", contentType || "application/octet-stream");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-disposition", attachmentContentDisposition(filename));
  res.setHeader("content-length", String(bytes.length));
  res.end(bytes);
}

export function serveStaticFile(filePath, req, res, next, { contentType, headers = {} } = {}) {
  fs.stat(filePath, (error, stats) => {
    if (res.destroyed) {
      return;
    }
    if (error || !stats.isFile()) {
      next();
      return;
    }
    if (contentType) {
      res.setHeader("content-type", contentType);
    }
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined && value !== null && value !== "") {
        res.setHeader(name, value);
      }
    }
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-length", String(stats.size));
    const stream = fs.createReadStream(filePath);
    res.on("close", () => {
      if (!res.writableEnded) {
        stream.destroy();
      }
    });
    stream.on("error", () => {
      if (!res.headersSent) {
        next();
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  });
}

export function createCadViewerApiMiddleware({
  backend,
  serverInfo = () => ({}),
  enableStepArtifactBackend = false,
  claimDisabledStepArtifactRoute = false,
  onCatalogChanged = () => {},
  rootDir,
} = {}) {
  if (!backend) {
    throw new Error("createCadViewerApiMiddleware requires backend");
  }
  return async function cadViewerApiMiddleware(req, res, next) {
    const requestUrl = new URL(req.url || "/", "http://localhost");
    if (requestUrl.pathname === "/__cad/server") {
      sendJson(res, 200, serverInfo());
      return;
    }
    if (requestUrl.pathname === "/__cad/catalog") {
      try {
        sendJson(res, 200, await backend.readCatalog({ rootDir }));
      } catch (error) {
        sendJson(res, 400, {
          error: errorMessage(error),
        });
      }
      return;
    }
    if (requestUrl.pathname === "/__cad/generation-status") {
      if (typeof backend.readGenerationStatus !== "function") {
        sendJson(res, 501, {
          error: "Generation status is not available for this CAD Viewer backend",
        });
        return;
      }
      try {
        sendJson(res, 200, await backend.readGenerationStatus({ rootDir }));
      } catch (error) {
        sendJson(res, 400, {
          error: errorMessage(error),
        });
      }
      return;
    }
    if (requestUrl.pathname === "/__cad/download") {
      const method = String(req.method || "GET").toUpperCase();
      if (method !== "GET") {
        res.setHeader("allow", "GET");
        sendJson(res, 405, {
          error: "Use GET to download a file asset",
        });
        return;
      }

      try {
        const catalog = await backend.readCatalog({ rootDir });
        const request = fileAssetRequest(backend, requestUrl, { rootDir, catalog });

        if (typeof backend.readFileAsset === "function") {
          const result = await backend.readFileAsset(request);
          sendBufferDownload(res, result);
          return;
        }

        if (typeof backend.resolveFileAssetAccess !== "function") {
          sendJson(res, 501, {
            error: "File downloads are not available for this CAD Viewer backend",
          });
          return;
        }

        const access = await backend.resolveFileAssetAccess(request);
        if (access?.path) {
          serveStaticFile(access.path, req, res, () => {
            sendJson(res, 404, {
              error: "File asset not found",
            });
          }, {
            contentType: access.contentType || backend.contentTypeForPath?.(access.path) || "application/octet-stream",
            headers: {
              "content-disposition": attachmentContentDisposition(access.filename || access.file || access.path),
            },
          });
          return;
        }
        if (access?.url) {
          res.statusCode = 302;
          res.setHeader("location", access.url);
          res.setHeader("cache-control", "no-store");
          res.end("");
          return;
        }
        sendJson(res, 404, {
          error: "File asset not found",
        });
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: errorMessage(error),
        });
      }
      return;
    }
    if (requestUrl.pathname === "/__cad/reveal") {
      const method = String(req.method || "GET").toUpperCase();
      if (method !== "POST") {
        res.setHeader("allow", "POST");
        sendJson(res, 405, {
          error: "Use POST to reveal a file asset",
        });
        return;
      }

      try {
        if (typeof backend.openFileAsset !== "function") {
          sendJson(res, 405, {
            error: "Revealing files is only available for the local filesystem backend",
          });
          return;
        }
        const catalog = await backend.readCatalog({ rootDir });
        const request = fileAssetRequest(backend, requestUrl, { rootDir, catalog });
        const result = await backend.openFileAsset(request);
        sendJson(res, 200, {
          ok: true,
          ...result,
        });
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: errorMessage(error),
        });
      }
      return;
    }
    if (requestUrl.pathname === "/__cad/step-source-status") {
      if (typeof backend.readStepSourceStatus !== "function") {
        sendJson(res, 501, {
          error: "STEP source status is not available for this CAD Viewer backend",
        });
        return;
      }
      try {
        const catalog = await backend.readCatalog({ rootDir });
        const request = {
          fileRef: requestUrl.searchParams.get("file"),
          rootDir,
          catalog,
        };
        if (typeof backend.resolveRoot === "function") {
          request.resolvedRoot = backend.resolveRoot(rootDir);
        }
        sendJson(res, 200, await backend.readStepSourceStatus(request));
      } catch (error) {
        sendJson(res, 400, {
          error: errorMessage(error),
        });
      }
      return;
    }
    if (requestUrl.pathname === "/__cad/step-artifact") {
      if (!enableStepArtifactBackend) {
        if (claimDisabledStepArtifactRoute) {
          sendJson(res, 501, {
            error: "STEP artifact generation is not enabled for this CAD Viewer backend",
          });
          return;
        }
        next();
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, {
          error: "Use POST to generate a STEP artifact",
        });
        return;
      }
      try {
        const catalog = await backend.readCatalog({ rootDir });
        if (typeof backend.resolveRoot !== "function") {
          const result = await backend.generateStepArtifact({
            fileRef: requestUrl.searchParams.get("file"),
            force: requestUrl.searchParams.get("force") === "1",
            rootDir,
            catalog,
          });
          const nextCatalog = result?.catalog || (
            typeof backend.refreshCatalog === "function"
              ? await backend.refreshCatalog({ rootDir })
              : await backend.readCatalog({ rootDir })
          );
          sendJson(res, result?.ok ? 200 : 500, {
            ok: Boolean(result?.ok),
            error: result?.ok ? "" : String(result?.error || "STEP artifact generation failed."),
            result: result?.result ?? result,
            entry: result?.entry ?? null,
            catalog: nextCatalog,
          });
          return;
        }

        const resolvedRoot = backend.resolveRoot(rootDir);
        const result = await backend.generateStepArtifact({
          fileRef: requestUrl.searchParams.get("file"),
          force: requestUrl.searchParams.get("force") === "1",
          resolvedRoot,
          catalog,
        });
        const nextCatalog = typeof backend.refreshCatalog === "function"
          ? await backend.refreshCatalog({ rootDir })
          : await backend.readCatalog({ rootDir });
        onCatalogChanged(resolvedRoot);
        sendJson(res, result.ok ? 200 : 500, {
          ok: result.ok,
          error: result.error,
          result: result.result,
          entry: backend.entryForSourcePath(nextCatalog, resolvedRoot, result.stepPath),
          catalog: nextCatalog,
        });
      } catch (error) {
        sendJson(res, 400, {
          error: errorMessage(error),
        });
      }
      return;
    }
    next();
  };
}

export function createLocalAssetMiddleware({ backend, rootDir } = {}) {
  if (!backend) {
    throw new Error("createLocalAssetMiddleware requires backend");
  }
  return function localAssetMiddleware(req, res, next) {
    let assetPath = null;
    try {
      assetPath = backend.assetPathForRequestPath(req.url || "/", {
        resolvedRoot: backend.resolveRoot(rootDir),
      });
    } catch (error) {
      if (Number(error?.statusCode) === 403) {
        res.statusCode = 403;
        res.end("Forbidden");
        return;
      }
      next();
      return;
    }
    if (!assetPath) {
      next();
      return;
    }
    serveStaticFile(assetPath, req, res, next, {
      contentType: backend.contentTypeForPath?.(assetPath) || undefined,
    });
  };
}

export function serveDistAsset({ distRoot, indexHtmlPath = path.join(distRoot, "index.html") } = {}) {
  return function distAssetMiddleware(req, res, next) {
    const requestUrl = new URL(req.url || "/", "http://localhost");
    const requestPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
    let filePath = "";
    try {
      filePath = path.resolve(distRoot, decodeURIComponent(requestPath).replace(/^\/+/, ""));
    } catch {
      res.statusCode = 400;
      res.end("Bad request");
      return;
    }
    if (!(filePath === distRoot || filePath.startsWith(`${distRoot}${path.sep}`))) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }
    const fileExists = fs.existsSync(filePath);
    const isStaticAssetRequest = requestPath.startsWith("/assets/") || path.extname(requestPath);
    if (!fileExists && isStaticAssetRequest) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end("Not found");
      return;
    }
    const fallbackPath = fileExists ? filePath : indexHtmlPath;
    serveStaticFile(fallbackPath, req, res, next, {
      contentType: contentTypeForStaticAsset(fallbackPath) || undefined,
    });
  };
}
