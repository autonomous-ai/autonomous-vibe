// Integration: the chat store must not start a turn while the `claude` CLI is
// missing — the send parks behind the setup dialog, the in-app installer runs,
// and the send fires automatically once it succeeds. Also covers the fallback:
// a driver-reported CLAUDE_NOT_INSTALLED chat error opens the same dialog.

import assert from "node:assert/strict";
import test from "node:test";

import {
  __setTransportForTesting,
  attachChatEventStream,
  detachChatEventStream,
  getChatState,
  resetChatStore,
  setProject,
  startTurn,
} from "../../../store/chat.js";
import {
  getClaudeSetupState,
  resetClaudeSetupStore,
} from "../../../store/claudeSetup.js";

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
  };
}

test("startTurn parks behind the installer when the CLI is missing, then auto-sends", async (t) => {
  resetChatStore();
  resetClaudeSetupStore();
  setProject("proj-1");

  const turns = [];
  let resolveInstall;
  const restore = __setTransportForTesting({
    async app_prereq_check() {
      return { claudeCli: { found: false } };
    },
    app_install_claude_code() {
      return new Promise((resolve) => {
        resolveInstall = resolve;
      });
    },
    onClaudeInstallProgress() {
      return () => {};
    },
    async chat_start_turn(req) {
      turns.push(req);
      return { turnId: "turn-9" };
    },
  });
  t.after(() => {
    restore();
    resetChatStore();
    resetClaudeSetupStore();
  });

  const send = startTurn("build a phone stand");
  await tick();

  assert.equal(turns.length, 0, "no inference reaches the backend without the CLI");
  assert.equal(getClaudeSetupState().open, true, "setup dialog opened instead");
  assert.equal(getClaudeSetupState().phase, "installing");

  resolveInstall({ version: "2.1.0", binaryPath: "/x" });
  const response = await send;

  assert.deepEqual(turns, [{ projectId: "proj-1", userMessage: "build a phone stand" }]);
  assert.equal(response?.turnId, "turn-9", "the original send resolves normally");
  const state = getChatState();
  assert.equal(state.history.at(-1)?.userText, "build a phone stand");
});

test("startTurn proceeds untouched when the CLI is present", async (t) => {
  resetChatStore();
  resetClaudeSetupStore();
  setProject("proj-1");

  const turns = [];
  const restore = __setTransportForTesting({
    async app_prereq_check() {
      return { claudeCli: { found: true, version: "2.1.0" } };
    },
    async chat_start_turn(req) {
      turns.push(req);
      return { turnId: "turn-1" };
    },
  });
  t.after(() => {
    restore();
    resetChatStore();
    resetClaudeSetupStore();
  });

  const response = await startTurn("hello");
  assert.equal(response?.turnId, "turn-1");
  assert.equal(turns.length, 1);
  assert.equal(getClaudeSetupState().open, false);
});

test("a CLAUDE_NOT_INSTALLED chat error opens the setup dialog as a fallback", async (t) => {
  resetChatStore();
  resetClaudeSetupStore();
  setProject("proj-1");

  const events = makeMockEvents();
  const restore = __setTransportForTesting({
    events: events.bus,
    app_install_claude_code() {
      return new Promise(() => {});
    },
    onClaudeInstallProgress() {
      return () => {};
    },
  });
  const detach = attachChatEventStream();
  t.after(() => {
    detach();
    detachChatEventStream();
    restore();
    resetChatStore();
    resetClaudeSetupStore();
  });

  events.emit("chat_event", { kind: "turn_start", turnId: "t1", phase: "plan" });
  events.emit("chat_event", {
    kind: "error",
    turnId: "t1",
    message: "`claude` CLI not found. Install Claude Code (https://claude.ai/install).",
  });
  await tick();

  const state = getClaudeSetupState();
  assert.equal(state.open, true, "dialog opens instead of leaving only the raw error");
  assert.equal(state.phase, "installing");

  // Unrelated errors never open it.
  resetClaudeSetupStore();
  events.emit("chat_event", { kind: "error", turnId: "t2", message: "boom" });
  await tick();
  assert.equal(getClaudeSetupState().open, false);
});
