import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createIgnoreMatcher,
  DEFAULT_UPLOAD_EXCLUDE_PATTERNS,
  parseIgnorePatterns,
  parseUploadArgs,
  rewriteCatalogForBlob,
  uploadCatalogDirectoryToVercelBlob,
} from "./upload-catalog-to-blob.mjs";

function makeTempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cad-viewer-blob-upload-"));
}

function writeFile(filePath, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test("upload ignore patterns support comments, directory patterns, globs, and negation", () => {
  const patterns = parseIgnorePatterns(`
# comment
/mechbench/
*.tmp
!keep.tmp
`);
  const ignored = createIgnoreMatcher(patterns);

  assert.equal(ignored({ relativePath: "mechbench", isDirectory: true }), true);
  assert.equal(ignored({ relativePath: "mechbench/part.step" }), true);
  assert.equal(ignored({ relativePath: "nested/file.tmp" }), true);
  assert.equal(ignored({ relativePath: "keep.tmp" }), false);
  assert.equal(ignored({ relativePath: "parts/keep.step" }), false);
});

test("parseUploadArgs accepts a directory and repeated ignore options", () => {
  assert.deepEqual(
    parseUploadArgs([
      "models",
      "--ignore-file",
      ".vieweruploadignore",
      "--exclude",
      "/mechbench/",
      "--exclude",
      "/mechbench2/",
      "--concurrency",
      "2",
    ], {}),
    {
      directory: "models",
      rootDir: "",
      ignoreFiles: [".vieweruploadignore"],
      excludePatterns: ["/mechbench/", "/mechbench2/"],
      concurrency: 2,
    }
  );
});

test("parseUploadArgs accepts root-dir and rejects workspace-root", () => {
  assert.deepEqual(
    parseUploadArgs(["--root-dir", "/repo/models"], {}),
    {
      directory: "",
      rootDir: "/repo/models",
      ignoreFiles: [],
      excludePatterns: [],
      concurrency: 4,
    }
  );
  assert.throws(
    () => parseUploadArgs(["--workspace-root", "/repo"], {}),
    /Unknown option: --workspace-root/
  );
});

test("rewriteCatalogForBlob annotates STEP assets without publishing Python source refs", () => {
  const repoRoot = makeTempRepo();
  const rootPath = path.join(repoRoot, "models");
  writeFile(path.join(rootPath, "parts/bracket.step"), "ISO-10303-21;\nEND-ISO-10303-21;\n");
  writeFile(path.join(rootPath, "parts/bracket.py"), "def gen_step():\n    return None\n");
  const uploads = new Map([
    ["parts/bracket.step", {
      fileRef: "parts/bracket.step",
      filePath: path.join(rootPath, "parts/bracket.step"),
      url: "https://blob.test/models2/parts/bracket.step",
      hash: "step-hash",
      bytes: 12,
    }],
    ["parts/bracket.py", {
      fileRef: "parts/bracket.py",
      filePath: path.join(rootPath, "parts/bracket.py"),
      url: "https://blob.test/models2/parts/bracket.py",
      hash: "py-hash",
      bytes: 34,
    }],
  ]);

  const catalog = rewriteCatalogForBlob({
    schemaVersion: 4,
    entries: [
      {
        file: "parts/bracket.step",
        kind: "part",
        sourceKind: "python",
        source: {
          file: "models/parts/bracket.py",
          sourcePath: "models/parts/bracket.py",
          sourceHash: "source-hash",
        },
        sourceStatus: {
          sourceKind: "python",
          sourcePath: "models/parts/bracket.py",
        },
      },
    ],
  }, {
    uploads,
    repoRoot,
    rootPath,
  });

  assert.deepEqual(catalog.entries[0].step, {
    file: "parts/bracket.step",
    url: "https://blob.test/models2/parts/bracket.step",
    hash: "step-hash",
    bytes: 12,
  });
  assert.equal(catalog.entries[0].sourceKind, "python");
  assert.equal(catalog.entries[0].source, undefined);
  assert.equal(catalog.entries[0].sourceStatus, undefined);
  assert.equal(JSON.stringify(catalog).includes(".py"), false);
});

test("uploadCatalogDirectoryToVercelBlob applies default catalog exclusions", async () => {
  const repoRoot = makeTempRepo();
  writeFile(path.join(repoRoot, "models/keep.stl"), "solid keep\nendsolid keep\n");
  writeFile(path.join(repoRoot, "models/part.step"), "ISO-10303-21;\nEND-ISO-10303-21;\n");
  writeFile(path.join(repoRoot, "models/.part.step.js"), "export default { manifest: { schemaVersion: 1 } };\n");
  writeFile(path.join(repoRoot, "models/mechbench/skipped.stl"), "solid skip\nendsolid skip\n");
  writeFile(path.join(repoRoot, "models/mechbench2/skipped.stl"), "solid skip\nendsolid skip\n");
  writeFile(path.join(repoRoot, "models/7dof_arm/skipped.step"), "ISO-10303-21;\nEND-ISO-10303-21;\n");
  writeFile(path.join(repoRoot, "models/source.py"), "def gen_step():\n    return None\n");
  const putCalls = [];

  const result = await uploadCatalogDirectoryToVercelBlob({
    directory: "models",
    env: {
      VIEWER_ASSET_BACKEND: "vercel-blob",
      VIEWER_VERCEL_BLOB_PREFIX: "models2",
      VIEWER_VERCEL_BLOB_READ_WRITE_TOKEN: "test-token",
    },
    cwd: repoRoot,
    client: {
      put: async (pathname, body, options) => {
        putCalls.push({ pathname, body, options });
        return { pathname, url: `https://blob.test/${pathname}` };
      },
    },
    logger: { log() {} },
  });

  assert.deepEqual(putCalls.map((call) => call.pathname).sort(), [
    "models2/.part.step.js",
    "models2/catalog.json",
    "models2/keep.stl",
    "models2/part.step",
  ]);
  assert.equal(
    putCalls.find((call) => call.pathname === "models2/.part.step.js").options.contentType,
    "text/javascript; charset=utf-8",
  );
  assert.equal(putCalls.find((call) => call.pathname === "models2/keep.stl").options.contentType, "model/stl");
  assert.equal(result.uploadedFiles, 3);
  assert.equal(result.catalogEntries, 2);
  assert.equal(result.rootDir, "");
  assert.equal(result.rootPath, path.join(repoRoot, "models"));

  const catalogUpload = putCalls.find((call) => call.pathname === "models2/catalog.json");
  const uploadedCatalog = JSON.parse(catalogUpload.body);
  assert.deepEqual(uploadedCatalog.entries.map((entry) => entry.file), ["keep.stl", "part.step"]);
  assert.equal(uploadedCatalog.entries[0].url, "https://blob.test/models2/keep.stl");
  assert.equal(uploadedCatalog.entries[1].step.url, "https://blob.test/models2/part.step");
  assert.equal(uploadedCatalog.entries[1].moduleUrl, "https://blob.test/models2/.part.step.js");
  assert.deepEqual(result.ignoredPatterns.slice(0, DEFAULT_UPLOAD_EXCLUDE_PATTERNS.length), DEFAULT_UPLOAD_EXCLUDE_PATTERNS);
});

test("uploadCatalogDirectoryToVercelBlob honors rootDir from npm caller cwd", async () => {
  const repoRoot = makeTempRepo();
  writeFile(path.join(repoRoot, "models/keep.stl"), "solid keep\nendsolid keep\n");
  writeFile(path.join(repoRoot, "viewer/package.json"), "{}\n");
  const putCalls = [];

  const result = await uploadCatalogDirectoryToVercelBlob({
    rootDir: "models",
    env: {
      INIT_CWD: repoRoot,
      VIEWER_ASSET_BACKEND: "vercel-blob",
      VIEWER_VERCEL_BLOB_PREFIX: "models2",
      VIEWER_VERCEL_BLOB_READ_WRITE_TOKEN: "test-token",
    },
    cwd: path.join(repoRoot, "viewer"),
    client: {
      put: async (pathname, body, options) => {
        putCalls.push({ pathname, body, options });
        return { pathname, url: `https://blob.test/${pathname}` };
      },
    },
    logger: { log() {} },
  });

  assert.deepEqual(putCalls.map((call) => call.pathname).sort(), [
    "models2/catalog.json",
    "models2/keep.stl",
  ]);
  assert.equal(result.catalogEntries, 1);
  assert.equal(result.rootDir, "");
  assert.equal(result.rootPath, path.join(repoRoot, "models"));
});
