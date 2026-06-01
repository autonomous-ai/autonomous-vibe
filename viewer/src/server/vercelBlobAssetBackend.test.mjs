import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  contentTypeForFileRef,
  createVercelBlobAssetBackend,
} from "./vercelBlobAssetBackend.mjs";

test("Vercel Blob backend uses browser-safe MIME types for served modules", () => {
  assert.equal(contentTypeForFileRef("models/.part.step.js"), "text/javascript; charset=utf-8");
  assert.equal(contentTypeForFileRef("models/.part.step.mjs"), "text/javascript; charset=utf-8");
  assert.equal(contentTypeForFileRef("models/catalog.json"), "application/json; charset=utf-8");
});

test("Vercel Blob backend reads catalog through authenticated Blob SDK when credentials are available", async () => {
  const getCalls = [];
  const backend = createVercelBlobAssetBackend({
    prefix: "demo",
    catalogUrl: "https://blob.test/demo/catalog.json",
    client: {
      get: async (pathname, options) => {
        getCalls.push({ pathname, options });
        return {
          statusCode: 200,
          stream: new Response(JSON.stringify({
            schemaVersion: 4,
            entries: [{ file: "parts/bracket.step" }],
          })).body,
          blob: { pathname },
        };
      },
    },
    fetchImpl: async () => {
      throw new Error("public catalog URL should not be fetched when authenticated Blob reads are available");
    },
    token: "test-token",
  });

  assert.deepEqual(await backend.readCatalog(), {
    schemaVersion: 4,
    entries: [{ file: "parts/bracket.step" }],
  });
  assert.deepEqual(getCalls, [{
    pathname: "demo/catalog.json",
    options: {
      access: "public",
      token: "test-token",
    },
  }]);
});

test("Vercel Blob backend reads catalog and writes deterministic asset paths", async () => {
  const putCalls = [];
  const backend = createVercelBlobAssetBackend({
    prefix: "demo",
    catalogUrl: "https://blob.test/catalog.json",
    client: {
      put: async (pathname, body, options) => {
        putCalls.push({ pathname, body, options });
        return { pathname, url: `https://blob.test/${pathname}` };
      },
    },
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => ({ schemaVersion: 4, url }),
    }),
    token: "test-token",
  });

  assert.equal(backend.canGenerateStepArtifacts, true);
  assert.deepEqual(await backend.readCatalog(), {
    schemaVersion: 4,
    url: "https://blob.test/catalog.json",
  });
  const result = await backend.writeAsset({
    fileRef: "models/.part.step.glb",
    body: Buffer.from("glb"),
    contentType: "model/gltf-binary",
  });

  assert.equal(result.pathname, "demo/models/.part.step.glb");
  assert.equal(putCalls[0].pathname, "demo/models/.part.step.glb");
  assert.equal(putCalls[0].options.addRandomSuffix, false);
  assert.equal(putCalls[0].options.allowOverwrite, true);
  assert.equal(putCalls[0].options.access, "public");
});

