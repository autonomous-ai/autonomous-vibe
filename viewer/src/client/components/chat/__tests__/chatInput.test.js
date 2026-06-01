// Tests for the pure helper in ChatInput.jsx. The rendered React component
// is exercised indirectly via the chat store integration test
// (chatStore.test.js) — this file pins down the input-formatting contract
// the component depends on.

import assert from "node:assert/strict";
import test from "node:test";

import { buildSendValue, PLACEHOLDER_PROJECT_NAME } from "../chatInputHelpers.js";

test("buildSendValue returns the trimmed text when no tokens are queued", () => {
  assert.equal(buildSendValue("  hello world\n", []), "hello world");
});

test("buildSendValue prepends pending tokens space-joined on their own line", () => {
  const result = buildSendValue("make it taller", [
    "@cad[parts/base#f1]",
    "@cad[parts/base#f2]",
  ]);
  assert.equal(result, "@cad[parts/base#f1] @cad[parts/base#f2]\n\nmake it taller");
});

test("buildSendValue sends just the tokens when the text body is empty", () => {
  const result = buildSendValue("   ", ["@cad[parts/base#f1]"]);
  assert.equal(result, "@cad[parts/base#f1]");
});

test("buildSendValue ignores empty/whitespace token entries", () => {
  const result = buildSendValue("hi", ["", "   ", "@cad[a#f1]"]);
  assert.equal(result, "@cad[a#f1]\n\nhi");
});

test("buildSendValue tolerates non-array pending tokens", () => {
  assert.equal(buildSendValue("hello", null), "hello");
  assert.equal(buildSendValue("hello", undefined), "hello");
});

test("PLACEHOLDER_PROJECT_NAME is the neutral name a lazily-created project carries", () => {
  // Lazily-created projects are never named by the user; Claude's AI title
  // replaces this in place once available (see commands/project.rs).
  assert.equal(PLACEHOLDER_PROJECT_NAME, "New project");
});
