// Smoke test for the sidebar's empty-state path. We can't render JSX inside
// node:test directly without a transform step (the rest of the viewer's
// tests are pure JS), so this exercises the store + selectors the sidebar
// reads and asserts the "empty history => empty state" derivation that
// ChatHistory uses.

import assert from "node:assert/strict";
import test from "node:test";

import {
  attachChatEventStream,
  detachChatEventStream,
  getChatState,
  resetChatStore,
  __setTransportForTesting,
} from "../../../store/chat.js";

test("ChatSidebar empty state: store starts with no history and no in-flight turn", () => {
  resetChatStore();
  const state = getChatState();
  assert.equal(state.history.length, 0);
  assert.equal(state.turnInProgress, false);
  assert.equal(state.currentTurnId, "");
  assert.equal(state.lastError, "");
  assert.equal(state.isHydratingSession, false);
});

test("ChatSidebar wiring: attaching to a fresh transport produces a working event subscription", () => {
  resetChatStore();
  const handlers = new Map();
  const restore = __setTransportForTesting({
    events: {
      subscribe(kind, handler) {
        if (!handlers.has(kind)) handlers.set(kind, new Set());
        handlers.get(kind).add(handler);
        return () => handlers.get(kind).delete(handler);
      },
    },
  });

  try {
    const detach = attachChatEventStream();
    const chatHandlers = handlers.get("chat_event");
    assert.equal(chatHandlers?.size, 1);
    // Detach should drop the only subscriber, leaving the bus quiescent.
    detach();
    assert.equal(handlers.get("chat_event")?.size || 0, 0);
  } finally {
    detachChatEventStream();
    restore();
    resetChatStore();
  }
});
