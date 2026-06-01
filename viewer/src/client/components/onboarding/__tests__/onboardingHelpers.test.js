import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateClaudeCheck,
  isOnboardingComplete,
  nextOnboardingStep,
  ONBOARDING_STEPS,
  previousOnboardingStep,
} from "../onboardingHelpers.js";

test("ONBOARDING_STEPS exposes the four-step machine", () => {
  assert.deepEqual(ONBOARDING_STEPS, ["claude", "printer", "filament", "done"]);
});

test("nextOnboardingStep advances and clamps at done", () => {
  assert.equal(nextOnboardingStep("claude"), "printer");
  assert.equal(nextOnboardingStep("printer"), "filament");
  assert.equal(nextOnboardingStep("filament"), "done");
  assert.equal(nextOnboardingStep("done"), "done");
});

test("nextOnboardingStep maps unknown labels back to the first step", () => {
  assert.equal(nextOnboardingStep("garbage"), "claude");
});

test("previousOnboardingStep clamps at the first step", () => {
  assert.equal(previousOnboardingStep("printer"), "claude");
  assert.equal(previousOnboardingStep("claude"), "claude");
});

test("isOnboardingComplete only reports done", () => {
  assert.equal(isOnboardingComplete("claude"), false);
  assert.equal(isOnboardingComplete("done"), true);
});

test("evaluateClaudeCheck proceeds when claudeCli.found is true", () => {
  const result = evaluateClaudeCheck({ claudeCli: { found: true, version: "1.2.3" } });
  assert.deepEqual(result, { proceed: true, version: "1.2.3" });
});

test("evaluateClaudeCheck reports missing when found is false", () => {
  const result = evaluateClaudeCheck({ claudeCli: { found: false } });
  assert.deepEqual(result, { proceed: false, reason: "claude_cli_missing" });
});

test("evaluateClaudeCheck guards against missing payloads", () => {
  assert.deepEqual(
    evaluateClaudeCheck(undefined),
    { proceed: false, reason: "claude_cli_missing" },
  );
});