test("Vercel Blob backend can regenerate STEP artifacts from Blob storage", async () => {
  const stepBytes = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
  const catalog = {
    schemaVersion: 4,
    entries: [
      {
        file: "benchmarks/part.step",
        kind: "part",
        url: "https://blob.test/demo/benchmarks/.part.step.glb",
        hash: "",
        bytes: 0,
        artifact: {
          ok: false,
          error: "missing_edge_topology",
        },
      },
    ],
  };
  const putCalls = [];
  const backend = createVercelBlobAssetBackend({
    prefix: "demo",
    client: {
      list: async ({ prefix }) => ({
        blobs: prefix === "demo/benchmarks/part.step"
          ? [{ pathname: prefix, url: "https://blob.test/demo/benchmarks/part.step" }]
          : [],
      }),
      put: async (pathname, body, options) => {
        putCalls.push({ pathname, body, options });
        return { pathname, url: `https://blob.test/${pathname}` };
      },
    },
    fetchImpl: async (url) => {
      assert.equal(url, "https://blob.test/demo/benchmarks/part.step");
      return {
        ok: true,
        arrayBuffer: async () => stepBytes.buffer.slice(stepBytes.byteOffset, stepBytes.byteOffset + stepBytes.byteLength),
      };
    },
    artifactCompiler: async ({ stepPath, force }) => {
      assert.equal(force, true);
      assert.equal(fs.readFileSync(stepPath, "utf-8"), stepBytes.toString("utf-8"));
      const glbPath = path.join(path.dirname(stepPath), `.${path.basename(stepPath)}.glb`);
      fs.writeFileSync(glbPath, Buffer.from("glb"));
      return {
        ok: true,
        glbPath,
        validation: {
          ok: true,
          glbPath: "models/benchmarks/.part.step.glb",
          stepHash: "step-hash",
        },
      };
    },
    token: "test-token",
  });

  const result = await backend.generateStepArtifact({
    fileRef: "benchmarks/part.step",
    force: true,
    catalog,
  });

  assert.equal(result.ok, true);
  assert.equal(result.entry.url, "https://blob.test/demo/benchmarks/.part.step.glb");
  assert.equal(result.entry.hash.length, 64);
  assert.equal(result.entry.bytes, 3);
  assert.equal(result.entry.artifact, undefined);
  assert.equal(result.entry.assets, undefined);
  assert.equal(result.entry.step, undefined);
  assert.equal(result.entry.stepArtifact, undefined);
  assert.equal(result.catalog.entries[0], result.entry);
  assert.equal(putCalls[0].pathname, "demo/benchmarks/.part.step.glb");
  assert.equal(putCalls[0].options.contentType, "model/gltf-binary");
  assert.equal(putCalls[0].options.allowOverwrite, true);
  assert.equal(putCalls[1].pathname, "demo/catalog.json");
  assert.equal(putCalls[1].options.contentType, "application/json; charset=utf-8");
  assert.equal(putCalls[1].options.allowOverwrite, true);
});

test("Vercel Blob backend downloads STEP output files instead of generated GLB artifacts", async () => {
  const stepBytes = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
  const catalog = {
    schemaVersion: 4,
    entries: [
      {
        file: "benchmarks/part.step",
        kind: "part",
        url: "https://blob.test/demo/benchmarks/.part.step.glb",
        hash: "glb-hash",
        bytes: 3,
      },
    ],
  };
  const listedPrefixes = [];
  const fetchedUrls = [];
  const backend = createVercelBlobAssetBackend({
    prefix: "demo",
    client: {
      list: async ({ prefix }) => {
        listedPrefixes.push(prefix);
        return {
          blobs: prefix === "demo/benchmarks/part.step"
            ? [{ pathname: prefix, url: "https://blob.test/demo/benchmarks/part.step" }]
            : [],
        };
      },
    },
    fetchImpl: async (url) => {
      fetchedUrls.push(url);
      return {
        ok: true,
        headers: {
          get: () => "application/step",
        },
        arrayBuffer: async () => stepBytes.buffer.slice(stepBytes.byteOffset, stepBytes.byteOffset + stepBytes.byteLength),
      };
    },
    token: "test-token",
  });

  const access = await backend.resolveFileAssetAccess({
    fileRef: "benchmarks/part.step",
    asset: "output",
    catalog,
  });
  const download = await backend.readFileAsset({
    fileRef: "benchmarks/part.step",
    asset: "output",
    catalog,
  });

  assert.equal(access.asset, "output");
  assert.equal(access.url, "https://blob.test/demo/benchmarks/part.step");
  assert.equal(access.filename, "part.step");
  assert.deepEqual(listedPrefixes, [
    "demo/benchmarks/part.step",
    "demo/benchmarks/part.step",
  ]);
  assert.deepEqual(fetchedUrls, ["https://blob.test/demo/benchmarks/part.step"]);
  assert.equal(download.contentType, "application/step");
  assert.equal(download.body.toString("utf-8"), stepBytes.toString("utf-8"));
});

