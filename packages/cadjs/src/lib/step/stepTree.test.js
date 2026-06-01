import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildStepTreeRoot,
  collectStepTreeAncestorIds,
  flattenVisibleStepTreeRows,
  STEP_MODEL_RENDER_PART_ID,
  STEP_MODEL_ROOT_ID,
  stepTreeRootChildIndexForNode,
  stepTreeNodeLeafPartIds
} from "./stepTree.js";

const nestedRoot = {
  id: "root",
  nodeType: "assembly",
  displayName: "root assembly",
  children: [
    {
      id: "sub",
      nodeType: "assembly",
      displayName: "sub assembly",
      children: [
        {
          id: "leaf-a",
          nodeType: "part",
          displayName: "leaf A",
          children: []
        },
        {
          id: "leaf-b",
          nodeType: "part",
          displayName: "leaf B",
          children: []
        }
      ]
    },
    {
      id: "leaf-c",
      nodeType: "part",
      displayName: "leaf C",
      children: []
    }
  ]
};

test("visible STEP tree rows follow independent expansion state", () => {
  assert.deepEqual(
    flattenVisibleStepTreeRows(nestedRoot, []).map((row) => row.id),
    ["root"]
  );
  assert.deepEqual(
    flattenVisibleStepTreeRows(nestedRoot, ["root"]).map((row) => [row.id, row.depth, row.expanded]),
    [
      ["root", 0, true],
      ["sub", 1, false],
      ["leaf-c", 1, false]
    ]
  );
  assert.deepEqual(
    flattenVisibleStepTreeRows(nestedRoot, ["root", "sub"]).map((row) => row.id),
    ["root", "sub", "leaf-a", "leaf-b", "leaf-c"]
  );
});

test("visible STEP tree rows can elide a wrapper root assembly", () => {
  assert.deepEqual(
    flattenVisibleStepTreeRows(nestedRoot, [], { omitRoot: true }).map((row) => [row.id, row.depth, row.expanded]),
    [
      ["sub", 0, false],
      ["leaf-c", 0, false]
    ]
  );
  assert.deepEqual(
    flattenVisibleStepTreeRows(nestedRoot, ["sub"], { omitRoot: true }).map((row) => [row.id, row.depth]),
    [
      ["sub", 0],
      ["leaf-a", 1],
      ["leaf-b", 1],
      ["leaf-c", 0]
    ]
  );
});

test("visible STEP tree rows can limit only root assembly items", () => {
  const root = {
    id: "root-many",
    nodeType: "assembly",
    children: Array.from({ length: 18 }, (_, index) => ({
      id: `root-child-${index + 1}`,
      nodeType: "part",
      displayName: `Root child ${index + 1}`,
      children: []
    }))
  };

  assert.deepEqual(
    flattenVisibleStepTreeRows(root, [], {
      omitRoot: true,
      rootChildLimit: 15,
      showAllRootChildren: false
    }).map((row) => row.id),
    Array.from({ length: 15 }, (_, index) => `root-child-${index + 1}`)
  );
  assert.deepEqual(
    flattenVisibleStepTreeRows(root, [], {
      omitRoot: true,
      rootChildLimit: 15,
      showAllRootChildren: true
    }).map((row) => row.id),
    Array.from({ length: 18 }, (_, index) => `root-child-${index + 1}`)
  );
});

test("root item limit does not limit nested assembly descendants", () => {
  const root = {
    id: "root-nested-limit",
    nodeType: "assembly",
    children: [
      {
        id: "large-sub",
        nodeType: "assembly",
        displayName: "large sub assembly",
        children: Array.from({ length: 18 }, (_, index) => ({
          id: `large-sub-child-${index + 1}`,
          nodeType: "part",
          displayName: `Large sub child ${index + 1}`,
          children: []
        }))
      },
      {
        id: "root-hidden",
        nodeType: "part",
        displayName: "hidden root child",
        children: []
      }
    ]
  };

  assert.deepEqual(
    flattenVisibleStepTreeRows(root, ["large-sub"], {
      omitRoot: true,
      rootChildLimit: 1,
      showAllRootChildren: false
    }).map((row) => row.id),
    [
      "large-sub",
      ...Array.from({ length: 18 }, (_, index) => `large-sub-child-${index + 1}`)
    ]
  );
});

test("STEP tree query keeps matching descendants visible with ancestors", () => {
  assert.deepEqual(
    flattenVisibleStepTreeRows(nestedRoot, [], { query: "leaf b" }).map((row) => row.id),
    ["root", "sub", "leaf-b"]
  );
});

test("STEP tree query supports elided wrapper roots", () => {
  assert.deepEqual(
    flattenVisibleStepTreeRows(nestedRoot, [], { query: "leaf b", omitRoot: true }).map((row) => row.id),
    ["sub", "leaf-b"]
  );
});

test("STEP tree leaf ids include nested descendant parts", () => {
  assert.deepEqual(stepTreeNodeLeafPartIds(nestedRoot.children[0]), ["leaf-a", "leaf-b"]);
});

test("plain STEP parts get a synthetic selectable root", () => {
  const root = buildStepTreeRoot({
    selectedEntry: {
      file: "parts/bracket.step",
      kind: "part"
    },
    meshData: {
      bounds: {
        min: [0, 0, 0],
        max: [1, 2, 3]
      }
    }
  });
  assert.equal(root.id, STEP_MODEL_ROOT_ID);
  assert.equal(root.displayName, "bracket.step");
  assert.deepEqual(root.leafPartIds, [STEP_MODEL_RENDER_PART_ID]);
});

test("ancestor ids are collected without the selected node", () => {
  assert.deepEqual(collectStepTreeAncestorIds(nestedRoot, "leaf-b"), ["root", "sub"]);
});

test("root child index resolves direct children and descendants", () => {
  assert.equal(stepTreeRootChildIndexForNode(nestedRoot, "sub"), 0);
  assert.equal(stepTreeRootChildIndexForNode(nestedRoot, "leaf-b"), 0);
  assert.equal(stepTreeRootChildIndexForNode(nestedRoot, "leaf-c"), 1);
  assert.equal(stepTreeRootChildIndexForNode(nestedRoot, "root"), -1);
  assert.equal(stepTreeRootChildIndexForNode(nestedRoot, "missing"), -1);
});
