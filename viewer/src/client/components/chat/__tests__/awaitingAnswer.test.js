// Tests for the per-project "waiting for user answer" tracking that drives the
// sidebar amber dot. A project is awaiting an answer when its session paused for
// input: a proposed plan (plan_proposed) or unanswered preference questions (a
// panda-questions fence in the turn text). Tracked in a top-level
// `awaitingAnswerProjectIds` map keyed by projectId, so it survives project
// switches; cleared when the user responds.

import assert from "node:assert/strict";
import test from "node:test";

import {
  INITIAL_CHAT_STATE,
  chatReducer,
  selectAwaitingAnswerProjectIds,
} from "../../../store/chat.js";

const NOW = 1_000;
const QUESTIONS_FENCE = "\n\n```panda-questions\n{\"questions\":[]}\n```\n";

function withProject(projectId) {
  return chatReducer(INITIAL_CHAT_STATE, { type: "set_project", projectId }, NOW);
}

function applyEvents(events, start) {
  return events.reduce(
    (state, event) => chatReducer(state, { type: "chat_event", event }, NOW),
    start,
  );
}

function awaiting(state) {
  return selectAwaitingAnswerProjectIds(state);
}

test("plan_proposed marks the owning project as awaiting an answer", () => {
  const state = applyEvents(
    [
      { kind: "turn_start", turnId: "t1", phase: "plan", projectId: "A" },
      { kind: "plan_proposed", turnId: "t1", plan: "# Plan", projectId: "A" },
    ],
    withProject("A"),
  );
  assert.equal(awaiting(state).A, true);
});

test("turn_end with a panda-questions fence marks the project awaiting", () => {
  const state = applyEvents(
    [
      { kind: "turn_start", turnId: "t1", phase: "plan", projectId: "A" },
      { kind: "text_delta", turnId: "t1", text: `Some preamble${QUESTIONS_FENCE}`, projectId: "A" },
      { kind: "turn_end", turnId: "t1", projectId: "A" },
    ],
    withProject("A"),
  );
  assert.equal(awaiting(state).A, true);
});

test("turn_end without questions and no plan does not mark awaiting", () => {
  const state = applyEvents(
    [
      { kind: "turn_start", turnId: "t1", phase: "implement", projectId: "A" },
      { kind: "text_delta", turnId: "t1", text: "Here is your model.", projectId: "A" },
      { kind: "turn_end", turnId: "t1", projectId: "A" },
    ],
    withProject("A"),
  );
  assert.equal(awaiting(state).A, undefined);
});

test("queue_user_message clears the awaiting flag (user responded)", () => {
  let state = applyEvents(
    [
      { kind: "turn_start", turnId: "t1", phase: "plan", projectId: "A" },
      { kind: "plan_proposed", turnId: "t1", plan: "# Plan", projectId: "A" },
    ],
    withProject("A"),
  );
  assert.equal(awaiting(state).A, true);
  state = chatReducer(
    state,
    { type: "queue_user_message", turnId: "t2", text: "go", at: NOW },
    NOW,
  );
  assert.equal(awaiting(state).A, undefined);
});

test("mark_plan approved clears the awaiting flag", () => {
  let state = applyEvents(
    [
      { kind: "turn_start", turnId: "t1", phase: "plan", projectId: "A" },
      { kind: "plan_proposed", turnId: "t1", plan: "# Plan", projectId: "A" },
    ],
    withProject("A"),
  );
  state = chatReducer(state, { type: "mark_plan", turnId: "t1", status: "approved" }, NOW);
  assert.equal(awaiting(state).A, undefined);
});

test("mark_plan superseded clears the awaiting flag", () => {
  let state = applyEvents(
    [
      { kind: "turn_start", turnId: "t1", phase: "plan", projectId: "A" },
      { kind: "plan_proposed", turnId: "t1", plan: "# Plan", projectId: "A" },
    ],
    withProject("A"),
  );
  state = chatReducer(state, { type: "mark_plan", turnId: "t1", status: "superseded" }, NOW);
  assert.equal(awaiting(state).A, undefined);
});

test("error on the awaiting project clears the flag", () => {
  let state = applyEvents(
    [
      { kind: "turn_start", turnId: "t1", phase: "plan", projectId: "A" },
      { kind: "plan_proposed", turnId: "t1", plan: "# Plan", projectId: "A" },
    ],
    withProject("A"),
  );
  state = applyEvents([{ kind: "error", turnId: "t1", message: "boom", projectId: "A" }], state);
  assert.equal(awaiting(state).A, undefined);
});

