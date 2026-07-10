import assert from "node:assert/strict";
import test from "node:test";

import {
  activePlanLabel,
  isPlanActive,
  planDisplayName,
} from "../subscription.js";

test("isPlanActive requires a plan and an active status", () => {
  assert.equal(isPlanActive({ plan: "pro", planStatus: "active" }), true);
  assert.equal(isPlanActive({ plan: "studio", planStatus: "trialing" }), true);
  assert.equal(isPlanActive({ plan: "pro", planStatus: "past_due" }), true);
  // No plan → not active even if status looks active.
  assert.equal(isPlanActive({ plan: "", planStatus: "active" }), false);
  // Canceled/unknown status → not active.
  assert.equal(isPlanActive({ plan: "pro", planStatus: "canceled" }), false);
  // Missing profile / fields.
  assert.equal(isPlanActive(null), false);
  assert.equal(isPlanActive({}), false);
});

test("planDisplayName capitalizes the plan key", () => {
  assert.equal(planDisplayName("pro"), "Pro");
  assert.equal(planDisplayName("studio"), "Studio");
  assert.equal(planDisplayName("free"), "Free");
  assert.equal(planDisplayName(""), "");
  assert.equal(planDisplayName(undefined), "");
});

test("activePlanLabel returns the capitalized label only when active", () => {
  assert.equal(activePlanLabel({ plan: "pro", planStatus: "active" }), "Pro");
  assert.equal(activePlanLabel({ plan: "pro", planStatus: "canceled" }), null);
  assert.equal(activePlanLabel(null), null);
});
