import assert from "node:assert/strict";
import test from "node:test";

import {
  phaseLabel,
  toolLabel,
  toolDetail,
  aggregateActivityStatus,
  activityDefaultsOpen,
  formatDuration,
} from "../activityLabels.js";

test("toolLabel maps known tools to friendly phrases", () => {
  assert.equal(toolLabel("cadcode"), "Designing");
  assert.equal(toolLabel("Skill"), "Designing");
  assert.equal(toolLabel("Write"), "Writing CAD source");
  assert.equal(toolLabel("Edit"), "Editing CAD source");
  assert.equal(toolLabel("MultiEdit"), "Editing CAD source");
  assert.equal(toolLabel("Read"), "Reading files");
  assert.equal(toolLabel("ExitPlanMode"), "Finalizing plan");
});

test("toolLabel inspects Bash command to distinguish render from generic", () => {
  assert.equal(toolLabel("Bash", { command: "python scripts/cad main.py" }), "Rendering preview");
  assert.equal(toolLabel("Bash", { command: "ls -la" }), "Running command");
  assert.equal(toolLabel("Bash", {}), "Running command");
});

test("toolLabel falls back to a titleized name so nothing is hidden", () => {
  assert.equal(toolLabel("some_new_tool"), "Some New Tool");
  assert.equal(toolLabel(""), "Working");
  assert.equal(toolLabel(undefined), "Working");
});

test("toolDetail surfaces the specific target per tool", () => {
  assert.equal(toolDetail("Read", { file_path: "/a/b/ChatTurn.jsx" }), "ChatTurn.jsx");
  assert.equal(toolDetail("Edit", { file_path: "src\\store\\chat.js" }), "chat.js");
  assert.equal(toolDetail("Grep", { pattern: "chat-working|Working" }), "chat-working|Working");
  assert.equal(toolDetail("Glob", { pattern: "**/*.test.js" }), "**/*.test.js");
  assert.equal(toolDetail("Bash", { command: "npm test" }), "npm test");
  assert.equal(toolDetail("WebSearch", { query: "Lionhead Studios founders" }), "Lionhead Studios founders");
  assert.equal(toolDetail("WebFetch", { url: "https://example.com" }), "https://example.com");
  assert.equal(toolDetail("Task", { description: "explore chat pipeline" }), "explore chat pipeline");
});

test("toolDetail falls back to the first string field for unknown tools", () => {
  assert.equal(toolDetail("some_new_tool", { foo: "  bar  " }), "bar");
  assert.equal(toolDetail("Read", {}), "");
  assert.equal(toolDetail("Grep", undefined), "");
  assert.equal(toolDetail("x", { n: 5, flag: true }), "");
});

test("toolLabel maps the read-only/web tools to friendly verbs", () => {
  assert.equal(toolLabel("Grep"), "Searching code");
  assert.equal(toolLabel("Glob"), "Finding files");
  assert.equal(toolLabel("WebSearch"), "Searching the web");
  assert.equal(toolLabel("WebFetch"), "Reading a page");
  assert.equal(toolLabel("Task"), "Running a subtask");
});

test("phaseLabel maps plan/implement and empty otherwise", () => {
  assert.equal(phaseLabel("plan"), "Planning");
  assert.equal(phaseLabel("implement"), "Building");
  assert.equal(phaseLabel(undefined), "");
  assert.equal(phaseLabel("idle"), "");
});

test("formatDuration floors to whole seconds under a minute, Nm Ns above", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(1999), "1s"); // floors, not rounds
  assert.equal(formatDuration(59000), "59s");
  assert.equal(formatDuration(60000), "1m");
  assert.equal(formatDuration(61000), "1m 1s");
  assert.equal(formatDuration(125000), "2m 5s");
});

test("aggregateActivityStatus rolls up tool statuses with running > error > cancelled > ok", () => {
  const ok = [{ status: "ok" }, { status: "ok" }];
  const withError = [{ status: "ok" }, { status: "error" }];
  const withCancelled = [{ status: "ok" }, { status: "cancelled" }];
  const running = [{ status: "error" }, { status: "running" }];
  assert.equal(aggregateActivityStatus(ok), "ok");
  assert.equal(aggregateActivityStatus(withError), "error");
  assert.equal(aggregateActivityStatus(withCancelled), "cancelled");
  // A live step outranks a prior failure — the group still reads as working.
  assert.equal(aggregateActivityStatus(running), "running");
  // Error outranks cancelled when both are present.
  assert.equal(aggregateActivityStatus([{ status: "cancelled" }, { status: "error" }]), "error");
  // Empty / missing → ok (nothing to flag).
  assert.equal(aggregateActivityStatus([]), "ok");
  assert.equal(aggregateActivityStatus(undefined), "ok");
});

test("activityDefaultsOpen opens the active group and any finished group with an error", () => {
  // The active (live) group expands so progress is watchable.
  assert.equal(activityDefaultsOpen([], true), true);
  // Finished, all ok → collapsed.
  assert.equal(activityDefaultsOpen([{ status: "ok" }], false), false);
  // Finished but a tool errored → stays expanded so the failure isn't hidden.
  assert.equal(activityDefaultsOpen([{ status: "ok" }, { status: "error" }], false), true);
  // A cancelled tool is not an error — collapses like a clean group.
  assert.equal(activityDefaultsOpen([{ status: "cancelled" }], false), false);
  // Defensive: missing activity list.
  assert.equal(activityDefaultsOpen(undefined, false), false);
});
