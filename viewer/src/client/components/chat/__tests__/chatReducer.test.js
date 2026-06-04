// Pure unit tests for the chat store reducer + selectors. This is the heart
// of the "ChatHistory replays a canned stream of `chat_event` JSON fixtures
// and renders the expected turns" requirement — the reducer is what the UI
// consumes via `useSyncExternalStore`, so reducer output == rendered turns.

import assert from "node:assert/strict";
import test from "node:test";

import {
  chatReducer,
  selectArtifactFiles,
  selectLatestGcode,
  selectLatestStl,
  INITIAL_CHAT_STATE,
} from "../../../store/chat.js";

const FIXED_NOW = 1_700_000_000_000;

function applyEvents(state, events) {
  let cursor = state;
  for (const event of events) {
    cursor = chatReducer(cursor, { type: "chat_event", event }, FIXED_NOW);
  }
  return cursor;
}

test("set_project clears history but preserves pendingTokens", () => {
  const state = {
    ...INITIAL_CHAT_STATE,
    history: [{ id: "u-1", role: "user", blocks: [], status: "complete", startedAt: 0 }],
    pendingTokens: ["@cad[parts/base#f3]"],
  };
  const next = chatReducer(state, { type: "set_project", projectId: "proj-1" }, FIXED_NOW);
  assert.equal(next.currentProjectId, "proj-1");
  assert.deepEqual(next.history, []);
  assert.deepEqual(next.pendingTokens, ["@cad[parts/base#f3]"]);
});

test("queue_user_message appends a user turn and marks turnInProgress", () => {
  const next = chatReducer(
    { ...INITIAL_CHAT_STATE, currentProjectId: "proj-1" },
    { type: "queue_user_message", turnId: "t-1", text: "make a 10mm cube", at: FIXED_NOW },
    FIXED_NOW,
  );
  assert.equal(next.turnInProgress, true);
  assert.equal(next.currentTurnId, "t-1");
  assert.equal(next.history.length, 1);
  assert.equal(next.history[0].role, "user");
  assert.equal(next.history[0].userText, "make a 10mm cube");
});

test("checkpoint_created tags the assistant turn with its checkpoint id", () => {
  const events = [
    { kind: "turn_start", turnId: "t-1", phase: "implement" },
    { kind: "artifact_changed", turnId: "t-1", file: "model.stl", reason: "modified" },
    { kind: "checkpoint_created", turnId: "t-1", checkpointId: "cp-abc" },
    { kind: "turn_end", turnId: "t-1" },
  ];
  const state = applyEvents(INITIAL_CHAT_STATE, events);
  const turn = state.history.find((t) => t.id === "t-1" && t.role === "assistant");
  assert.ok(turn, "assistant turn exists");
  assert.equal(turn.checkpointId, "cp-abc");
});

test("set_checkpoints replaces the checkpoint list", () => {
  const checkpoints = [{ id: "cp-1", turnId: "t-1", parentId: null }];
  const next = chatReducer(INITIAL_CHAT_STATE, { type: "set_checkpoints", checkpoints }, FIXED_NOW);
  assert.deepEqual(next.checkpoints, checkpoints);
  // Non-array payloads degrade to an empty list rather than corrupting state.
  const cleared = chatReducer(next, { type: "set_checkpoints", checkpoints: null }, FIXED_NOW);
  assert.deepEqual(cleared.checkpoints, []);
});

test("chat_event stream renders a single assistant turn with merged text deltas", () => {
  const events = [
    { kind: "turn_start", turnId: "t-1" },
    { kind: "text_delta", turnId: "t-1", text: "Hello, " },
    { kind: "text_delta", turnId: "t-1", text: "I'll make " },
    { kind: "text_delta", turnId: "t-1", text: "a cube." },
    { kind: "turn_end", turnId: "t-1" },
  ];
  const state = applyEvents(INITIAL_CHAT_STATE, events);
  assert.equal(state.history.length, 1);
  const turn = state.history[0];
  assert.equal(turn.role, "assistant");
  assert.equal(turn.status, "complete");
  assert.equal(turn.blocks.length, 1);
  assert.equal(turn.blocks[0].kind, "text");
  assert.equal(turn.blocks[0].text, "Hello, I'll make a cube.");
  assert.equal(state.turnInProgress, false);
});

