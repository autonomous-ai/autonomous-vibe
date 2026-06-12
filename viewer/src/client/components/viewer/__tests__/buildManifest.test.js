import assert from "node:assert/strict";
import test from "node:test";

import { buildManifestFromTurn, findActiveTurn } from "../buildManifest.js";

const tool = (toolName, input, status = "ok") => ({ kind: "tool_use", tool: toolName, input, status });

test("findActiveTurn returns the running assistant turn", () => {
  const history = [
    { role: "user", id: "u1" },
    { role: "assistant", id: "a1", status: "complete", blocks: [] },
    { role: "assistant", id: "a2", status: "running", blocks: [] },
  ];
  assert.equal(findActiveTurn(history)?.id, "a2");
  assert.equal(findActiveTurn([]), null);
  assert.equal(findActiveTurn(null), null);
});

test("tasks source: roadmap ticks pending → active → done by creation-order id", () => {
  const turn = {
    blocks: [
      tool("TaskCreate", { subject: "Scaffold", activeForm: "Scaffolding project" }, "ok"),
      tool("TaskCreate", { subject: "Tower", activeForm: "Implementing tower" }, "ok"),
      tool("TaskCreate", { subject: "Tray", activeForm: "Implementing tray" }, "ok"),
      tool("TaskUpdate", { taskId: "1", status: "completed" }, "ok"),
      tool("TaskUpdate", { taskId: "2", status: "in_progress" }, "ok"),
    ],
  };
  const m = buildManifestFromTurn(turn);
  assert.equal(m.source, "tasks");
  assert.deepEqual(
    m.steps.map((s) => [s.label, s.status]),
    [
      ["Scaffolding project", "done"],
      ["Implementing tower", "active"],
      ["Implementing tray", "pending"],
    ],
  );
  // Current step is the most recently activated task.
  assert.equal(m.currentStep, "Implementing tower");
});

test("tasks source: falls back to first pending label when nothing active", () => {
  const turn = {
    blocks: [
      tool("TaskCreate", { activeForm: "Implementing tower" }, "ok"),
      tool("TaskCreate", { activeForm: "Implementing tray" }, "ok"),
    ],
  };
  const m = buildManifestFromTurn(turn);
  assert.equal(m.currentStep, "Implementing tower");
});

test("files fallback: each CAD source write becomes a step; __init__ filtered", () => {
  const turn = {
    blocks: [
      tool("Bash", { command: "mkdir -p parts" }, "ok"),
      tool("Write", { file_path: "/proj/parts/__init__.py" }, "ok"),
      tool("Write", { file_path: "/proj/parts/tower.py" }, "ok"),
      tool("Write", { file_path: "/proj/parts/tray.py" }, "running"),
    ],
  };
  const m = buildManifestFromTurn(turn);
  assert.equal(m.source, "files");
  assert.deepEqual(
    m.steps.map((s) => [s.label, s.status]),
    [
      ["tower", "done"],
      ["tray", "active"],
    ],
  );
});

test("files fallback: a finished file is not downgraded by a later running write", () => {
  const turn = {
    blocks: [
      tool("Write", { file_path: "/proj/parts/tower.py" }, "ok"),
      tool("Edit", { file_path: "/proj/parts/tower.py" }, "running"),
    ],
  };
  const m = buildManifestFromTurn(turn);
  assert.equal(m.steps.length, 1);
  assert.equal(m.steps[0].status, "done");
});

test("empty turn: no steps, generic current step", () => {
  const m = buildManifestFromTurn({ blocks: [] });
  assert.equal(m.source, "none");
  assert.deepEqual(m.steps, []);
  assert.equal(m.currentStep, "Designing");
});
