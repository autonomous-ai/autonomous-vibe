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
  selectLatestGcode3mf,
  selectLatestStl,
  INITIAL_CHAT_STATE,
  PANDA_REAUTH_MESSAGE,
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

test("queue_user_message slots the user turn before an already-arrived assistant turn", () => {
  // Race: the backend's `turn_start` lands before `chat_start_turn` resolves
  // and queues the user message. The user prompt must still render above
  // Claude's response, not below it.
  const withAssistant = applyEvents(
    { ...INITIAL_CHAT_STATE, currentProjectId: "proj-1" },
    [{ kind: "turn_start", turnId: "t-1", phase: "plan" }],
  );
  assert.equal(withAssistant.history.length, 1);
  assert.equal(withAssistant.history[0].role, "assistant");

  const next = chatReducer(
    withAssistant,
    { type: "queue_user_message", turnId: "t-1", text: "I need a hex tiles holder", at: FIXED_NOW },
    FIXED_NOW,
  );
  assert.equal(next.history.length, 2);
  assert.equal(next.history[0].role, "user", "user turn comes first");
  assert.equal(next.history[0].id, "user-t-1");
  assert.equal(next.history[1].role, "assistant", "assistant turn stays second");
  assert.equal(next.history[1].id, "t-1");
});

test("a turn started in one project does not stream into another project's chat", () => {
  // Start a turn in proj-1, then switch to proj-2 mid-turn.
  let state = chatReducer(
    { ...INITIAL_CHAT_STATE, currentProjectId: "proj-1" },
    { type: "queue_user_message", turnId: "t-1", text: "make a tray", at: FIXED_NOW },
    FIXED_NOW,
  );
  assert.equal(state.turnOwners["t-1"], "proj-1");

  state = chatReducer(state, { type: "set_project", projectId: "proj-2" }, FIXED_NOW);
  assert.equal(state.history.length, 0, "switching clears the visible history");
  assert.equal(state.turnOwners["t-1"], "proj-1", "owner is preserved across the switch");

  // proj-1's turn keeps streaming — none of it may land in proj-2's chat.
  state = applyEvents(state, [
    { kind: "turn_start", turnId: "t-1", phase: "implement" },
    { kind: "text_delta", turnId: "t-1", text: "On it…" },
    { kind: "artifact_changed", turnId: "t-1", file: "tray.stl", reason: "new" },
  ]);
  assert.equal(state.history.length, 0, "background turn does not pollute the active chat");

  // turn_end for the backgrounded turn prunes its owner without touching history.
  state = applyEvents(state, [{ kind: "turn_end", turnId: "t-1" }]);
  assert.equal(state.history.length, 0);
  assert.equal(state.turnOwners["t-1"], undefined, "owner pruned when the turn ends");
});

test("a streamed response is preserved (and keeps growing) across switch-away-and-back", () => {
  // Stream part of proj-1's response.
  let state = chatReducer(
    { ...INITIAL_CHAT_STATE, currentProjectId: "proj-1" },
    { type: "queue_user_message", turnId: "t-1", text: "make a tray", at: FIXED_NOW },
    FIXED_NOW,
  );
  state = applyEvents(state, [
    { kind: "turn_start", turnId: "t-1", phase: "implement" },
    { kind: "text_delta", turnId: "t-1", text: "Part 1 " },
  ]);

  // Switch away mid-turn — proj-1 is retained because its turn is running.
  state = chatReducer(state, { type: "set_project", projectId: "proj-2" }, FIXED_NOW);
  assert.equal(state.history.length, 0, "the new project's chat is empty");

  // More of proj-1's response streams in while it's backgrounded.
  state = applyEvents(state, [{ kind: "text_delta", turnId: "t-1", text: "Part 2 " }]);

  // Return to proj-1: everything streamed before AND during the away period is
  // restored, and the turn is still in progress (not lost / reset).
  state = chatReducer(state, { type: "set_project", projectId: "proj-1" }, FIXED_NOW);
  let assistant = state.history.find((t) => t.id === "t-1" && t.role === "assistant");
  assert.ok(assistant, "assistant turn restored");
  assert.equal(assistant.blocks[0].text, "Part 1 Part 2 ");
  assert.equal(state.turnInProgress, true, "still streaming after return");

  // Live deltas after returning keep appending to the same turn.
  state = applyEvents(state, [
    { kind: "text_delta", turnId: "t-1", text: "Part 3" },
    { kind: "turn_end", turnId: "t-1" },
  ]);
  assistant = state.history.find((t) => t.id === "t-1" && t.role === "assistant");
  assert.equal(assistant.blocks[0].text, "Part 1 Part 2 Part 3");
  assert.equal(state.turnInProgress, false, "turn completed");
  assert.equal(state.turnOwners["t-1"], undefined, "owner pruned on end");
});

