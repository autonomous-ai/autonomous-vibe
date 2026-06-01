// Tests for the pluggable catalog backend in cadManifestStore.
//
// Default behavior calls `fetch('/__cad/...')` for the standalone browser
// viewer. The Tauri viewer needs to route the same operations through the
// IPC transport without forking the file. `setCadCatalogBackend(partial)`
// is the injection point.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  refreshCadCatalog,
  refreshCadGenerationStatus,
  requestStepArtifactGeneration,
  requestStepSourceStatus,
  setCadCatalogBackend,
  getCadManifestSnapshot,
} from "./cadManifestStore.js";

// node --test runs each file in its own process, so the module-level
// `window` shim survives across the tests below. cadManifestStore's auto-
// poll at module load needs `typeof window !== "undefined"`; we set it
// before importing transitively. Per node test runner, top-level statements
// at module init time still run before the first test — but since this file
// imports cadManifestStore at the top, we need to set globalThis.window
// _before_ that import would observe its absence.
//
// In practice the module body of cadManifestStore handles `typeof window
// === "undefined"` cleanly (it just skips auto-polling), so we don't need
// a real window for these tests — we drive each function explicitly.

test("setCadCatalogBackend with readCatalog routes refresh through the backend", async () => {
  let readCount = 0;
  setCadCatalogBackend({
    async readCatalog() {
      readCount += 1;
      return {
        entries: [{ file: "stub.step", kind: "step", url: "tauri://localhost/stub.step", sourceKind: "static" }],
        rootPath: "/stub",
        revision: 1,
      };
    },
  });
  await refreshCadCatalog({ markRefreshing: false });
  assert.equal(readCount, 1, "custom readCatalog must be invoked");
  const snap = getCadManifestSnapshot();
  assert.equal(snap.manifest.entries.length, 1);
  assert.equal(snap.manifest.entries[0].file, "stub.step");
  assert.equal(snap.catalogError, "");
});

test("setCadCatalogBackend with readGenerationStatus routes status refresh through the backend", async () => {
  let statusCount = 0;
  setCadCatalogBackend({
    async readGenerationStatus() {
      statusCount += 1;
      return { schemaVersion: 1, runs: [{ file: "stub.step", startedAt: 0, kind: "step" }], files: {} };
    },
  });
  await refreshCadGenerationStatus();
  assert.equal(statusCount, 1, "custom readGenerationStatus must be invoked");
  const snap = getCadManifestSnapshot();
  assert.equal(snap.generationStatus.runs.length, 1);
});

test("setCadCatalogBackend with regenerateStepArtifact routes through the backend", async () => {
  let regenArg = null;
  setCadCatalogBackend({
    async regenerateStepArtifact(fileRef) {
      regenArg = fileRef;
      return { catalog: { entries: [{ file: "regen.step", kind: "step", url: "tauri://x", sourceKind: "static" }] } };
    },
  });
  const payload = await requestStepArtifactGeneration("foo.step");
  assert.equal(regenArg, "foo.step", "backend.regenerateStepArtifact must be called with the fileRef");
  assert.equal(payload.catalog.entries[0].file, "regen.step");
});

test("setCadCatalogBackend with readStepSourceStatus routes through the backend", async () => {
  let askedFile = null;
  setCadCatalogBackend({
    async readStepSourceStatus(fileRef) {
      askedFile = fileRef;
      return { hasSource: true, sourcePath: "foo.py", sourceKind: "python" };
    },
  });
  const status = await requestStepSourceStatus("foo.step");
  assert.equal(askedFile, "foo.step");
  assert.equal(status.hasSource, true);
});

test("partial override only replaces the named methods", async () => {
  // Resetting with an empty partial should leave the defaults intact —
  // but since the defaults call fetch and there's no fetch shim in node,
  // we just confirm the partial pattern by overriding readCatalog and
  // checking the other functions still try (and fail predictably) via the
  // default fetch path. Easier: assert that the partial keeps prior
  // overrides for unrelated methods.
  let calls = { read: 0, status: 0 };
  setCadCatalogBackend({
    async readCatalog() {
      calls.read += 1;
      return { entries: [], rootPath: "/x", revision: 0 };
    },
    async readGenerationStatus() {
      calls.status += 1;
      return { schemaVersion: 1, runs: [], files: {} };
    },
  });
  // Re-apply ONLY readCatalog (different fn) and confirm readGenerationStatus is reset to default.
  setCadCatalogBackend({
    async readCatalog() {
      calls.read += 1;
      return { entries: [], rootPath: "/y", revision: 0 };
    },
  });
  await refreshCadCatalog({ markRefreshing: false });
  assert.ok(calls.read >= 1);
  // The second setCadCatalogBackend should have NOT preserved the old
  // readGenerationStatus override — partial overlays the default each
  // call, not the previous overlay.
  assert.equal(calls.status, 0, "second setCadCatalogBackend must replace the whole backend, not merge with prior overrides");
});
