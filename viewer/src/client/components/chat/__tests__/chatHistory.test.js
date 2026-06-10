import assert from "node:assert/strict";
import test from "node:test";

import { groupTurns } from "../chatHistoryModel.js";

test("groupTurns groups assistant turns under the preceding user prompt", () => {
  const history = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant" },
    { id: "a2", role: "assistant" },
    { id: "u2", role: "user" },
    { id: "a3", role: "assistant" },
  ];
  const groups = groupTurns(history);
  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((group) => group.map((turn) => turn.id)),
    [["u1", "a1", "a2"], ["u2", "a3"]],
  );
});

test("groupTurns starts a group when history begins with assistant output", () => {
  const history = [{ id: "a1", role: "assistant" }];
  const groups = groupTurns(history);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((turn) => turn.id), ["a1"]);
});
