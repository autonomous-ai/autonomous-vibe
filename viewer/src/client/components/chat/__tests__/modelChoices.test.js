import test from "node:test";
import assert from "node:assert/strict";

import {
  availableModelChoices,
  DEFAULT_MODEL,
  labelForModel,
  MODEL_CHOICES,
} from "../modelChoices.js";

test("MODEL_CHOICES lists the selectable models led by Fable, the default", () => {
  assert.deepEqual(
    MODEL_CHOICES.map((c) => c.id),
    ["fable", "opus", "sonnet", "vibe-free", "vibe-pro"],
  );
  assert.equal(DEFAULT_MODEL, "fable");
  assert.ok(MODEL_CHOICES.some((c) => c.id === DEFAULT_MODEL));
});

test("Free and Pro are distinct rows that share one underlying model value", () => {
  const ids = MODEL_CHOICES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");

  const free = MODEL_CHOICES.find((c) => c.id === "vibe-free");
  const pro = MODEL_CHOICES.find((c) => c.id === "vibe-pro");
  assert.equal(free.value, pro.value, "same model");
  assert.equal(free.value, "minimax,minimax/minimax-m3");
});

test("availableModelChoices hides proxy models unless signed in", () => {
  assert.deepEqual(
    availableModelChoices({ signedInToPanda: false }).map((c) => c.value),
    ["fable", "opus", "sonnet"],
  );
  assert.deepEqual(
    availableModelChoices({ signedInToPanda: true }).map((c) => c.id),
    ["fable", "opus", "sonnet", "vibe-free", "vibe-pro"],
  );
});

test("labelForModel returns the friendly label for a known selection id", () => {
  assert.equal(labelForModel("opus"), "Opus");
  assert.equal(labelForModel("sonnet"), "Sonnet");
  assert.equal(labelForModel("fable"), "Fable");
  assert.equal(labelForModel("vibe-free"), "Free");
  assert.equal(labelForModel("vibe-pro"), "Pro");
});

test("labelForModel falls back to the default label for unset or unknown ids", () => {
  assert.equal(labelForModel(undefined), "Fable");
  assert.equal(labelForModel(""), "Fable");
  assert.equal(labelForModel("gpt-4"), "Fable");
  // The raw model string is no longer a selection id.
  assert.equal(labelForModel("minimax,minimax/minimax-m3"), "Fable");
});
