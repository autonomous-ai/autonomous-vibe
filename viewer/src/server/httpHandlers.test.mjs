import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Writable } from "node:stream";

import {
  contentTypeForStaticAsset,
  createCadViewerApiMiddleware,
  serveDistAsset,
} from "./httpHandlers.mjs";


function createResponse() {
  const headers = new Map();
  return {
    statusCode: 0,
    body: "",
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
    },
    getHeader(name) {
      return headers.get(String(name).toLowerCase());
    },
    end(body = "") {
      this.body = String(body);
    },
  };
}


function createWritableResponse() {
  const headers = new Map();
  const chunks = [];
  const response = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  response.statusCode = 200;
  response.setHeader = (name, value) => {
    headers.set(String(name).toLowerCase(), String(value));
  };
  response.getHeader = (name) => headers.get(String(name).toLowerCase());
  response.bodyText = () => Buffer.concat(chunks).toString("utf8");
  response.finished = new Promise((resolve) => {
    response.on("finish", resolve);
  });
  return response;
}


test("CAD Viewer API middleware awaits async backend catalog reads", async () => {
  const middleware = createCadViewerApiMiddleware({
    backend: {
      readCatalog: async () => ({ schemaVersion: 4, entries: [{ file: "part.step" }] }),
    },
  });
  const req = { method: "GET", url: "/__cad/catalog" };
  const res = createResponse();
  let nextCalled = false;

  await middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(res.body), {
    schemaVersion: 4,
    entries: [{ file: "part.step" }],
  });
});


test("production static assets get browser-safe content types", () => {
  assert.equal(contentTypeForStaticAsset("dist/index.html"), "text/html; charset=utf-8");
  assert.equal(contentTypeForStaticAsset("dist/assets/index-abc.js"), "text/javascript; charset=utf-8");
  assert.equal(contentTypeForStaticAsset("dist/assets/index-abc.css"), "text/css; charset=utf-8");
  assert.equal(contentTypeForStaticAsset("dist/assets/module.wasm"), "application/wasm");
  assert.equal(contentTypeForStaticAsset("dist/assets/favicon.ico"), "image/x-icon");
});


test("production static assets are no-store and missing assets do not fall back to index", async () => {
  const distRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cad-viewer-dist-"));
  await fs.mkdir(path.join(distRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(distRoot, "index.html"), "<main>CAD Viewer</main>");
  await fs.writeFile(path.join(distRoot, "assets", "index-abc.js"), "console.log('viewer');");
  const middleware = serveDistAsset({ distRoot });

  const assetResponse = createWritableResponse();
  let assetNextCalled = false;
  middleware({ url: "/assets/index-abc.js" }, assetResponse, () => {
    assetNextCalled = true;
  });
  await assetResponse.finished;
  assert.equal(assetNextCalled, false);
  assert.equal(assetResponse.statusCode, 200);
  assert.equal(assetResponse.getHeader("content-type"), "text/javascript; charset=utf-8");
  assert.equal(assetResponse.getHeader("cache-control"), "no-store");
  assert.equal(assetResponse.bodyText(), "console.log('viewer');");

  const missingAssetResponse = createWritableResponse();
  let missingNextCalled = false;
  middleware({ url: "/assets/old-hash.js" }, missingAssetResponse, () => {
    missingNextCalled = true;
  });
  await missingAssetResponse.finished;
  assert.equal(missingNextCalled, false);
  assert.equal(missingAssetResponse.statusCode, 404);
  assert.equal(missingAssetResponse.getHeader("content-type"), "text/plain; charset=utf-8");
  assert.equal(missingAssetResponse.getHeader("cache-control"), "no-store");
  assert.equal(missingAssetResponse.bodyText(), "Not found");

  const routeResponse = createWritableResponse();
  middleware({ url: "/workspace/tom" }, routeResponse, () => {});
  await routeResponse.finished;
  assert.equal(routeResponse.statusCode, 200);
  assert.equal(routeResponse.getHeader("content-type"), "text/html; charset=utf-8");
  assert.equal(routeResponse.getHeader("cache-control"), "no-store");
  assert.equal(routeResponse.bodyText(), "<main>CAD Viewer</main>");
});


test("CAD Viewer API middleware serves dynamic STEP source status", async () => {
  const calls = [];
  const middleware = createCadViewerApiMiddleware({
    backend: {
      readCatalog: async () => ({ schemaVersion: 4, entries: [{ file: "part.step" }] }),
      readStepSourceStatus: async (request) => {
        calls.push(request);
        return {
          ok: false,
          file: "part.step",
          sourceKind: "python",
          step: { status: "missing", missing: true, stale: false },
        };
      },
    },
  });
  const req = { method: "GET", url: "/__cad/step-source-status?file=part.step" };
  const res = createResponse();

  await middleware(req, res, () => {});

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.map((call) => ({ fileRef: call.fileRef, hasCatalog: !!call.catalog })), [
    { fileRef: "part.step", hasCatalog: true },
  ]);
  assert.deepEqual(JSON.parse(res.body), {
    ok: false,
    file: "part.step",
    sourceKind: "python",
    step: { status: "missing", missing: true, stale: false },
  });
});


