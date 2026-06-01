import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClaudeCheckLoop,
  handlePrinterSkip,
  nextOnboardingStep,
  ONBOARDING_STEPS,
} from "../onboardingHelpers.js";

function createStepMachine() {
  let step = ONBOARDING_STEPS[0];
  return {
    get step() {
      return step;
    },
    advance() {
      step = nextOnboardingStep(step);
    },
  };
}

test("OnboardingWizard state machine advances claude → printer → filament → done", () => {
  const machine = createStepMachine();
  assert.equal(machine.step, "claude");
  machine.advance();
  assert.equal(machine.step, "printer");
  machine.advance();
  assert.equal(machine.step, "filament");
  machine.advance();
  assert.equal(machine.step, "done");
  // Idempotent at the end.
  machine.advance();
  assert.equal(machine.step, "done");
});

test("ClaudeCheckStep re-polls on the Continue once installed action", async () => {
  let attempt = 0;
  const probes = [];
  const scheduler = (cb) => {
    probes.push(cb);
    return probes.length;
  };
  const clear = () => {};

  const loop = buildClaudeCheckLoop({
    runCheck: () => {
      attempt += 1;
      // First poll says missing, second says found.
      return Promise.resolve({
        claudeCli: { found: attempt >= 2, version: attempt >= 2 ? "1.0.0" : undefined },
      });
    },
    onAdvance: () => {
      onAdvanceCount += 1;
    },
    intervalMs: 5000,
    scheduler,
    clear,
  });
  let onAdvanceCount = 0;

  // Initial tick is kicked off synchronously inside buildClaudeCheckLoop;
  // wait for it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(attempt, 1, "initial probe ran");
  assert.equal(loop.pollCount, 1);

  // Manually trigger the recheck (the "Continue once installed" button).
  loop.recheck();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(attempt, 2, "recheck() forces another probe");
  assert.equal(onAdvanceCount, 1, "wizard advances once CLI is found");

  // Subsequent rechecks are no-ops because we already advanced.
  loop.recheck();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(onAdvanceCount, 1);

  loop.cancel();
});

test("ClaudeCheckStep schedules the 5s poll when the CLI is still missing", async () => {
  const scheduled = [];
  let onAdvanceCount = 0;
  const loop = buildClaudeCheckLoop({
    runCheck: () => Promise.resolve({ claudeCli: { found: false } }),
    onAdvance: () => {
      onAdvanceCount += 1;
    },
    intervalMs: 5000,
    scheduler: (cb, ms) => {
      scheduled.push({ ms });
      return scheduled.length;
    },
    clear: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(scheduled.length, 1, "one poll queued");
  assert.equal(scheduled[0].ms, 5000);
  assert.equal(onAdvanceCount, 0);
  loop.cancel();
});

test("PrinterStep skip path advances the wizard immediately", () => {
  let advanced = 0;
  const result = handlePrinterSkip({
    onAdvance: () => {
      advanced += 1;
    },
  });
  assert.equal(result, true);
  assert.equal(advanced, 1);
});
