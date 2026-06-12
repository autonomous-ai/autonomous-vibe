// Derives a "build manifest" — the blueprint the BuildBlueprintOverlay draws —
// from the active chat turn's tool-use blocks. Pure (no React/THREE) so it can
// be unit-tested in isolation.
//
// Two sources, anticipatory with a reactive fallback:
//   - Tasks (preferred): the model's own TaskCreate / TaskUpdate calls give a
//     full roadmap up front that ticks pending → active → done. TaskCreate has
//     { subject, description, activeForm }; its id is its 1-based creation order.
//     TaskUpdate has { taskId, status }.
//   - Files (fallback): when a build doesn't use the task tool, each CAD source
//     file written (Write/Edit on a *.py) becomes a step as it appears.

import { toolLabel, toolDetail } from "../chat/activityLabels.js";

const TASK_STATUS_TO_STEP = {
  pending: "pending",
  in_progress: "active",
  completed: "done",
  cancelled: "done",
};

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

function basename(p) {
  const s = str(p);
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

/** Find the assistant turn currently building (last one still running). */
export function findActiveTurn(history) {
  const turns = Array.isArray(history) ? history : [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn?.role === "assistant" && turn?.status === "running") {
      return turn;
    }
  }
  return null;
}

/**
 * Build the manifest from a turn's blocks.
 *
 * @param {{ blocks?: Array<{kind:string, tool?:string, input?:any, status?:string}> }|null} turn
 * @returns {{ steps: Array<{id:string, label:string, status:"pending"|"active"|"done"}>,
 *             currentStep: string, source: "tasks"|"files"|"none" }}
 */
export function buildManifestFromTurn(turn) {
  const blocks = Array.isArray(turn?.blocks) ? turn.blocks : [];

  // --- Anticipatory: tasks ------------------------------------------------
  const taskById = new Map();
  const taskOrder = [];
  let createCount = 0;
  let latestActiveLabel = "";
  for (const block of blocks) {
    if (block?.kind !== "tool_use") continue;
    const input = block.input && typeof block.input === "object" ? block.input : {};
    if (block.tool === "TaskCreate") {
      createCount += 1;
      const id = String(createCount);
      const label = str(input.activeForm) || str(input.subject) || `Step ${id}`;
      taskById.set(id, { id, label, status: "pending" });
      taskOrder.push(id);
    } else if (block.tool === "TaskUpdate") {
      const id = str(input.taskId);
      const task = taskById.get(id);
      if (task) {
        const next = TASK_STATUS_TO_STEP[str(input.status)] || task.status;
        task.status = next;
        if (next === "active") latestActiveLabel = task.label;
      }
    }
  }

  if (taskOrder.length > 0) {
    const steps = taskOrder.map((id) => taskById.get(id));
    const currentStep = latestActiveLabel
      || steps.find((s) => s.status === "active")?.label
      || steps.find((s) => s.status === "pending")?.label
      || "Designing";
    return { steps, currentStep, source: "tasks" };
  }

  // --- Fallback: CAD source files written ---------------------------------
  const fileSteps = new Map(); // basename → step (last write wins on status)
  let latestRunningLabel = "";
  for (const block of blocks) {
    if (block?.kind !== "tool_use") continue;
    const tool = block.tool;
    if (block.status === "running") {
      const detail = toolDetail(tool, block.input);
      latestRunningLabel = detail ? `${toolLabel(tool, block.input)} · ${detail}` : toolLabel(tool, block.input);
    }
    if (tool !== "Write" && tool !== "Edit" && tool !== "MultiEdit") continue;
    const input = block.input && typeof block.input === "object" ? block.input : {};
    const file = basename(input.file_path);
    if (!/\.py$/i.test(file) || /^__init__\.py$/i.test(file)) continue;
    const label = file.replace(/\.py$/i, "");
    const status = block.status === "running" ? "active" : "done";
    const existing = fileSteps.get(file);
    // A later "running" shouldn't downgrade a finished step; otherwise update.
    if (!existing || existing.status !== "done") {
      fileSteps.set(file, { id: file, label, status });
    } else if (status === "active") {
      fileSteps.set(file, { id: file, label, status: "done" });
    }
  }

  const steps = [...fileSteps.values()];
  if (steps.length > 0) {
    const currentStep = latestRunningLabel
      || steps.find((s) => s.status === "active")?.label
      || "Designing";
    return { steps, currentStep, source: "files" };
  }

  return { steps: [], currentStep: latestRunningLabel || "Designing", source: "none" };
}
