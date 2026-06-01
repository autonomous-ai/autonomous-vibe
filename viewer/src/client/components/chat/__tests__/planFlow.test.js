// Tests for the plan → approve → build workflow: reducer handling of the
// new plan_proposed / mark_plan transitions, the turn phase stamp, and the
// approvePlan / requestPlanChanges thunks.

import assert from "node:assert/strict";
import test from "node:test";

import {
  INITIAL_CHAT_STATE,
  chatReducer,
} from "../../../store/chat.js";
import {
  __setTransportForTesting,
  approvePlan,
  dispatch,
  getChatState,
  requestPlanChanges,
  resetChatStore,
  setProject,
} from "../../../store/chat.js";

const NOW = 1_000;

function applyEvents(events, start = INITIAL_CHAT_STATE) {
  return events.reduce(
    (state, event) => chatReducer(state, { type: "chat_event", event }, NOW),
    start,
  );
}

// -- reducer -----------------------------------------------------------------

test("turn_start stamps the phase on the assistant turn", () => {
  const state = applyEvents([{ kind: "turn_start", turnId: "t1", phase: "plan" }]);
  assert.equal(state.history[0].phase, "plan");
  assert.equal(state.history[0].role, "assistant");
});

test("plan_proposed appends a proposed plan block and gates approval", () => {
  const state = applyEvents([
    { kind: "turn_start", turnId: "t1", phase: "plan" },
    { kind: "plan_proposed", turnId: "t1", plan: "# Plan\n- base\n- lid" },
  ]);
  assert.equal(state.awaitingApproval, true);
  assert.equal(state.activePlanTurnId, "t1");
  const turn = state.history[0];
  assert.equal(turn.phase, "plan");
  const planBlock = turn.blocks.find((b) => b.kind === "plan");
  assert.ok(planBlock, "a plan block should exist");
  assert.equal(planBlock.status, "proposed");
  assert.match(planBlock.plan, /base/);
});

test("plan_proposed works even if turn_start was missed", () => {
  const state = applyEvents([
    { kind: "plan_proposed", turnId: "t9", plan: "do it" },
  ]);
  assert.equal(state.awaitingApproval, true);
  assert.equal(state.history[0].blocks[0].kind, "plan");
});

test("mark_plan approved flips status and clears the approval gate", () => {
  let state = applyEvents([
    { kind: "turn_start", turnId: "t1", phase: "plan" },
    { kind: "plan_proposed", turnId: "t1", plan: "p" },
  ]);
  state = chatReducer(state, { type: "mark_plan", turnId: "t1", status: "approved" }, NOW);
  assert.equal(state.awaitingApproval, false);
  assert.equal(state.activePlanTurnId, "");
  assert.equal(state.history[0].blocks[0].status, "approved");
});

test("mark_plan superseded clears the gate too", () => {
  let state = applyEvents([
    { kind: "turn_start", turnId: "t1", phase: "plan" },
    { kind: "plan_proposed", turnId: "t1", plan: "p" },
  ]);
  state = chatReducer(state, { type: "mark_plan", turnId: "t1", status: "superseded" }, NOW);
  assert.equal(state.awaitingApproval, false);
  assert.equal(state.history[0].blocks[0].status, "superseded");
});

test("an implement turn_start carries the implement phase", () => {
  const state = applyEvents([{ kind: "turn_start", turnId: "impl", phase: "implement" }]);
  assert.equal(state.history[0].phase, "implement");
});

// -- thunks ------------------------------------------------------------------

function seedAwaitingApproval(projectId = "proj-1", turnId = "t1") {
  resetChatStore();
  setProject(projectId);
  dispatch({ type: "chat_event", event: { kind: "turn_start", turnId, phase: "plan" } });
  dispatch({ type: "chat_event", event: { kind: "plan_proposed", turnId, plan: "# Plan" } });
}

test("approvePlan calls chat_approve_plan with the (edited) text and marks approved", async () => {
  seedAwaitingApproval();
  const calls = [];
  const restore = __setTransportForTesting({
    async chat_approve_plan(req) {
      calls.push(req);
      return { turnId: "impl-1" };
    },
  });
  try {
    const res = await approvePlan("# Plan (edited)");
    assert.deepEqual(calls, [{ projectId: "proj-1", planText: "# Plan (edited)" }]);
    assert.equal(res.turnId, "impl-1");
    const state = getChatState();
    assert.equal(state.awaitingApproval, false);
    assert.equal(state.history[0].blocks[0].status, "approved");
  } finally {
    restore();
    resetChatStore();
  }
});

test("requestPlanChanges sends feedback, supersedes the plan, and queues a user turn", async () => {
  seedAwaitingApproval();
  const calls = [];
  const restore = __setTransportForTesting({
    async chat_request_plan_changes(req) {
      calls.push(req);
      return { turnId: "plan-2" };
    },
  });
  try {
    const res = await requestPlanChanges("add 4 screw bosses");
    assert.deepEqual(calls, [{ projectId: "proj-1", feedback: "add 4 screw bosses" }]);
    assert.equal(res.turnId, "plan-2");
    const state = getChatState();
    assert.equal(state.awaitingApproval, false);
    assert.equal(state.history[0].blocks[0].status, "superseded");
    // A user turn was queued so the conversation shows the request.
    assert.ok(state.history.some((t) => t.role === "user" && t.userText === "add 4 screw bosses"));
  } finally {
    restore();
    resetChatStore();
  }
});

test("approvePlan is a no-op when not awaiting approval", async () => {
  resetChatStore();
  setProject("proj-1");
  let called = false;
  const restore = __setTransportForTesting({
    async chat_approve_plan() {
      called = true;
      return { turnId: "x" };
    },
  });
  try {
    const res = await approvePlan("anything");
    assert.equal(res, null);
    assert.equal(called, false);
  } finally {
    restore();
    resetChatStore();
  }
});

test("requestPlanChanges ignores empty feedback", async () => {
  seedAwaitingApproval();
  let called = false;
  const restore = __setTransportForTesting({
    async chat_request_plan_changes() {
      called = true;
      return { turnId: "x" };
    },
  });
  try {
    const res = await requestPlanChanges("   ");
    assert.equal(res, null);
    assert.equal(called, false);
  } finally {
    restore();
    resetChatStore();
  }
});
