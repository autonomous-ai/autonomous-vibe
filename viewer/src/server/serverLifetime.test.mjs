import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SERVER_LIFETIME_MS,
  formatServerLifetime,
  normalizeServerLifetimeMs,
} from "./serverLifetime.mjs";

test("normalizeServerLifetimeMs is opt-in unless a default is provided", () => {
  assert.equal(normalizeServerLifetimeMs(undefined), null);
  assert.equal(normalizeServerLifetimeMs("", DEFAULT_SERVER_LIFETIME_MS), DEFAULT_SERVER_LIFETIME_MS);
  assert.equal(normalizeServerLifetimeMs("60000"), 60_000);
  assert.equal(normalizeServerLifetimeMs("bad", DEFAULT_SERVER_LIFETIME_MS), DEFAULT_SERVER_LIFETIME_MS);
});

test("formatServerLifetime prints compact duration labels", () => {
  assert.equal(formatServerLifetime(12 * 60 * 60 * 1000), "12h");
  assert.equal(formatServerLifetime(30 * 60 * 1000), "30m");
  assert.equal(formatServerLifetime(45 * 1000), "45s");
  assert.equal(formatServerLifetime(750), "750ms");
});
