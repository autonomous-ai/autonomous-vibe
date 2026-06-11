// Tests for the collapsed "Thinking…/Thought for Ns" indicator's data layer:
// the reducer stamping the thinking window (firstTextAt) and the
// thinkingDurationMs selector that drives the "• Ns" label.

import assert from "node:assert/strict";
import test from "node:test";

import {
  INITIAL_CHAT_STATE,
  chatReducer,
  thinkingDurationMs,
  partitionTurnBlocks,
} from "../../../store/chat.js";

function ev(state, event, now) {
  return chatReducer(state, { type: "chat_event", event }, now);
}

// -- firstTextAt stamping ----------------------------------------------------

test("text_delta stamps firstTextAt once, at the first answer token", () => {
  let s = ev(INITIAL_CHAT_STATE, { kind: "turn_start", turnId: "t1" }, 1000);
  s = ev(s, { kind: "thinking_delta", turnId: "t1", text: "hmm" }, 1500);
  s = ev(s, { kind: "tool_use_start", turnId: "t1", tool: "Read", toolUseId: "u1" }, 2000);
  s = ev(s, { kind: "text_delta", turnId: "t1", text: "Hello" }, 3000);
  s = ev(s, { kind: "text_delta", turnId: "t1", text: " world" }, 4000);
  const turn = s.history[0];
  assert.equal(turn.startedAt, 1000);
  assert.equal(turn.firstTextAt, 3000, "stamped at first text, not moved by later deltas");
});

test("an empty text_delta does not stamp firstTextAt", () => {
  let s = ev(INITIAL_CHAT_STATE, { kind: "turn_start", turnId: "t1" }, 1000);
  s = ev(s, { kind: "text_delta", turnId: "t1", text: "" }, 2000);
  assert.equal(s.history[0].firstTextAt, undefined);
});

// -- thinkingDurationMs ------------------------------------------------------

test("thinkingDurationMs measures the full work span (start → last activity)", () => {
  // A build keeps working long after the first token: end at lastActivityAt,
  // not firstTextAt — so the number reflects the real work, not "5s".
  const turn = { startedAt: 1000, firstTextAt: 6000, lastActivityAt: 130000, endedAt: 131000 };
  assert.equal(thinkingDurationMs(turn), 129000);
});

test("thinkingDurationMs falls back to firstTextAt then endedAt without lastActivityAt", () => {
  assert.equal(thinkingDurationMs({ startedAt: 1000, firstTextAt: 3500, endedAt: 9000 }), 2500);
  assert.equal(thinkingDurationMs({ startedAt: 1000, endedAt: 4000 }), 3000);
});

test("thinkingDurationMs counts up to `now` while the turn is still running", () => {
  // No endedAt → running → ignore stamps, count to now.
  assert.equal(thinkingDurationMs({ startedAt: 1000, firstTextAt: 1200, lastActivityAt: 1500 }, 2750), 1750);
});

test("thinkingDurationMs never goes negative", () => {
  assert.equal(thinkingDurationMs({ startedAt: 5000, lastActivityAt: 1000, endedAt: 6000 }), 0);
});

test("thinkingDurationMs is 0 for a turn with no startedAt", () => {
  assert.equal(thinkingDurationMs({}), 0);
  assert.equal(thinkingDurationMs(null), 0);
});

// -- lastActivityAt stamping -------------------------------------------------

test("lastActivityAt advances with each reasoning/tool event, not with answer text", () => {
  let s = ev(INITIAL_CHAT_STATE, { kind: "turn_start", turnId: "t1" }, 1000);
  s = ev(s, { kind: "thinking_delta", turnId: "t1", text: "hmm" }, 1500);
  s = ev(s, { kind: "tool_use_start", turnId: "t1", tool: "Bash", toolUseId: "u1", input: {} }, 2000);
  s = ev(s, { kind: "text_delta", turnId: "t1", text: "I'll build it." }, 2500);
  s = ev(s, { kind: "tool_use_end", turnId: "t1", tool: "Bash", toolUseId: "u1", ok: true }, 9000);
  s = ev(s, { kind: "text_delta", turnId: "t1", text: " Done." }, 9500);
  const turn = s.history[0];
  assert.equal(turn.firstTextAt, 2500, "first answer token time is unchanged");
  assert.equal(turn.lastActivityAt, 9000, "stamped by the last tool event, not the trailing text");
});

