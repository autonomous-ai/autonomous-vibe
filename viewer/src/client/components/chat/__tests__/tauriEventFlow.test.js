// Flow test for the Tauri -> React chat-event seam.
//
// Unlike chatStore.test.js (which injects event *payloads* directly via a fake
// `transport.events` bus), this drives the REAL transport path that runs inside
// the bundled app:
//
//   setTauriBridge({ listen }) -> transport.events.subscribe -> listenEvent
//     -> bridge.listen -> attachChatEventStream -> chatReducer
//
// The bug this guards against: Tauri's native `listen(event, cb)` invokes `cb`
// with a full Event<T> object `{event, id, payload}`, NOT the payload. If the
// bridge does not unwrap `.payload` (see `adaptTauriListen`), every chat_event
// reaches the reducer with `kind === undefined` -> reducer `default` branch ->
// nothing renders and `turn_end` never clears the spinner (stuck "Cancel turn").
//
// Production wires the unwrap inside `detectTauri()`; `setTauriBridge` does NOT,
// so we apply `adaptTauriListen` here exactly as production does.

import assert from "node:assert/strict";
import test from "node:test";

import {
  _resetTransportForTests,
  adaptTauriListen,
  setTauriBridge,
} from "../../../lib/transport.ts";
import {
  attachChatEventStream,
  detachChatEventStream,
  getChatState,
  resetChatStore,
  setProject,
} from "../../../store/chat.js";

// A bridge whose `listen` behaves like @tauri-apps/api/event#listen: it hands
// the callback a full Event<T> ({event, id, payload}). `emitTauri` simulates the
// backend firing an event. Registration is synchronous so events emitted right
// after attachChatEventStream() are delivered (the async part is only unlisten).
function makeTauriShapedBridge({ adapt }) {
  const handlers = new Map();
  const rawListen = (event, cb) => {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(cb);
    return Promise.resolve(() => handlers.get(event)?.delete(cb));
  };
  return {
    bridge: {
      invoke: async () => undefined,
      // `adapt: true` mirrors production (detectTauri wraps tauriListen);
      // `adapt: false` is the pre-fix wiring used to reproduce the bug.
      listen: adapt ? adaptTauriListen(rawListen) : rawListen,
    },
    emitTauri(event, payload) {
      for (const cb of handlers.get(event) || []) cb({ event, id: 1, payload });
    },
  };
}

const PANDA_QUESTIONS = [
  "Pick a mount:",
  "```panda-questions",
  '{"questions":[{"question":"Mount?","header":"Mount","multiSelect":false,',
  '"options":[{"label":"Screw","description":"M3"}]}]}',
  "```",
].join("\n");

test("full plan+implement turn flows through the real Tauri seam into render state", () => {
  resetChatStore();
  setProject("proj-flow");
  _resetTransportForTests();
  const { bridge, emitTauri } = makeTauriShapedBridge({ adapt: true });
  setTauriBridge(bridge);

  try {
    attachChatEventStream();

    // --- Plan turn: model streams text (incl. a panda-questions fence) and
    // proposes a plan, then the turn ends. ---
    emitTauri("chat_event", { kind: "turn_start", turnId: "t-plan", phase: "plan" });
    emitTauri("chat_event", { kind: "thinking_delta", turnId: "t-plan", text: "considering..." });
    emitTauri("chat_event", { kind: "text_delta", turnId: "t-plan", text: PANDA_QUESTIONS });
    emitTauri("chat_event", { kind: "plan_proposed", turnId: "t-plan", plan: "# Plan\n- base\n- lid" });
    emitTauri("chat_event", { kind: "turn_end", turnId: "t-plan" });

    let state = getChatState();
    // The assistant turn rendered (this is the box the user reported was blank).
    const planTurn = state.history.find((t) => t.id === "t-plan" && t.role === "assistant");
    assert.ok(planTurn, "assistant plan turn must exist (turn_start was delivered)");
    assert.equal(planTurn.phase, "plan");
    const textBlock = planTurn.blocks.find((b) => b.kind === "text");
    assert.ok(textBlock && textBlock.text.includes("panda-questions"), "assistant text rendered");
    assert.ok(planTurn.blocks.some((b) => b.kind === "plan"), "plan block rendered");
    // Plan gates approval, and the spinner is cleared after turn_end.
    assert.equal(state.awaitingApproval, true, "plan_proposed gates approval");
    assert.equal(state.turnInProgress, false, "spinner clears on turn_end (no stuck Cancel turn)");

    // --- Implement turn: tool runs and an artifact is produced. ---
    emitTauri("chat_event", { kind: "turn_start", turnId: "t-impl", phase: "implement" });
    emitTauri("chat_event", { kind: "tool_use_start", turnId: "t-impl", tool: "Skill", input: {} });
    emitTauri("chat_event", { kind: "tool_use_end", turnId: "t-impl", tool: "Skill", ok: true });
    emitTauri("chat_event", { kind: "artifact_changed", turnId: "t-impl", file: "cube.stl", reason: "new" });
    emitTauri("chat_event", { kind: "turn_end", turnId: "t-impl" });

    state = getChatState();
    const implTurn = state.history.find((t) => t.id === "t-impl" && t.role === "assistant");
    assert.ok(implTurn, "assistant implement turn exists");
    assert.equal(implTurn.phase, "implement");
    assert.ok(implTurn.blocks.some((b) => b.kind === "artifact" && b.file === "cube.stl"), "artifact rendered");
    const tool = implTurn.blocks.find((b) => b.kind === "tool_use");
    assert.ok(tool && tool.status === "ok", "tool_use resolved ok");
    assert.equal(state.turnInProgress, false, "spinner clears after build turn");
  } finally {
    detachChatEventStream();
    setTauriBridge(null);
    _resetTransportForTests();
    resetChatStore();
  }
});

test("regression: a raw (un-unwrapped) Tauri bridge drops every event and hangs the spinner", () => {
  // This reproduces the original bug: without adaptTauriListen, the reducer
  // receives {event,id,payload} so `kind` is undefined -> default branch.
  resetChatStore();
  setProject("proj-bug");
  _resetTransportForTests();
  const { bridge, emitTauri } = makeTauriShapedBridge({ adapt: false });
  setTauriBridge(bridge);

  try {
    attachChatEventStream();
    // Simulate the store having started a turn (queue_user_message sets this).
    // Then the backend fires events the UI should react to.
    emitTauri("chat_event", { kind: "turn_start", turnId: "t-bug", phase: "plan" });
    emitTauri("chat_event", { kind: "text_delta", turnId: "t-bug", text: "hello" });
    emitTauri("chat_event", { kind: "turn_end", turnId: "t-bug" });

    const state = getChatState();
    // Every event was dropped: no assistant turn, no text rendered.
    assert.equal(
      state.history.some((t) => t.role === "assistant"),
      false,
      "raw bridge: events are dropped, nothing renders (documents the bug)",
    );
  } finally {
    detachChatEventStream();
    setTauriBridge(null);
    _resetTransportForTests();
    resetChatStore();
  }
});
