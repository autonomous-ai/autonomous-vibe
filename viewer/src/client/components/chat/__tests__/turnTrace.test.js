// Tests for the inline turn-trace data layer: the reducer stamping the thinking
// window (firstTextAt / lastActivityAt), the thinkingDurationMs selector that
// drives the duration readout, and splitTurnBlocks — the three-way split that
// feeds the inline reasoning block, the collapsible Activity disclosure, and the
// always-visible answer body.

import assert from "node:assert/strict";
import test from "node:test";

import {
  INITIAL_CHAT_STATE,
  chatReducer,
  thinkingDurationMs,
  segmentTurnBlocks,
  segmentDurationMs,
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

// -- per-block timestamps (per-segment timing) -------------------------------

test("blocks are stamped with creation/end timestamps for per-segment timing", () => {
  let s = ev(INITIAL_CHAT_STATE, { kind: "turn_start", turnId: "t1" }, 1000);
  s = ev(s, { kind: "thinking_delta", turnId: "t1", text: "hmm" }, 1500);
  s = ev(s, { kind: "tool_use_start", turnId: "t1", tool: "Read", toolUseId: "u1", input: {} }, 2000);
  s = ev(s, { kind: "tool_use_end", turnId: "t1", tool: "Read", toolUseId: "u1", ok: true }, 5000);
  s = ev(s, { kind: "text_delta", turnId: "t1", text: "done" }, 5200);
  const blocks = s.history[0].blocks;
  assert.equal(blocks.find((b) => b.kind === "thinking").at, 1500);
  const tool = blocks.find((b) => b.kind === "tool_use");
  assert.equal(tool.at, 2000, "tool stamped at start");
  assert.equal(tool.endedAt, 5000, "tool stamped at end");
  assert.equal(blocks.find((b) => b.kind === "text").at, 5200);
});

// -- segmentDurationMs -------------------------------------------------------

test("segmentDurationMs spans the first block's start to the last tool's end", () => {
  const segment = {
    reasoning: [{ kind: "thinking", text: "x", at: 1000 }],
    activity: [
      { kind: "tool_use", tool: "Read", at: 1200, endedAt: 1800, status: "ok" },
      { kind: "tool_use", tool: "Write", at: 1900, endedAt: 4000, status: "ok" },
    ],
  };
  assert.equal(segmentDurationMs(segment), 3000); // 4000 - 1000
});

test("segmentDurationMs counts to `now` for the active (live) segment", () => {
  const segment = { reasoning: [], activity: [{ kind: "tool_use", at: 1000, status: "running" }] };
  assert.equal(segmentDurationMs(segment, 4500, true), 3500); // now - start
});

test("segmentDurationMs is 0 without timestamps (hydrated history)", () => {
  assert.equal(segmentDurationMs({ reasoning: [{ kind: "thinking", text: "x" }], activity: [] }), 0);
  assert.equal(segmentDurationMs(undefined), 0);
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

// -- segmentTurnBlocks -------------------------------------------------------

test("interleaves into reasoning+tools segments; reasoning after tools starts a new one", () => {
  const blocks = [
    { kind: "text", text: "Let me check the workspace." },
    { kind: "tool_use", tool: "Read", status: "ok" },
    { kind: "tool_use", tool: "Glob", status: "ok" },
    { kind: "text", text: "Now I'll write the parts." },
    { kind: "tool_use", tool: "Write", status: "ok" },
    { kind: "text", text: "Here is your final answer." },
  ];
  const { segments, body } = segmentTurnBlocks(blocks);
  assert.equal(segments.length, 2, "two reasoning→tools segments");
  // Segment 1: first narration + the two reads.
  assert.deepEqual(segments[0].reasoning.map((b) => b.text), ["Let me check the workspace."]);
  assert.deepEqual(segments[0].activity.map((b) => b.tool), ["Read", "Glob"]);
  // Segment 2: second narration + the write.
  assert.deepEqual(segments[1].reasoning.map((b) => b.text), ["Now I'll write the parts."]);
  assert.deepEqual(segments[1].activity.map((b) => b.tool), ["Write"]);
  // Body = only the trailing answer.
  assert.deepEqual(body.map((b) => b.text), ["Here is your final answer."]);
});

test("consecutive reasoning blocks accumulate into the same segment", () => {
  const blocks = [
    { kind: "text", text: "narration" },
    { kind: "thinking", text: "thought" },
    { kind: "tool_use", tool: "Read", status: "ok" },
    { kind: "text", text: "answer" },
  ];
  const { segments, body } = segmentTurnBlocks(blocks);
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0].reasoning.map((b) => b.kind), ["text", "thinking"]);
  assert.deepEqual(segments[0].activity.map((b) => b.tool), ["Read"]);
  assert.deepEqual(body.map((b) => b.text), ["answer"]);
});

test("a plain reply yields no segments and keeps all text in the body", () => {
  const blocks = [{ kind: "text", text: "Just a plain reply." }];
  const { segments, body } = segmentTurnBlocks(blocks);
  assert.deepEqual(segments, []);
  assert.deepEqual(body, blocks);
});

test("a reasoning-only turn yields one tool-less segment", () => {
  const blocks = [
    { kind: "text", text: "preamble" },
    { kind: "thinking", text: "reasoning" },
    { kind: "text", text: "answer" },
  ];
  const { segments, body } = segmentTurnBlocks(blocks);
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0].reasoning.map((b) => b.text), ["preamble", "reasoning"]);
  assert.deepEqual(segments[0].activity, []);
  assert.deepEqual(body.map((b) => b.text), ["answer"]);
});

test("tools with no leading reasoning form a single reasoning-less segment", () => {
  const blocks = [
    { kind: "tool_use", tool: "Read", status: "ok" },
    { kind: "tool_use", tool: "Grep", status: "ok" },
    { kind: "text", text: "answer" },
  ];
  const { segments, body } = segmentTurnBlocks(blocks);
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0].reasoning, []);
  assert.deepEqual(segments[0].activity.map((b) => b.tool), ["Read", "Grep"]);
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
  const { segments, body } = segmentTurnBlocks(blocks);
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0].reasoning.map((b) => b.kind), ["text"]);
  assert.deepEqual(segments[0].activity.map((b) => b.kind), ["tool_use"]);
  assert.deepEqual(body.map((b) => b.kind), ["artifact", "plan", "error"]);
});

test("segmentTurnBlocks tolerates non-array input", () => {
  assert.deepEqual(segmentTurnBlocks(undefined), { segments: [], body: [] });
});
