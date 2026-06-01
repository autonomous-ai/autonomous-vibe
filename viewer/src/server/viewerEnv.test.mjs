import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeViewerAssetBackend,
  rootDirForAssetBackend,
  vercelBlobCatalogUrlFromPrefix,
  vercelBlobConfigFromEnv,
  VIEWER_ASSET_BACKENDS,
} from "./viewerEnv.mjs";

test("viewer env forks root configuration by asset backend", () => {
  assert.equal(
    rootDirForAssetBackend(VIEWER_ASSET_BACKENDS.LOCAL_FS, { VIEWER_LOCAL_ROOT_DIR: "models" }),
    "models"
  );
  assert.equal(
    rootDirForAssetBackend(VIEWER_ASSET_BACKENDS.VERCEL_BLOB, { VIEWER_LOCAL_ROOT_DIR: "models" }),
    ""
  );
});

test("viewer env reads Blob settings", () => {
  assert.deepEqual(
    vercelBlobConfigFromEnv({
      VIEWER_VERCEL_BLOB_PREFIX: "https://blob.example/models2/",
      VIEWER_VERCEL_BLOB_READ_WRITE_TOKEN: "test-token",
    }),
    {
      prefix: "https://blob.example/models2/",
      catalogPath: "catalog.json",
      catalogUrl: "https://blob.example/models2/catalog.json",
      token: "test-token",
    }
  );
});

test("viewer env derives catalog URL only from public Blob URL prefixes", () => {
  assert.equal(
    vercelBlobCatalogUrlFromPrefix("https://blob.example/models2"),
    "https://blob.example/models2/catalog.json"
  );
  assert.equal(vercelBlobCatalogUrlFromPrefix("models2"), "");
});

test("viewer env rejects unsupported asset backends", () => {
  assert.throws(
    () => normalizeViewerAssetBackend("s3"),
    /Unsupported VIEWER_ASSET_BACKEND/
  );
});
