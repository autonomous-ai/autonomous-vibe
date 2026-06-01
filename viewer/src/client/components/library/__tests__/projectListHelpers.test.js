import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectListItems,
  formatRelativeDate,
  sortProjects,
  validateNewProjectName,
} from "../projectListHelpers.js";

const now = new Date("2026-05-28T12:00:00Z").getTime();

const projectA = {
  id: "p-a",
  name: "Alpha",
  createdAt: now - 7 * 24 * 60 * 60 * 1000,
  updatedAt: now - 24 * 60 * 60 * 1000,
  hasModel: true,
};
const projectB = {
  id: "p-b",
  name: "Bravo",
  createdAt: now - 3 * 24 * 60 * 60 * 1000,
  updatedAt: now - 60 * 60 * 1000,
  hasModel: false,
};
const projectC = {
  id: "p-c",
  name: "Charlie",
  createdAt: now,
  updatedAt: now - 60 * 60 * 1000,
  hasModel: false,
};

test("sortProjects sorts newest-first and breaks ties by name", () => {
  const sorted = sortProjects([projectA, projectC, projectB]);
  assert.deepEqual(
    sorted.map((p) => p.id),
    ["p-b", "p-c", "p-a"],
    "Bravo and Charlie share an updatedAt; Bravo wins on name order",
  );
});

test("formatRelativeDate covers today / yesterday / N-days windows", () => {
  assert.equal(formatRelativeDate(now - 60 * 1000, now), "Today");
  assert.equal(formatRelativeDate(now - 24 * 60 * 60 * 1000 - 60 * 1000, now), "Yesterday");
  assert.equal(formatRelativeDate(now - 3 * 24 * 60 * 60 * 1000, now), "3 days ago");
  assert.equal(formatRelativeDate(0, now), "—", "epoch-zero is treated as missing");
});

test("buildProjectListItems returns empty=true for no projects", () => {
  const result = buildProjectListItems([], null, now);
  assert.equal(result.empty, true);
  assert.deepEqual(result.items, []);
});

test("buildProjectListItems returns rows with selection state", () => {
  const result = buildProjectListItems([projectA, projectB], "p-a", now);
  assert.equal(result.empty, false);
  assert.equal(result.items.length, 2);
  const alpha = result.items.find((item) => item.id === "p-a");
  assert.ok(alpha);
  assert.equal(alpha.selected, true);
  assert.equal(alpha.hasModel, true);
  assert.equal(alpha.relativeUpdatedAt, "Yesterday");
  const bravo = result.items.find((item) => item.id === "p-b");
  assert.equal(bravo.selected, false);
  assert.equal(bravo.relativeUpdatedAt, "Today");
});

test("buildProjectListItems substitutes a placeholder name when missing", () => {
  const result = buildProjectListItems(
    [{ id: "x", name: "", updatedAt: now, hasModel: false }],
    null,
    now,
  );
  assert.equal(result.items[0].name, "Untitled project");
});

test("validateNewProjectName flags empty, long, and duplicate names", () => {
  assert.equal(validateNewProjectName(""), "Name is required");
  assert.equal(validateNewProjectName("    "), "Name is required");
  assert.equal(validateNewProjectName("a".repeat(65)), "Name must be 64 characters or fewer");
  assert.equal(
    validateNewProjectName("Alpha", ["alpha", "beta"]),
    "A project with that name already exists",
    "name comparison is case-insensitive",
  );
  assert.equal(validateNewProjectName("Alpha", ["beta"]), "");
});
