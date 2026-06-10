import assert from "node:assert/strict";
import test from "node:test";

import { phaseLabel, toolLabel } from "../activityLabels.js";

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

test("phaseLabel maps plan/implement and empty otherwise", () => {
  assert.equal(phaseLabel("plan"), "Planning");
  assert.equal(phaseLabel("implement"), "Building");
  assert.equal(phaseLabel(undefined), "");
  assert.equal(phaseLabel("idle"), "");
});
