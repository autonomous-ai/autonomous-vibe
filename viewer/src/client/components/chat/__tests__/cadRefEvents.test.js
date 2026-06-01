// Tests for the cad-ref pub-sub bus that bridges the 3D viewer's selection
// into the chat sidebar's pendingTokens. Covers the "click-to-refer" wiring
// requirement.

import assert from "node:assert/strict";
import test from "node:test";

import {
  bindCadRefSelectionToChatInput,
  emitCadRefSelection,
  subscribeCadRefSelection,
  __normalizeTokens,
} from "../cadRefEvents.js";
import { getChatState, resetChatStore } from "../../../store/chat.js";

test("__normalizeTokens accepts a single string, an array, or newline-separated input", () => {
  assert.deepEqual(__normalizeTokens("@cad[parts/base#f1]"), ["@cad[parts/base#f1]"]);
  assert.deepEqual(
    __normalizeTokens(["@cad[a#f1]", "@cad[b#f2]"]),
    ["@cad[a#f1]", "@cad[b#f2]"],
  );
  assert.deepEqual(
    __normalizeTokens("@cad[a#f1]\n@cad[b#f2]"),
    ["@cad[a#f1]", "@cad[b#f2]"],
  );
});

test("__normalizeTokens drops empty / non-token lines so plain text doesn't leak", () => {
  assert.deepEqual(__normalizeTokens(""), []);
  assert.deepEqual(__normalizeTokens(["", "   ", "not a token"]), []);
  assert.deepEqual(
    __normalizeTokens(["plain text", "@cad[a#f1]"]),
    ["@cad[a#f1]"],
  );
});

test("emitCadRefSelection fans out to subscribers exactly once per event", () => {
  const received = [];
  const unsubscribe = subscribeCadRefSelection((tokens) => received.push(tokens));
  emitCadRefSelection(["@cad[a#f1]", "@cad[b#f2]"]);
  emitCadRefSelection("@cad[c#f3]");
  unsubscribe();
  emitCadRefSelection("@cad[d#f4]"); // post-unsubscribe, should not be seen
  assert.deepEqual(received, [["@cad[a#f1]", "@cad[b#f2]"], ["@cad[c#f3]"]]);
});

test("bindCadRefSelectionToChatInput pushes incoming tokens onto the chat store pendingTokens", () => {
  resetChatStore();
  const unbind = bindCadRefSelectionToChatInput();
  try {
    emitCadRefSelection("@cad[parts/base#f1]");
    emitCadRefSelection(["@cad[parts/base#f2]"]);
    // Duplicates should be deduped by the reducer.
    emitCadRefSelection("@cad[parts/base#f1]");
    const state = getChatState();
    assert.deepEqual(state.pendingTokens, ["@cad[parts/base#f1]", "@cad[parts/base#f2]"]);
  } finally {
    unbind();
    resetChatStore();
  }
});
