import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHostedViewerServerInfo,
  createHostedCadBackendFromEnv,
  handleHostedCadApi,
  hostedViewerPublicUrlFromEnv,
} from "./vercelApi.mjs";


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


test("hosted backend reads Blob-only catalog environment", () => {
  const backend = createHostedCadBackendFromEnv({
    VIEWER_ASSET_BACKEND: "vercel-blob",
    VIEWER_VERCEL_BLOB_PREFIX: "demo",
  });

  assert.equal(backend.kind, "vercel-blob");
  assert.equal(backend.readOnly, true);
  assert.equal(backend.prefix, "demo");
  assert.equal(backend.catalogPath, "demo/catalog.json");
  assert.equal(backend.canGenerateStepArtifacts, false);
  assert.equal("writeAsset" in backend, false);
  assert.equal("writeCatalog" in backend, false);
  assert.equal("generateStepArtifact" in backend, false);
});


test("hosted CAD API serves catalog through an injected Blob backend", async () => {
  const backend = {
    kind: "vercel-blob",
    catalogPath: "demo/catalog.json",
    readCatalog: async () => ({ schemaVersion: 4, entries: [{ file: "part.step" }] }),
  };
  const req = { method: "GET", url: "/api/cad/catalog?ignored=1" };
  const res = createResponse();

  await handleHostedCadApi(req, res, {
    cadPath: "/__cad/catalog",
    backend,
    env: { VIEWER_ASSET_BACKEND: "vercel-blob", VERCEL_URL: "cad.example.test" },
  });

  assert.equal(req.url, "/api/cad/catalog?ignored=1");
  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(res.body), {
    schemaVersion: 4,
    entries: [{ file: "part.step" }],
  });
});


test("hosted CAD API reports disabled STEP generation as a handled backend response", async () => {
  const backend = {
    kind: "vercel-blob",
    catalogPath: "demo/catalog.json",
    readCatalog: async () => ({ schemaVersion: 4, entries: [] }),
  };
  const req = { method: "POST", url: "/api/cad/step-artifact?file=part.step" };
  const res = createResponse();

  await handleHostedCadApi(req, res, {
    cadPath: "/__cad/step-artifact",
    backend,
    env: {},
  });

  assert.equal(res.statusCode, 501);
  assert.match(JSON.parse(res.body).error, /not enabled/);
});


test("hosted CAD API keeps STEP generation disabled even when a backend can generate", async () => {
  const backend = {
    kind: "vercel-blob",
    catalogPath: "demo/catalog.json",
    readCatalog: async () => ({ schemaVersion: 4, entries: [] }),
    canGenerateStepArtifacts: true,
    generateStepArtifact: async () => {
      throw new Error("hosted generation should not run");
    },
  };
  const req = { method: "POST", url: "/api/cad/step-artifact?file=part.step" };
  const res = createResponse();

  await handleHostedCadApi(req, res, {
    cadPath: "/__cad/step-artifact",
    backend,
    env: {},
  });

  assert.equal(res.statusCode, 501);
  assert.match(JSON.parse(res.body).error, /not enabled/);
});


test("hosted server info is filesystem-free", () => {
  assert.deepEqual(
    buildHostedViewerServerInfo({
      backend: { kind: "vercel-blob", catalogPath: "demo/catalog.json" },
      env: { VIEWER_ASSET_BACKEND: "vercel-blob", VERCEL_URL: "cad.example.test" },
    }),
    {
      schemaVersion: 1,
      app: "cad-viewer",
      backend: "vercel-blob",
      rootDir: "",
      catalogPath: "demo/catalog.json",
      stepArtifactGenerationAvailable: false,
      url: "https://cad.example.test",
    },
  );
});


test("hosted viewer public URL is derived from Vercel system environment", () => {
  assert.equal(
    hostedViewerPublicUrlFromEnv({
      VERCEL_PROJECT_PRODUCTION_URL: "cad.example.test",
      VERCEL_URL: "cad-deployment.example.test",
    }),
    "https://cad.example.test",
  );
  assert.equal(
    hostedViewerPublicUrlFromEnv({
      VERCEL_URL: "cad-deployment.example.test",
    }),
    "https://cad-deployment.example.test",
  );
  assert.equal(
    hostedViewerPublicUrlFromEnv({
      VERCEL_BRANCH_URL: "cad-git-feature.example.test",
    }),
    "https://cad-git-feature.example.test",
  );
  assert.equal(
    hostedViewerPublicUrlFromEnv({
      VERCEL_URL: "https://cad.example.test/",
    }),
    "https://cad.example.test",
  );
  assert.equal(
    hostedViewerPublicUrlFromEnv({
      VERCEL_URL: "not a url",
    }),
    "",
  );
});
