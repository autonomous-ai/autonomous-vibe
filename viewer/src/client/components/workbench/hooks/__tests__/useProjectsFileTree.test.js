import assert from "node:assert/strict";
import test from "node:test";

import {
  computeProjectNode,
  entryMatchesQuery,
  projectNameMatches,
} from "../projectFileTree.js";

const project = (id, name) => ({ id, name });
const entry = (file, kind = "step") => ({ file, kind });
const tree = { id: "", name: "Workspace", entries: [], directories: [] };

test("projectNameMatches / entryMatchesQuery are case-insensitive substring matches", () => {
  assert.equal(projectNameMatches("Token Organizer", "token"), true);
  assert.equal(projectNameMatches("Token Organizer", "zzz"), false);
  assert.equal(entryMatchesQuery(entry("lid.step"), "lid"), true);
  assert.equal(entryMatchesQuery(entry("lid.step"), "stack"), false);
});

test("active project: shown without a query, using the pre-filtered active tree", () => {
  const node = computeProjectNode({
    project: project("p1", "Active"),
    isActive: true,
    queryActive: false,
    normalizedQuery: "",
    userExpanded: true,
    activeEntries: [entry("lid.step")],
    activeEntriesTree: tree,
  });
  assert.equal(node.isActive, true);
  assert.equal(node.tree, tree);
  assert.equal(node.hasFiles, true);
  assert.equal(node.expanded, true);
});

test("active project: hidden under a query that matches neither name nor files", () => {
  const node = computeProjectNode({
    project: project("p1", "Active"),
    isActive: true,
    queryActive: true,
    normalizedQuery: "zzz",
    userExpanded: false,
    activeEntries: [], // CadWorkspace already filtered out non-matches
    activeEntriesTree: tree,
  });
  assert.equal(node, null);
});

test("active project: force-expanded while a query is active", () => {
  const node = computeProjectNode({
    project: project("p1", "Active"),
    isActive: true,
    queryActive: true,
    normalizedQuery: "lid",
    userExpanded: false,
    activeEntries: [entry("lid.step")],
    activeEntriesTree: tree,
  });
  assert.equal(node.expanded, true);
});

test("non-active loaded project: shown with its own tree when not searching", () => {
  const node = computeProjectNode({
    project: project("p2", "Other"),
    isActive: false,
    queryActive: false,
    normalizedQuery: "",
    userExpanded: false,
    catalog: { entries: [entry("tray.step"), entry("lid.step")], status: "ready", error: "" },
  });
  assert.equal(node.isActive, false);
  assert.equal(node.status, "ready");
  assert.equal(node.hasFiles, true);
  assert.equal(node.tree.entries.length, 2);
});

test("non-active project: name match surfaces it even before its files load", () => {
  const node = computeProjectNode({
    project: project("p2", "Token Organizer"),
    isActive: false,
    queryActive: true,
    normalizedQuery: "token",
    userExpanded: false,
    catalog: undefined, // not loaded yet
  });
  assert.notEqual(node, null);
  assert.equal(node.status, "idle");
  assert.equal(node.expanded, true);
});

test("non-active unloaded project with no name match is hidden under a query", () => {
  const node = computeProjectNode({
    project: project("p2", "Other"),
    isActive: false,
    queryActive: true,
    normalizedQuery: "lid",
    userExpanded: false,
    catalog: undefined,
  });
  assert.equal(node, null);
});

test("non-active loaded project: filtered to file matches under a query", () => {
  const node = computeProjectNode({
    project: project("p2", "Other"),
    isActive: false,
    queryActive: true,
    normalizedQuery: "lid",
    userExpanded: false,
    catalog: { entries: [entry("tray.step"), entry("lid.step")], status: "ready", error: "" },
  });
  assert.notEqual(node, null);
  assert.equal(node.tree.entries.length, 1);
  assert.equal(node.tree.entries[0].file, "lid.step");
});

test("non-active loaded project with no match is hidden under a query", () => {
  const node = computeProjectNode({
    project: project("p2", "Other"),
    isActive: false,
    queryActive: true,
    normalizedQuery: "zzz",
    userExpanded: false,
    catalog: { entries: [entry("tray.step")], status: "ready", error: "" },
  });
  assert.equal(node, null);
});