test("CAD Viewer API middleware serves local generation status", async () => {
  const middleware = createCadViewerApiMiddleware({
    rootDir: "models",
    backend: {
      readGenerationStatus: async ({ rootDir }) => ({
        schemaVersion: 1,
        rootDir,
        runs: [{ id: "run-1", files: ["part.step"] }],
        files: { "part.step": { running: true } },
      }),
    },
  });
  const req = { method: "GET", url: "/__cad/generation-status" };
  const res = createResponse();

  await middleware(req, res, () => {});

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    schemaVersion: 1,
    rootDir: "models",
    runs: [{ id: "run-1", files: ["part.step"] }],
    files: { "part.step": { running: true } },
  });
});


test("CAD Viewer API middleware reveals file assets with POST reveal route", async () => {
  const calls = [];
  const middleware = createCadViewerApiMiddleware({
    backend: {
      readCatalog: async () => ({ schemaVersion: 4, entries: [{ file: "part.step" }] }),
      openFileAsset: async (request) => {
        calls.push(request);
        return {
          asset: request.asset,
          file: "part.step",
          filename: "part.step",
          opened: true,
        };
      },
    },
  });
  const req = { method: "POST", url: "/__cad/reveal?file=part.step&asset=output" };
  const res = createResponse();

  await middleware(req, res, () => {});

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.map((call) => ({ fileRef: call.fileRef, asset: call.asset, hasCatalog: !!call.catalog })), [
    { fileRef: "part.step", asset: "output", hasCatalog: true },
  ]);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true,
    asset: "output",
    file: "part.step",
    filename: "part.step",
    opened: true,
  });
});


test("CAD Viewer API middleware downloads file asset bytes from hosted backends", async () => {
  const middleware = createCadViewerApiMiddleware({
    backend: {
      readCatalog: async () => ({ schemaVersion: 4, entries: [{ file: "part.step" }] }),
      readFileAsset: async ({ fileRef, asset }) => ({
        file: fileRef,
        asset,
        filename: "part.step",
        contentType: "application/step",
        body: Buffer.from("ISO-10303-21;"),
      }),
    },
  });
  const req = { method: "GET", url: "/__cad/download?file=part.step&asset=output" };
  const res = createResponse();

  await middleware(req, res, () => {});

  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader("content-type"), "application/step");
  assert.equal(res.getHeader("content-disposition"), "attachment; filename=\"part.step\"; filename*=UTF-8''part.step");
  assert.equal(res.body, "ISO-10303-21;");
});


test("CAD Viewer API middleware rejects hosted reveal requests", async () => {
  const middleware = createCadViewerApiMiddleware({
    backend: {
      readCatalog: async () => ({ schemaVersion: 4, entries: [{ file: "part.step" }] }),
      readFileAsset: async () => ({
        filename: "part.step",
        body: Buffer.from("step"),
      }),
    },
  });
  const req = { method: "POST", url: "/__cad/reveal?file=part.step&asset=output" };
  const res = createResponse();

  await middleware(req, res, () => {});

  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /local filesystem/);
});


test("CAD Viewer API middleware leaves STEP artifact route unclaimed when generation is disabled", async () => {
  const middleware = createCadViewerApiMiddleware({
    backend: {
      readCatalog: async () => ({ schemaVersion: 4, entries: [] }),
    },
    enableStepArtifactBackend: false,
  });
  const req = { method: "POST", url: "/__cad/step-artifact?file=part.step" };
  const res = createResponse();
  let nextCalled = false;

  await middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.body, "");
});


test("CAD Viewer API middleware can claim disabled STEP artifact routes with JSON", async () => {
  const middleware = createCadViewerApiMiddleware({
    backend: {
      readCatalog: async () => ({ schemaVersion: 4, entries: [] }),
    },
    enableStepArtifactBackend: false,
    claimDisabledStepArtifactRoute: true,
  });
  const req = { method: "POST", url: "/__cad/step-artifact?file=part.step" };
  const res = createResponse();
  let nextCalled = false;

  await middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 501);
  assert.match(JSON.parse(res.body).error, /not enabled/);
});


test("CAD Viewer API middleware supports non-filesystem STEP artifact backends", async () => {
  const calls = [];
  const middleware = createCadViewerApiMiddleware({
    backend: {
      readCatalog: async () => ({ schemaVersion: 4, entries: [{ file: "part.step" }] }),
      generateStepArtifact: async (request) => {
        calls.push(request);
        return {
          ok: true,
          entry: { file: "part.step", kind: "part", url: "/.part.step.glb", hash: "hash", bytes: 3 },
          result: { uploaded: true },
          catalog: {
            schemaVersion: 4,
            entries: [{ file: "part.step", kind: "part", url: "/.part.step.glb", hash: "hash", bytes: 3 }]
          },
        };
      },
    },
    enableStepArtifactBackend: true,
  });
  const req = { method: "POST", url: "/__cad/step-artifact?file=part.step&force=1" };
  const res = createResponse();

  await middleware(req, res, () => {});

  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    calls.map((call) => ({ fileRef: call.fileRef, force: call.force, hasCatalog: !!call.catalog })),
    [{ fileRef: "part.step", force: true, hasCatalog: true }],
  );
  assert.deepEqual(JSON.parse(res.body), {
    ok: true,
    error: "",
    result: { uploaded: true },
    entry: { file: "part.step", kind: "part", url: "/.part.step.glb", hash: "hash", bytes: 3 },
    catalog: {
      schemaVersion: 4,
      entries: [{ file: "part.step", kind: "part", url: "/.part.step.glb", hash: "hash", bytes: 3 }]
    },
  });
});