test("read-only Vercel Blob backend uses catalog URLs without listing blobs", async () => {
  const stepBytes = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
  const catalog = {
    schemaVersion: 4,
    entries: [
      {
        file: "benchmarks/part.step",
        kind: "part",
        url: "https://blob.test/demo/benchmarks/.part.step.glb",
        source: {
          file: "benchmarks/part.step",
          url: "https://blob.test/demo/benchmarks/part.step",
        },
      },
    ],
  };
  const backend = createVercelBlobAssetBackend({
    readOnly: true,
    prefix: "demo",
    client: {
      list: async () => {
        throw new Error("read-only catalog URLs should avoid Blob listing");
      },
    },
    fetchImpl: async (url) => {
      assert.equal(url, "https://blob.test/demo/benchmarks/part.step");
      return {
        ok: true,
        headers: {
          get: () => "application/step",
        },
        arrayBuffer: async () => stepBytes.buffer.slice(stepBytes.byteOffset, stepBytes.byteOffset + stepBytes.byteLength),
      };
    },
  });

  const access = await backend.resolveFileAssetAccess({
    fileRef: "benchmarks/part.step",
    asset: "output",
    catalog,
  });
  const status = await backend.readStepSourceStatus({
    fileRef: "benchmarks/part.step",
    catalog,
  });
  const download = await backend.readFileAsset({
    fileRef: "benchmarks/part.step",
    asset: "output",
    catalog,
  });

  assert.equal(access.url, "https://blob.test/demo/benchmarks/part.step");
  assert.equal(status.step.status, "current");
  assert.equal(download.body.toString("utf-8"), stepBytes.toString("utf-8"));
});

test("read-only Vercel Blob backend downloads cataloged GLB artifact files", async () => {
  const glbBytes = Buffer.from("glb");
  const catalog = {
    schemaVersion: 4,
    entries: [
      {
        file: "benchmarks/part.step",
        kind: "part",
        url: "https://blob.test/demo/benchmarks/.part.step.glb",
        source: {
          file: "benchmarks/part.step",
          url: "https://blob.test/demo/benchmarks/part.step",
        },
      },
    ],
  };
  const backend = createVercelBlobAssetBackend({
    readOnly: true,
    prefix: "demo",
    client: {
      list: async () => {
        throw new Error("read-only catalog URLs should avoid Blob listing");
      },
    },
    fetchImpl: async (url) => {
      assert.equal(url, "https://blob.test/demo/benchmarks/.part.step.glb");
      return {
        ok: true,
        headers: {
          get: () => "model/gltf-binary",
        },
        arrayBuffer: async () => glbBytes.buffer.slice(glbBytes.byteOffset, glbBytes.byteOffset + glbBytes.byteLength),
      };
    },
  });

  const access = await backend.resolveFileAssetAccess({
    fileRef: "benchmarks/part.step",
    asset: "artifact",
    catalog,
  });
  const download = await backend.readFileAsset({
    fileRef: "benchmarks/part.step",
    asset: "artifact",
    catalog,
  });

  assert.equal(access.asset, "artifact");
  assert.equal(access.url, "https://blob.test/demo/benchmarks/.part.step.glb");
  assert.equal(access.filename, ".part.step.glb");
  assert.equal(download.contentType, "model/gltf-binary");
  assert.equal(download.body.toString("utf-8"), "glb");
});

test("Vercel Blob backend keeps STEP source URLs separate from Python source code URLs", async () => {
  const stepBytes = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
  const catalog = {
    schemaVersion: 4,
    entries: [
      {
        file: "parts/bracket.step",
        kind: "part",
        sourceKind: "python",
        url: "https://blob.test/models2/parts/.bracket.step.glb",
        step: {
          file: "parts/bracket.step",
          url: "https://blob.test/models2/parts/bracket.step",
        },
        source: {
          file: "parts/bracket.py",
          url: "https://blob.test/models2/parts/bracket.py",
        },
      },
    ],
  };
  const fetchedUrls = [];
  const backend = createVercelBlobAssetBackend({
    readOnly: true,
    prefix: "https://blob.test/models2",
    fetchImpl: async (url) => {
      fetchedUrls.push(url);
      return {
        ok: true,
        headers: {
          get: () => "application/step",
        },
        arrayBuffer: async () => stepBytes.buffer.slice(stepBytes.byteOffset, stepBytes.byteOffset + stepBytes.byteLength),
      };
    },
  });

  const output = await backend.readFileAsset({
    fileRef: "parts/bracket.step",
    asset: "output",
    catalog,
  });
  const status = await backend.readStepSourceStatus({
    fileRef: "parts/bracket.step",
    catalog,
  });

  await assert.rejects(
    () => backend.readFileAsset({
      fileRef: "parts/bracket.step",
      asset: "source",
      catalog,
    }),
    /Source code is not available in Vercel Blob deployments/
  );
  assert.equal(output.file, "parts/bracket.step");
  assert.equal(output.body.toString("utf-8"), stepBytes.toString("utf-8"));
  assert.equal(status.step.status, "current");
  assert.deepEqual(fetchedUrls, [
    "https://blob.test/models2/parts/bracket.step",
  ]);
});