test("returning to the owning project lets its turn's events apply again", () => {
  let state = chatReducer(
    { ...INITIAL_CHAT_STATE, currentProjectId: "proj-1" },
    { type: "queue_user_message", turnId: "t-1", text: "make a tray", at: FIXED_NOW },
    FIXED_NOW,
  );
  state = chatReducer(state, { type: "set_project", projectId: "proj-2" }, FIXED_NOW);
  // Switch back to the project that owns t-1.
  state = chatReducer(state, { type: "set_project", projectId: "proj-1" }, FIXED_NOW);
  state = applyEvents(state, [
    { kind: "turn_start", turnId: "t-1", phase: "implement" },
    { kind: "text_delta", turnId: "t-1", text: "On it…" },
  ]);
  const assistant = state.history.find((t) => t.id === "t-1" && t.role === "assistant");
  assert.ok(assistant, "owner project shows its own turn's response");
  assert.equal(assistant.blocks[0].text, "On it…");
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

test("auth_expired ends the turn and raises the re-auth flag", () => {
  const events = [
    { kind: "turn_start", turnId: "t-9" },
    { kind: "auth_expired", turnId: "t-9" },
  ];
  const state = applyEvents(INITIAL_CHAT_STATE, events);
  assert.equal(state.turnInProgress, false);
  assert.equal(state.needsPandaReauth, true);
  assert.equal(state.lastError, PANDA_REAUTH_MESSAGE);
  assert.equal(state.history[0].status, "error");
});

test("a fresh turn_start clears the re-auth flag, and clear_panda_reauth resets it", () => {
  let state = applyEvents(INITIAL_CHAT_STATE, [
    { kind: "turn_start", turnId: "t-a" },
    { kind: "auth_expired", turnId: "t-a" },
  ]);
  assert.equal(state.needsPandaReauth, true);
  // Retrying (new turn) optimistically clears it.
  state = chatReducer(state, {
    type: "chat_event",
    event: { kind: "turn_start", turnId: "t-b" },
  }, FIXED_NOW);
  assert.equal(state.needsPandaReauth, false);
  // The explicit clear action is idempotent.
  state = { ...state, needsPandaReauth: true };
  state = chatReducer(state, { type: "clear_panda_reauth" });
  assert.equal(state.needsPandaReauth, false);
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

test("interleaved same-name tools resolve by tool_use_id, not by name/recency", () => {
  // Two Edit calls run concurrently; their results arrive out of order. Matching
  // by name+recency would flip the wrong block and strand one on "Running".
  const events = [
    { kind: "turn_start", turnId: "t-5" },
    { kind: "tool_use_start", turnId: "t-5", tool: "Edit", toolUseId: "tu_a", input: { n: 1 } },
    { kind: "tool_use_start", turnId: "t-5", tool: "Edit", toolUseId: "tu_b", input: { n: 2 } },
    // Resolve the *first* (older) call first.
    { kind: "tool_use_end", turnId: "t-5", tool: "Edit", toolUseId: "tu_a", ok: true },
    { kind: "tool_use_end", turnId: "t-5", tool: "Edit", toolUseId: "tu_b", ok: false },
    { kind: "turn_end", turnId: "t-5" },
  ];
  const state = applyEvents(INITIAL_CHAT_STATE, events);
  const tools = state.history[0].blocks.filter((b) => b.kind === "tool_use");
  assert.equal(tools.length, 2);
  assert.equal(tools.find((b) => b.toolUseId === "tu_a").status, "ok");
  assert.equal(tools.find((b) => b.toolUseId === "tu_b").status, "error");
  // No leftover spinner.
  assert.ok(!tools.some((b) => b.status === "running"));
});

test("turn_end sweeps a tool whose result never arrived to 'cancelled' (no stuck spinner)", () => {
  const events = [
    { kind: "turn_start", turnId: "t-6" },
    { kind: "tool_use_start", turnId: "t-6", tool: "Edit", toolUseId: "tu_a", input: {} },
    { kind: "tool_use_end", turnId: "t-6", tool: "Edit", toolUseId: "tu_a", ok: true },
    // This one never gets a tool_use_end (dropped event / early kill).
    { kind: "tool_use_start", turnId: "t-6", tool: "Bash", toolUseId: "tu_b", input: {} },
    { kind: "turn_end", turnId: "t-6" },
  ];
  const state = applyEvents(INITIAL_CHAT_STATE, events);
  const turn = state.history[0];
  assert.equal(turn.status, "complete");
  const tools = turn.blocks.filter((b) => b.kind === "tool_use");
  assert.equal(tools.find((b) => b.toolUseId === "tu_a").status, "ok");
  assert.equal(tools.find((b) => b.toolUseId === "tu_b").status, "cancelled");
  assert.ok(!tools.some((b) => b.status === "running"));
});

test("cancel/error sweeps running tools to 'cancelled' but keeps real tool errors as 'error'", () => {
  const events = [
    { kind: "turn_start", turnId: "t-7" },
    // A tool that genuinely failed — must stay "error", not be relabelled.
    { kind: "tool_use_start", turnId: "t-7", tool: "Bash", toolUseId: "tu_a", input: {} },
    { kind: "tool_use_end", turnId: "t-7", tool: "Bash", toolUseId: "tu_a", ok: false },
    // A tool still running when the turn is cancelled.
    { kind: "tool_use_start", turnId: "t-7", tool: "Edit", toolUseId: "tu_b", input: {} },
    { kind: "error", turnId: "t-7", message: "cancelled" },
  ];
  const state = applyEvents(INITIAL_CHAT_STATE, events);
  const turn = state.history[0];
  assert.equal(turn.status, "error");
  const tools = turn.blocks.filter((b) => b.kind === "tool_use");
  assert.equal(tools.find((b) => b.toolUseId === "tu_a").status, "error");
  assert.equal(tools.find((b) => b.toolUseId === "tu_b").status, "cancelled");
  assert.ok(!tools.some((b) => b.status === "running"));
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

test("toolbar slice: set_last_slice surfaces gcode/3mf and turn_start clears it", () => {
  // A toolbar slice (no chat turn) records its output; the Print button reads
  // it via selectLatestGcode, and cloud reads the 3mf via selectLatestGcode3mf.
  const sliced = chatReducer(
    { ...INITIAL_CHAT_STATE, currentProjectId: "p1" },
    { type: "set_last_slice", gcodeFile: "model.gcode", gcode3mfFile: "model.gcode.3mf" },
    FIXED_NOW,
  );
  assert.equal(selectLatestGcode(sliced), "model.gcode");
  assert.equal(selectLatestGcode3mf(sliced), "model.gcode.3mf");

  // A new chat turn supersedes the stale toolbar slice.
  const afterTurn = chatReducer(
    sliced,
    { type: "chat_event", event: { kind: "turn_start", turnId: "t1" } },
    FIXED_NOW,
  );
  assert.equal(selectLatestGcode(afterTurn), "");
  assert.equal(selectLatestGcode3mf(afterTurn), "");
});

test("toolbar slice wins over an older chat-artifact gcode", () => {
  const withChatGcode = applyEvents({ ...INITIAL_CHAT_STATE, currentProjectId: "p1" }, [
    { kind: "turn_start", turnId: "t1" },
    { kind: "artifact_changed", turnId: "t1", file: "old.gcode", reason: "new" },
    { kind: "turn_end", turnId: "t1" },
  ]);
  assert.equal(selectLatestGcode(withChatGcode), "old.gcode");
  const resliced = chatReducer(
    withChatGcode,
    { type: "set_last_slice", gcodeFile: "fresh.gcode", gcode3mfFile: "" },
    FIXED_NOW,
  );
  assert.equal(selectLatestGcode(resliced), "fresh.gcode");
});