// -- tool_use_end resultSummary ----------------------------------------------

test("tool_use_end records the result summary on the matching tool block", () => {
  let s = ev(INITIAL_CHAT_STATE, { kind: "turn_start", turnId: "t1" }, 1000);
  s = ev(s, { kind: "tool_use_start", turnId: "t1", tool: "Grep", toolUseId: "u1", input: { pattern: "foo" } }, 1100);
  s = ev(
    s,
    { kind: "tool_use_end", turnId: "t1", tool: "Grep", toolUseId: "u1", ok: true, resultSummary: "3 lines" },
    1200,
  );
  const tool = s.history[0].blocks.find((b) => b.kind === "tool_use");
  assert.equal(tool.status, "ok");
  assert.equal(tool.resultSummary, "3 lines");
});

test("tool_use_end without a summary leaves resultSummary unset", () => {
  let s = ev(INITIAL_CHAT_STATE, { kind: "turn_start", turnId: "t1" }, 1000);
  s = ev(s, { kind: "tool_use_start", turnId: "t1", tool: "Bash", toolUseId: "u1", input: {} }, 1100);
  s = ev(s, { kind: "tool_use_end", turnId: "t1", tool: "Bash", toolUseId: "u1", ok: true }, 1200);
  const tool = s.history[0].blocks.find((b) => b.kind === "tool_use");
  assert.equal(tool.status, "ok");
  assert.equal(tool.resultSummary, undefined);
});

// -- partitionTurnBlocks -----------------------------------------------------

test("inter-step narration (text before the last tool) folds into the trace", () => {
  const blocks = [
    { kind: "text", text: "I'll start by invoking the skill." },
    { kind: "tool_use", tool: "Skill", status: "ok" },
    { kind: "text", text: "Now researching components." },
    { kind: "tool_use", tool: "WebSearch", status: "error" },
    { kind: "text", text: "Here is your final answer." },
  ];
  const { trace, body } = partitionTurnBlocks(blocks);
  // Both narration lines + both tools land in the trace, in order.
  assert.deepEqual(
    trace.map((b) => b.kind),
    ["text", "tool_use", "text", "tool_use"],
  );
  // Only the trailing answer renders inline.
  assert.equal(body.length, 1);
  assert.equal(body[0].text, "Here is your final answer.");
});

test("a turn with no tool activity keeps all text in the body", () => {
  const blocks = [{ kind: "text", text: "Just a plain reply." }];
  const { trace, body } = partitionTurnBlocks(blocks);
  assert.deepEqual(trace, []);
  assert.deepEqual(body, blocks);
});

test("thinking counts as activity, so pre-answer text before it folds in", () => {
  const blocks = [
    { kind: "text", text: "preamble" },
    { kind: "thinking", text: "reasoning" },
    { kind: "text", text: "answer" },
  ];
  const { trace, body } = partitionTurnBlocks(blocks);
  assert.deepEqual(trace.map((b) => b.text), ["preamble", "reasoning"]);
  assert.deepEqual(body.map((b) => b.text), ["answer"]);
});

test("plan, artifact, and error blocks always stay in the body", () => {
  const blocks = [
    { kind: "text", text: "narration" },
    { kind: "tool_use", tool: "cadcode", status: "ok" },
    { kind: "artifact", file: "part.step" },
    { kind: "plan", plan: "# Plan", status: "proposed" },
    { kind: "error", message: "boom" },
  ];
  const { trace, body } = partitionTurnBlocks(blocks);
  assert.deepEqual(trace.map((b) => b.kind), ["text", "tool_use"]);
  assert.deepEqual(body.map((b) => b.kind), ["artifact", "plan", "error"]);
});

test("partitionTurnBlocks tolerates non-array input", () => {
  assert.deepEqual(partitionTurnBlocks(undefined), { trace: [], body: [] });
});