test("a fresh turn_start clears a stale awaiting flag for that project", () => {
  let state = applyEvents(
    [
      { kind: "turn_start", turnId: "t1", phase: "plan", projectId: "A" },
      { kind: "plan_proposed", turnId: "t1", plan: "# Plan", projectId: "A" },
    ],
    withProject("A"),
  );
  state = applyEvents([{ kind: "turn_start", turnId: "t2", phase: "implement", projectId: "A" }], state);
  assert.equal(awaiting(state).A, undefined);
});

test("awaiting state survives a project switch (top-level map, not the session slice)", () => {
  let state = applyEvents(
    [
      { kind: "turn_start", turnId: "t1", phase: "plan", projectId: "A" },
      { kind: "plan_proposed", turnId: "t1", plan: "# Plan", projectId: "A" },
    ],
    withProject("A"),
  );
  state = chatReducer(state, { type: "set_project", projectId: "B" }, NOW);
  state = chatReducer(state, { type: "set_project", projectId: "A" }, NOW);
  assert.equal(awaiting(state).A, true);
});

test("plan_proposed for a backgrounded project marks that project, not the active one", () => {
  // Active project is B; a plan turn finishes for backgrounded project A.
  let state = withProject("A");
  // Start a turn in A so its session is retained when we switch away.
  state = applyEvents([{ kind: "turn_start", turnId: "t1", phase: "plan", projectId: "A" }], state);
  state = chatReducer(state, { type: "set_project", projectId: "B" }, NOW);
  state = applyEvents(
    [{ kind: "plan_proposed", turnId: "t1", plan: "# Plan", projectId: "A" }],
    state,
  );
  assert.equal(awaiting(state).A, true);
  assert.equal(awaiting(state).B, undefined);
});

test("a paused project's question UI survives a project switch and return", () => {
  // Regression: switching away from a project mid-question then returning used to
  // drop the rich slice (the turn had ended, so the in-flight retain checks
  // missed it) and re-hydrate from the transcript, which has no panda-questions
  // fence — so the QuestionCard vanished. The awaiting flag now retains the slice.
  let state = applyEvents(
    [
      { kind: "turn_start", turnId: "t1", phase: "plan", projectId: "A" },
      { kind: "text_delta", turnId: "t1", text: `Preamble${QUESTIONS_FENCE}`, projectId: "A" },
      { kind: "turn_end", turnId: "t1", projectId: "A" },
    ],
    withProject("A"),
  );
  assert.equal(awaiting(state).A, true);
  state = chatReducer(state, { type: "set_project", projectId: "B" }, NOW);
  state = chatReducer(state, { type: "set_project", projectId: "A" }, NOW);
  const turn = state.history.find((t) => t.role === "assistant" && t.id === "t1");
  assert.ok(turn, "the question turn should be restored, not re-hydrated away");
  assert.ok(
    turn.blocks.some((b) => b.kind === "text" && b.text.includes("```panda-questions")),
    "the panda-questions fence should survive the round-trip so the QuestionCard renders",
  );
  assert.equal(awaiting(state).A, true, "the awaiting dot should persist");
});

test("a paused project's proposed plan + approval gate survive a switch and return", () => {
  let state = applyEvents(
    [
      { kind: "turn_start", turnId: "t1", phase: "plan", projectId: "A" },
      { kind: "plan_proposed", turnId: "t1", plan: "# Plan\n- base", projectId: "A" },
    ],
    withProject("A"),
  );
  state = chatReducer(state, { type: "set_project", projectId: "B" }, NOW);
  state = chatReducer(state, { type: "set_project", projectId: "A" }, NOW);
  assert.equal(state.awaitingApproval, true, "the approval gate is restored");
  assert.equal(state.activePlanTurnId, "t1");
  const turn = state.history.find((t) => t.role === "assistant" && t.id === "t1");
  assert.ok(
    turn.blocks.some((b) => b.kind === "plan" && b.status === "proposed"),
    "the proposed plan block should survive the round-trip",
  );
});

test("selectAwaitingAnswerProjectIds returns a stable empty object when idle", () => {
  assert.deepEqual(awaiting(INITIAL_CHAT_STATE), {});
});