test("chat_event stream interleaves text, tool_use, artifact and error blocks in order", () => {
  const events = [
    { kind: "turn_start", turnId: "t-2" },
    { kind: "text_delta", turnId: "t-2", text: "Working" },
    { kind: "tool_use_start", turnId: "t-2", tool: "cadcode", input: { spec: "10mm cube" } },
    { kind: "tool_use_end", turnId: "t-2", tool: "cadcode", ok: true },
    { kind: "artifact_changed", turnId: "t-2", file: "model.step", reason: "new" },
    { kind: "artifact_changed", turnId: "t-2", file: "model.stl", reason: "new" },
    { kind: "text_delta", turnId: "t-2", text: "\nDone." },
    { kind: "turn_end", turnId: "t-2" },
  ];
  const state = applyEvents(INITIAL_CHAT_STATE, events);
  const turn = state.history[0];
  const kinds = turn.blocks.map((b) => b.kind);
  assert.deepEqual(kinds, ["text", "tool_use", "artifact", "artifact", "text"]);
  assert.equal(turn.blocks[1].status, "ok");
  assert.equal(turn.blocks[2].file, "model.step");
  assert.equal(turn.blocks[3].file, "model.stl");
});

test("error event flips turn status to error and records lastError", () => {
  const events = [
    { kind: "turn_start", turnId: "t-3" },
    { kind: "text_delta", turnId: "t-3", text: "thinking..." },
    { kind: "error", turnId: "t-3", message: "sandbox timeout" },
  ];
  const state = applyEvents(INITIAL_CHAT_STATE, events);
  assert.equal(state.turnInProgress, false);
  assert.equal(state.lastError, "sandbox timeout");
  assert.equal(state.history[0].status, "error");
  const errorBlocks = state.history[0].blocks.filter((b) => b.kind === "error");
  assert.equal(errorBlocks.length, 1);
  assert.equal(errorBlocks[0].message, "sandbox timeout");
});

test("tool_use_end without a running start is still recorded for observability", () => {
  const events = [
    { kind: "turn_start", turnId: "t-4" },
    { kind: "tool_use_end", turnId: "t-4", tool: "Read", ok: false },
  ];
  const state = applyEvents(INITIAL_CHAT_STATE, events);
  const blocks = state.history[0].blocks;
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "tool_use");
  assert.equal(blocks[0].status, "error");
});

test("pendingTokens dedupes and supports add/consume", () => {
  let state = chatReducer(INITIAL_CHAT_STATE, { type: "add_pending_token", token: "@cad[a#f1]" });
  state = chatReducer(state, { type: "add_pending_token", token: "@cad[a#f1]" });
  state = chatReducer(state, { type: "add_pending_token", token: "@cad[a#f2]" });
  assert.deepEqual(state.pendingTokens, ["@cad[a#f1]", "@cad[a#f2]"]);
  state = chatReducer(state, { type: "consume_pending_tokens" });
  assert.deepEqual(state.pendingTokens, []);
});

test("selectArtifactFiles returns one entry per unique file, latest reason wins", () => {
  let state = INITIAL_CHAT_STATE;
  state = chatReducer(state, {
    type: "chat_event",
    event: { kind: "turn_start", turnId: "t-1" },
  });
  state = chatReducer(state, {
    type: "chat_event",
    event: { kind: "artifact_changed", turnId: "t-1", file: "model.step", reason: "new" },
  });
  state = chatReducer(state, {
    type: "chat_event",
    event: { kind: "artifact_changed", turnId: "t-1", file: "model.stl", reason: "new" },
  });
  state = chatReducer(state, {
    type: "chat_event",
    event: { kind: "artifact_changed", turnId: "t-1", file: "model.stl", reason: "modified" },
  });
  const artifacts = selectArtifactFiles(state);
  const files = artifacts.map((a) => a.file).sort();
  assert.deepEqual(files, ["model.step", "model.stl"]);
});

