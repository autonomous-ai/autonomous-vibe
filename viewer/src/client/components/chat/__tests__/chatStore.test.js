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
  hydrateSession,
  resetChatStore,
  setProject,
  startTurn,
} from "../../../store/chat.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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

test("startTurn appends the view-context note to the sent message but not the bubble", async () => {
  resetChatStore();
  setProject("proj-1");
  dispatch({ type: "set_pending_view_context", note: "[Highlighted-view context: center.]" });

  const calls = [];
  const restore = __setTransportForTesting({
    async chat_start_turn(req) {
      calls.push(req);
      return { turnId: "turn-ctx" };
    },
  });

  try {
    await startTurn("add vents here");
    // Model sees text + context; the echoed user bubble keeps just the text.
    assert.equal(
      calls[0].userMessage,
      "add vents here\n\n[Highlighted-view context: center.]",
    );
    const state = getChatState();
    assert.equal(state.history[0].userText, "add vents here");
    // Consumed on send so it can't leak into the next turn.
    assert.equal(state.pendingViewContext, "");
  } finally {
    restore();
    resetChatStore();
  }
});

test("removing the last attachment clears a stale view-context note", () => {
  resetChatStore();
  dispatch({ type: "set_pending_view_context", note: "[ctx]" });
  dispatch({ type: "add_pending_attachment", attachment: { id: "a1", name: "x.png" } });
  dispatch({ type: "add_pending_attachment", attachment: { id: "a2", name: "y.png" } });

  // Removing one of two attachments keeps the note (a highlight may remain).
  dispatch({ type: "remove_pending_attachment", id: "a1" });
  assert.equal(getChatState().pendingViewContext, "[ctx]");

  // Removing the last one drops the now-orphaned note.
  dispatch({ type: "remove_pending_attachment", id: "a2" });
  assert.equal(getChatState().pendingViewContext, "");
  resetChatStore();
});

test("startTurn injects the suggestion directive for a highlight sent with no text", async () => {
  resetChatStore();
  setProject("proj-1");
  dispatch({ type: "set_pending_view_context", note: "[ctx]" });

  const calls = [];
  const restore = __setTransportForTesting({
    async chat_start_turn(req) {
      calls.push(req);
      return { turnId: "turn-suggest" };
    },
  });

  try {
    // Empty composer + an attached highlight: the image satisfies the send guard.
    await startTurn("", {
      attachments: [{ name: "h.png", mediaType: "image/png", dataBase64: "AA==" }],
    });
    assert.match(calls[0].userMessage, /improvement options for/);
    assert.match(calls[0].userMessage, /\[ctx\]/);
  } finally {
    restore();
    resetChatStore();
  }
});

test("startTurn omits the suggestion directive when the user typed an instruction", async () => {
  resetChatStore();
  setProject("proj-1");
  dispatch({ type: "set_pending_view_context", note: "[ctx]" });

  const calls = [];
  const restore = __setTransportForTesting({
    async chat_start_turn(req) {
      calls.push(req);
      return { turnId: "turn-typed" };
    },
  });

  try {
    await startTurn("add a fillet", {
      attachments: [{ name: "h.png", mediaType: "image/png", dataBase64: "AA==" }],
    });
    assert.doesNotMatch(calls[0].userMessage, /improvement options for/);
    assert.equal(calls[0].userMessage, "add a fillet\n\n[ctx]");
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

test("setProject rehydrates history from the persisted session", async () => {
  resetChatStore();
  const calls = [];
  const restore = __setTransportForTesting({
    async chat_session_state(projectId) {
      calls.push(projectId);
      return {
        sessionId: "s-1",
        turnInProgress: false,
        history: [
          { role: "user", content: "make a cup", at: 1000 },
          { role: "assistant", content: "Here is the plan.", at: 2000 },
        ],
      };
    },
  });
  try {
    setProject("proj-h");
    await tick(); // hydration is fire-and-forget
    assert.deepEqual(calls, ["proj-h"]);
    const state = getChatState();
    assert.equal(state.currentProjectId, "proj-h");
    assert.equal(state.history.length, 2);
    assert.equal(state.history[0].role, "user");
    assert.equal(state.history[0].userText, "make a cup");
    assert.equal(state.history[1].role, "assistant");
    assert.equal(state.history[1].blocks[0].text, "Here is the plan.");
  } finally {
    restore();
    resetChatStore();
  }
});

test("setProject skips hydration when the project is unchanged or cleared", async () => {
  resetChatStore();
  const calls = [];
  const restore = __setTransportForTesting({
    async chat_session_state(projectId) {
      calls.push(projectId);
      return { sessionId: "s", turnInProgress: false, history: [] };
    },
  });
  try {
    setProject("proj-1");
    await tick();
    setProject("proj-1"); // same project → reducer no-op, no refetch
    setProject(""); // clearing → no fetch
    await tick();
    assert.deepEqual(calls, ["proj-1"]);
  } finally {
    restore();
    resetChatStore();
  }
});

test("hydrateSession does not clobber a turn that started meanwhile", async () => {
  resetChatStore();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const restore = __setTransportForTesting({
    async chat_session_state() {
      await gate;
      return {
        sessionId: "s",
        turnInProgress: false,
        history: [{ role: "user", content: "stale", at: 1 }],
      };
    },
    async chat_start_turn() {
      return { turnId: "t-1" };
    },
  });
  try {
    setProject("proj-x"); // kicks off hydrateSession, blocked on the gate
    await startTurn("new message"); // sets turnInProgress + a live user turn
    release();
    await tick();
    const state = getChatState();
    // Hydration must have bailed: the live turn stands, the stale row is gone.
    assert.equal(state.turnInProgress, true);
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0].userText, "new message");
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
