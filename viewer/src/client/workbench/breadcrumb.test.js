import assert from "node:assert/strict";
import test from "node:test";

import { buildBreadcrumbNodes } from "./breadcrumb.js";
import { buildSidebarDirectoryTree, listSidebarItems } from "./sidebar.js";

// A consumer project where the cadcode pipeline wrote multiple STL parts as
// bare filenames at the project root — the exact shape behind the
// "can't switch between STL parts" bug.
const ROOT_LEVEL_ENTRIES = [
  { file: "esp32_enclosure_base.stl", kind: "stl", url: "pandaasset://x/esp32_enclosure_base.stl", hash: "h1" },
  { file: "esp32_enclosure_lid.stl", kind: "stl", url: "pandaasset://x/esp32_enclosure_lid.stl", hash: "h2" }
];

function browseEntryKeys(nodes) {
  // Collect the entry keys reachable from any browsable crumb's dropdown.
  const keys = new Set();
  for (const node of nodes) {
    if (!node?.menuDirectory) {
      continue;
    }
    for (const item of listSidebarItems(node.menuDirectory)) {
      if (item.type === "entry") {
        keys.add(item.key);
      }
    }
  }
  return keys;
}

test("root-level models stay switchable from the breadcrumb", () => {
  const directoryTree = buildSidebarDirectoryTree(ROOT_LEVEL_ENTRIES);
  const selectedEntry = ROOT_LEVEL_ENTRIES[0];
  const nodes = buildBreadcrumbNodes({
    directoryTree,
    selectedEntry,
    selectedFileLabel: "esp32_enclosure_base.stl",
    selectedFileTitle: "esp32_enclosure_base.stl"
  });

  // There must be a browsable crumb (one carrying a menuDirectory) — without
  // it the breadcrumb collapses to just the current file and the user can't
  // reach the sibling STL.
  const browsable = nodes.filter((node) => node.menuDirectory);
  assert.ok(browsable.length > 0, "expected a browsable breadcrumb crumb for a root-level selection");

  // Both root-level STL parts must be reachable from the breadcrumb dropdown.
  const reachable = browseEntryKeys(nodes);
  assert.ok(
    reachable.has("entry:esp32_enclosure_base.stl"),
    "base STL should be reachable from the breadcrumb"
  );
  assert.ok(
    reachable.has("entry:esp32_enclosure_lid.stl"),
    "sibling lid STL should be reachable from the breadcrumb"
  );

  // The current file is still represented as the trailing leaf node.
  const last = nodes[nodes.length - 1];
  assert.equal(last.type, "entry");
  assert.equal(last.entry, selectedEntry);
});

test("nested models remain browsable via their parent folder crumb", () => {
  const nestedEntries = [
    { file: "parts/base.stl", kind: "stl", url: "pandaasset://x/parts/base.stl", hash: "h1" },
    { file: "parts/lid.stl", kind: "stl", url: "pandaasset://x/parts/lid.stl", hash: "h2" }
  ];
  const directoryTree = buildSidebarDirectoryTree(nestedEntries);
  const nodes = buildBreadcrumbNodes({
    directoryTree,
    selectedEntry: nestedEntries[0],
    selectedFileLabel: "base.stl",
    selectedFileTitle: "parts/base.stl"
  });

  const reachable = browseEntryKeys(nodes);
  assert.ok(reachable.has("entry:parts/base.stl"));
  assert.ok(reachable.has("entry:parts/lid.stl"));
});

test("no selection still exposes a browsable placeholder", () => {
  const directoryTree = buildSidebarDirectoryTree(ROOT_LEVEL_ENTRIES);
  const nodes = buildBreadcrumbNodes({
    directoryTree,
    selectedEntry: null,
    selectedFileLabel: "Select a model",
    selectedFileTitle: "Select a model"
  });
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, "placeholder");
  assert.ok(nodes[0].menuDirectory, "placeholder should browse the workspace root");
});