test("selectLatestStl returns the most recent .stl artifact and selectLatestGcode is empty without gcode", () => {
  let state = INITIAL_CHAT_STATE;
  const events = [
    { kind: "turn_start", turnId: "t-1" },
    { kind: "artifact_changed", turnId: "t-1", file: "model.step", reason: "new" },
    { kind: "artifact_changed", turnId: "t-1", file: "model.stl", reason: "new" },
  ];
  state = applyEvents(state, events);
  assert.equal(selectLatestStl(state), "model.stl");
  assert.equal(selectLatestGcode(state), "");
});

test("selectLatestGcode returns the most recent .gcode artifact", () => {
  const events = [
    { kind: "turn_start", turnId: "t-1" },
    { kind: "artifact_changed", turnId: "t-1", file: "draft.gcode", reason: "new" },
    { kind: "artifact_changed", turnId: "t-1", file: "final.gcode", reason: "new" },
  ];
  const state = applyEvents(INITIAL_CHAT_STATE, events);
  assert.equal(selectLatestGcode(state), "final.gcode");
});

// --- Change 4: clearer plan card + post-build "ask to modify" hint ---------

test("Change 4: a plan turn surfaces a proposed plan block and awaitingApproval (drives PlanBlock)", () => {
  const events = [
    { kind: "turn_start", turnId: "p-1", phase: "plan" },
    { kind: "plan_proposed", turnId: "p-1", plan: "**What I'll make**\n- a 10mm cube" },
  ];
  const state = applyEvents(INITIAL_CHAT_STATE, events);
  const turn = state.history[0];
  const planBlock = turn.blocks.find((b) => b.kind === "plan");
  assert.ok(planBlock, "a plan block is rendered");
  assert.equal(planBlock.status, "proposed");
  assert.equal(planBlock.plan, "**What I'll make**\n- a 10mm cube");
  assert.equal(state.awaitingApproval, true);
  assert.equal(state.activePlanTurnId, "p-1");
});

test("Change 4: a completed build turn yields the exact condition that shows the post-build modify hint", () => {
  const events = [
    { kind: "turn_start", turnId: "b-1", phase: "implement" },
    { kind: "tool_use_start", turnId: "b-1", tool: "cadcode", input: {} },
    { kind: "tool_use_end", turnId: "b-1", tool: "cadcode", ok: true },
    { kind: "artifact_changed", turnId: "b-1", file: "bracket.stl", reason: "new" },
    { kind: "turn_end", turnId: "b-1" },
  ];
  const state = applyEvents(INITIAL_CHAT_STATE, events);
  const turn = state.history[0];
  // Mirrors ChatTurn.jsx's `showModifyHint` exactly.
  const showModifyHint =
    turn.phase === "implement" &&
    turn.status === "complete" &&
    turn.blocks.some((b) => b.kind === "artifact");
  assert.equal(showModifyHint, true);
  // A plan-only (read-only) turn must NOT show the hint.
  const planState = applyEvents(INITIAL_CHAT_STATE, [
    { kind: "turn_start", turnId: "p-2", phase: "plan" },
    { kind: "plan_proposed", turnId: "p-2", plan: "x" },
    { kind: "turn_end", turnId: "p-2" },
  ]);
  const planTurn = planState.history[0];
  const planShowsHint =
    planTurn.phase === "implement" &&
    planTurn.status === "complete" &&
    planTurn.blocks.some((b) => b.kind === "artifact");
  assert.equal(planShowsHint, false);
});