test("Vercel Blob backend refuses explicitly cataloged source code assets", async () => {
  const catalog = {
    schemaVersion: 4,
    entries: [
      {
        file: "benchmarks/part.step",
        kind: "part",
        source: {
          file: "benchmarks/part.py",
        },
      },
    ],
  };
  const backend = createVercelBlobAssetBackend({
    prefix: "demo",
    client: {
      list: async () => {
        throw new Error("source code should not be looked up in Vercel Blob");
      },
    },
    fetchImpl: async () => {
      throw new Error("source code should not be fetched from Vercel Blob");
    },
    token: "test-token",
  });

  await assert.rejects(
    () => backend.resolveFileAssetAccess({
      fileRef: "benchmarks/part.step",
      asset: "source",
      catalog,
    }),
    /Source code is not available in Vercel Blob deployments/
  );
  await assert.rejects(
    () => backend.readFileAsset({
      fileRef: "benchmarks/part.step",
      asset: "source",
      catalog,
    }),
    /Source code is not available in Vercel Blob deployments/
  );
});

test("Vercel Blob backend can explicitly disable STEP artifact generation", async () => {
  const backend = createVercelBlobAssetBackend({
    stepArtifactGenerator: null,
  });

  assert.equal(backend.canGenerateStepArtifacts, false);
  await assert.rejects(
    () => backend.generateStepArtifact({ fileRef: "part.step" }),
    /does not run local CAD generation/
  );
});

test("Vercel Blob backend can be constructed read-only for hosted deployments", async () => {
  const backend = createVercelBlobAssetBackend({
    readOnly: true,
    prefix: "https://blob.test/models2",
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => ({ schemaVersion: 4, url }),
    }),
  });

  assert.equal(backend.readOnly, true);
  assert.equal(backend.canGenerateStepArtifacts, false);
  assert.equal("writeAsset" in backend, false);
  assert.equal("writeCatalog" in backend, false);
  assert.equal("generateStepArtifact" in backend, false);
  assert.equal(backend.prefix, "models2");
  assert.equal(backend.catalogPath, "models2/catalog.json");
  assert.deepEqual(await backend.readCatalog(), {
    schemaVersion: 4,
    url: "https://blob.test/models2/catalog.json",
  });
});

test("Vercel Blob backend can delegate STEP artifact generation to a worker hook", async () => {
  const backend = createVercelBlobAssetBackend({
    client: {
      put: async (pathname) => ({ pathname, url: `https://blob.test/${pathname}` }),
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ schemaVersion: 4, entries: [] }),
    }),
    stepArtifactGenerator: async ({ fileRef, writeAsset }) => {
      const upload = await writeAsset({
        fileRef: "models/.part.step.glb",
        body: Buffer.from("glb"),
        contentType: "model/gltf-binary",
      });
      return {
        ok: true,
        fileRef,
        upload,
      };
    },
    token: "test-token",
  });

  assert.equal(backend.canGenerateStepArtifacts, true);
  assert.deepEqual(await backend.generateStepArtifact({ fileRef: "models/part.step" }), {
    ok: true,
    fileRef: "models/part.step",
    upload: {
      pathname: "models/.part.step.glb",
      url: "https://blob.test/models/.part.step.glb",
    },
  });
});
