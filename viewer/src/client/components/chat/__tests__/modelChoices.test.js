import test from "node:test";
import assert from "node:assert/strict";

import {
  availableModelChoices,
  DEFAULT_MODEL,
  labelForModel,
  MODEL_CHOICES,
} from "../modelChoices.js";

test("MODEL_CHOICES lists the selectable models with the default first", () => {
  assert.deepEqual(
    MODEL_CHOICES.map((c) => c.value),
    ["opus", "sonnet", "minimax-m3"],
  );
  assert.equal(MODEL_CHOICES[0].value, DEFAULT_MODEL);
});

test("availableModelChoices hides proxy model unless signed in", () => {
  assert.deepEqual(
    availableModelChoices({ signedInToPanda: false }).map((c) => c.value),
    ["opus", "sonnet"],
  );
  assert.deepEqual(
    availableModelChoices({ signedInToPanda: true }).map((c) => c.value),
    ["opus", "sonnet", "minimax-m3"],
  );
});

test("labelForModel returns the friendly label for a known model", () => {
  assert.equal(labelForModel("opus"), "Opus");
  assert.equal(labelForModel("sonnet"), "Sonnet");
  assert.equal(labelForModel("minimax-m3"), "MiniMax M3");
});

test("labelForModel falls back to the default label for unset or unknown models", () => {
  assert.equal(labelForModel(undefined), "Opus");
  assert.equal(labelForModel(""), "Opus");
  assert.equal(labelForModel("gpt-4"), "Opus");
});
