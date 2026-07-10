import assert from "node:assert/strict";
import test from "node:test";

import {
  isUpgradeError,
  upgradeErrorMessage,
  splitUpgradeCta,
} from "../upgradeError.js";

test("isUpgradeError trips on the proxy subscription payload", () => {
  const message =
    'claude produced no response: {"error":"subscription_required","message":"A paid subscription is required to continue."}';
  assert.equal(isUpgradeError(message), true);
});

test("isUpgradeError trips on the CLI 402 error text", () => {
  const message =
    "API Error: 402 A paid subscription is required to use AI features. Subscribe to continue.";
  assert.equal(isUpgradeError(message), true);
});

test("splitUpgradeCta linkifies an existing CTA in place (no duplicate)", () => {
  const message =
    "API Error: 402 A paid subscription is required to use AI features. Subscribe to continue.";
  const { before, cta, after } = splitUpgradeCta(message);
  assert.equal(
    before,
    "API Error: 402 A paid subscription is required to use AI features. ",
  );
  assert.equal(cta, "Subscribe to continue");
  assert.equal(after, ".");
  // Reassembling the parts reproduces the message exactly — nothing duplicated.
  assert.equal(before + cta + after, message);
});

test("splitUpgradeCta appends a CTA when the message has none", () => {
  const { before, cta, after } = splitUpgradeCta("Insufficient credit.");
  assert.equal(before, "Insufficient credit. ");
  assert.equal(cta, "Subscribe to continue");
  assert.equal(after, "");
});

test("isUpgradeError trips on insufficient-credit wording", () => {
  assert.equal(isUpgradeError("Insufficient credit to run this request"), true);
  assert.equal(isUpgradeError("You are out of credit"), true);
  assert.equal(isUpgradeError("quota exceeded for this plan"), true);
});

test("isUpgradeError ignores ordinary errors and empties", () => {
  assert.equal(isUpgradeError("sandbox timeout"), false);
  assert.equal(isUpgradeError("cancelled"), false);
  assert.equal(isUpgradeError(""), false);
  assert.equal(isUpgradeError(null), false);
  assert.equal(isUpgradeError(undefined), false);
});

test("upgradeErrorMessage unwraps the JSON message field", () => {
  const message =
    'claude produced no response: {"error":"subscription_required","message":"A paid subscription is required to continue."}';
  assert.equal(
    upgradeErrorMessage(message),
    "A paid subscription is required to continue.",
  );
});

test("upgradeErrorMessage falls back to the raw string for non-JSON", () => {
  assert.equal(
    upgradeErrorMessage("  Insufficient credit  "),
    "Insufficient credit",
  );
});
