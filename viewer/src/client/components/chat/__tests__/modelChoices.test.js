import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_MODEL, labelForModel, MODEL_CHOICES } from "../modelChoices.js";

test("MODEL_CHOICES lists the three selectable models with the default first", () => {
  assert.deepEqual(
    MODEL_CHOICES.map((c) => c.value),
    ["opus", "kimi,moonshotai/kimi-k2.6", "minimax,minimax/minimax-m3"],
  );
  assert.equal(MODEL_CHOICES[0].value, DEFAULT_MODEL);
});

test("labelForModel returns the friendly label for a known model", () => {
  assert.equal(labelForModel("kimi,moonshotai/kimi-k2.6"), "Kimi K2.6");
  assert.equal(labelForModel("minimax,minimax/minimax-m3"), "MiniMax M3");
});

test("labelForModel falls back to the default label for unset or unknown models", () => {
  assert.equal(labelForModel(undefined), "Opus");
  assert.equal(labelForModel(""), "Opus");
  assert.equal(labelForModel("gpt-4"), "Opus");
});
