// End-to-end tests of the chat store's actions + event-stream attachment.
// Mocks the transport via __setTransportForTesting and verifies that store
// dispatches flow through the reducer correctly. Covers the "ChatInput sends
// a message" and event-stream behaviors.

import assert from "node:assert/strict";
import test from "node:test";

import {
  __setTransportForTesting,
  attachChatEventStream,
  cancelTurn,
  detachChatEventStream,
  dispatch,
  getChatState,
  resetChatStore,
  setProject,
  startTurn,
} from "../../../store/chat.js";

function makeMockEvents() {
  const handlers = new Map();
  return {
    bus: {
      subscribe(kind, handler) {
        if (!handlers.has(kind)) handlers.set(kind, new Set());
        handlers.get(kind).add(handler);
        return () => handlers.get(kind).delete(handler);
      },
    },
    emit(kind, payload) {
      for (const handler of handlers.get(kind) || []) {
        handler(payload);
      }
    },
    handlerCount(kind) {
      return handlers.get(kind)?.size || 0;
    },
  };
}

test("startTurn dispatches the user turn and consumes pending tokens", async () => {
  resetChatStore();
  setProject("proj-1");
  dispatch({ type: "add_pending_token", token: "@cad[parts/base#f1]" });

  const calls = [];
  const restore = __setTransportForTesting({
    async chat_start_turn(req) {
      calls.push(req);
      return { turnId: "turn-42" };
    },
  });

  try {
    const result = await startTurn("make it taller");
    assert.deepEqual(calls, [{ projectId: "proj-1", userMessage: "make it taller" }]);
    assert.equal(result.turnId, "turn-42");
    const state = getChatState();
    assert.equal(state.currentTurnId, "turn-42");
    assert.equal(state.turnInProgress, true);
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0].role, "user");
    assert.equal(state.history[0].userText, "make it taller");
    assert.deepEqual(state.pendingTokens, []);
  } finally {
    restore();
    resetChatStore();
  }
});

test("startTurn refuses to dispatch when no project is selected", async () => {
  resetChatStore();
  const calls = [];
  const restore = __setTransportForTesting({
    async chat_start_turn(req) {
      calls.push(req);
      return { turnId: "x" };
    },
  });
  try {
    const result = await startTurn("hi");
    assert.equal(result, null);
    assert.equal(calls.length, 0);
    assert.equal(getChatState().lastError, "No project selected");
  } finally {
    restore();
    resetChatStore();
  }
});

test("startTurn refuses to start a second turn while one is in progress", async () => {
  resetChatStore();
  setProject("proj-1");
  const calls = [];
  const restore = __setTransportForTesting({
    async chat_start_turn(req) {
      calls.push(req);
      return { turnId: `turn-${calls.length}` };
    },
  });
  try {
    await startTurn("first");
    const result = await startTurn("second");
    assert.equal(result, null);
    assert.equal(calls.length, 1);
    assert.equal(getChatState().lastError, "A turn is already in progress");
  } finally {
    restore();
    resetChatStore();
  }
});

test("cancelTurn invokes the transport with the current turn id", async () => {
  resetChatStore();
  setProject("proj-1");
  const cancels = [];
  const restore = __setTransportForTesting({
    async chat_start_turn() {
      return { turnId: "t-7" };
    },
    async chat_cancel_turn(turnId) {
      cancels.push(turnId);
    },
  });
  try {
    await startTurn("do the thing");
    assert.equal(getChatState().turnInProgress, true);
    await cancelTurn();
    assert.deepEqual(cancels, ["t-7"]);
  } finally {
    restore();
    resetChatStore();
  }
});

test("attachChatEventStream subscribes and pipes events into the reducer", () => {
  resetChatStore();
  const events = makeMockEvents();
  const restore = __setTransportForTesting({ events: events.bus });

  try {
    const detach = attachChatEventStream();
    assert.equal(events.handlerCount("chat_event"), 1);

    events.emit("chat_event", { kind: "turn_start", turnId: "t-9" });
    events.emit("chat_event", { kind: "text_delta", turnId: "t-9", text: "hi" });
    events.emit("chat_event", { kind: "turn_end", turnId: "t-9" });

    const state = getChatState();
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0].role, "assistant");
    assert.equal(state.history[0].blocks[0].text, "hi");
    assert.equal(state.turnInProgress, false);

    detach();
    assert.equal(events.handlerCount("chat_event"), 0);
  } finally {
    detachChatEventStream();
    restore();
    resetChatStore();
  }
});

test("attachChatEventStream is idempotent — second call replaces first", () => {
  resetChatStore();
  const events = makeMockEvents();
  const restore = __setTransportForTesting({ events: events.bus });
  try {
    attachChatEventStream();
    attachChatEventStream();
    assert.equal(events.handlerCount("chat_event"), 1);
  } finally {
    detachChatEventStream();
    restore();
    resetChatStore();
  }
});
