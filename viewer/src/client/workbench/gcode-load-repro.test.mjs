import assert from "node:assert/strict";
import test from "node:test";
import { isPrintableModelEntry } from "./isPrintableModelEntry.js";
import { findEntryByUrlPath, missingFileRefForCatalog, fileKey } from "./sidebar.js";
import { withRenderableMeshHashes } from "../lib/cadCatalogBackendTauri.js";
import { entryHasGcode } from "cadjs/lib/entryAssets.js";

// The Rust catalog (scan_workspace) emits entries WITHOUT a per-asset `hash`;
// only `.stl` URLs carry a `?v=` token. This mirrors that real shape — note no
// `hash` on any entry. `withRenderableMeshHashes` (the Tauri catalog adapter)
// is what fills the gap before cadjs sees the catalog.
const rustCatalog = {
  revision: 4,
  entries: [
    { file: "ladybug.gcode", kind: "gcode", url: "pandaasset://localhost/ladybug.gcode?v=7-7" },
    { file: "ladybug.py", kind: "py", url: "pandaasset://localhost/ladybug.py" },
    { file: "ladybug.step", kind: "step", url: "pandaasset://localhost/ladybug.step" },
    { file: "ladybug.stl", kind: "stl", url: "pandaasset://localhost/ladybug.stl?v=1-2" },
  ],
};

const manifestEntries = withRenderableMeshHashes(rustCatalog).entries;

// main.jsx selectableEntries filter.
const selectableEntries = manifestEntries.filter(
  (entry) =>
    isPrintableModelEntry(entry) ||
    String(entry?.kind || "").toLowerCase() === "gcode",
);

test("selectableEntries includes the gcode", () => {
  assert.ok(selectableEntries.some((e) => e.file === "ladybug.gcode"));
});

test("findEntryByUrlPath resolves the gcode against selectableEntries", () => {
  const match = findEntryByUrlPath(selectableEntries, "ladybug.gcode");
  assert.ok(match, "gcode should resolve");
});

test("missingFileRefForCatalog returns empty when gcode resolves", () => {
  const matchingEntry = findEntryByUrlPath(selectableEntries, "ladybug.gcode");
  const ref = missingFileRefForCatalog({
    explicitFileParam: "ladybug.gcode",
    matchingEntry,
    selectedEntry: null,
    catalogHydrated: true,
    catalogRefreshing: false,
    catalogEntryCount: 1,
  });
  assert.equal(ref, "");
});

// The Tauri adapter synthesizes a cache-bust hash for the gcode entry (url +
// revision) just like it does for `.stl`, so a re-slice refetches.
test("withRenderableMeshHashes makes the gcode entry loadable (entryHasGcode)", () => {
  const gcode = manifestEntries.find((e) => e.file === "ladybug.gcode");
  assert.equal(gcode.hash, "pandaasset://localhost/ladybug.gcode?v=7-7#4");
  assert.ok(entryHasGcode(gcode), "entryHasGcode must be true once a hash is synthesized");
});

// The "layers is 0" bug: a catalog that omits the hash (e.g. the HTTP dev
// backend) must STILL be loadable — the toolpath parse only needs the URL, and
// gating it on the hash left `loadGcodeForEntry` early-returning so the file
// sheet showed 0 layers even though gcode-preview rendered the toolpath.
test("entryHasGcode is true for a hash-less gcode entry (URL alone is loadable)", () => {
  const hashless = { file: "plate.gcode", kind: "gcode", url: "http://localhost/plate.gcode" };
  assert.equal(hashless.hash, undefined);
  assert.ok(entryHasGcode(hashless), "a gcode URL must be loadable without a hash");
});
