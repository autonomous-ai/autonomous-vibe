import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOnboardedSettings,
  buildPandaLoginFlow,
  describeClaudeLoginProgress,
  describePandaLoginProgress,
  evaluateWelcomeState,
  shouldOnboard,
} from "../onboardingHelpers.js";

test("shouldOnboard gates only on hasOnboarded (no Panda-token mandate)", () => {
  // Fresh / never-onboarded → show the wizard.
  assert.equal(shouldOnboard(null), true);
  assert.equal(shouldOnboard({}), true);
  assert.equal(shouldOnboard({ hasOnboarded: false }), true);
  // Onboarded with their own Claude Code (no Panda token) → into the app.
  // This is the key change: a local-only user is no longer forced back.
  assert.equal(shouldOnboard({ hasOnboarded: true }), false);
  assert.equal(
    shouldOnboard({ hasOnboarded: true, usePandaCloud: false }),
    false,
  );
  // Onboarded Panda user → into the app.
  assert.equal(
    shouldOnboard({ hasOnboarded: true, pandaToken: "ccr-x" }),
    false,
  );
});

test("describeClaudeLoginProgress labels each stage", () => {
  assert.equal(describeClaudeLoginProgress({ stage: "starting" }), "Starting sign-in…");
  assert.equal(
    describeClaudeLoginProgress({ stage: "awaiting_browser", url: "https://x" }),
    "Waiting for you to approve in your browser…",
  );
  assert.equal(describeClaudeLoginProgress({ stage: "verifying" }), "Finishing sign-in…");
  assert.equal(describeClaudeLoginProgress({ stage: "done" }), "Signed in");
  assert.equal(describeClaudeLoginProgress({ stage: "error", message: "nope" }), "nope");
  assert.equal(describeClaudeLoginProgress(undefined), "Working…");
});

test("evaluateWelcomeState gates 'use own' on CLI present AND authenticated", () => {
  const ready = evaluateWelcomeState({
    check: { claudeCli: { found: true, version: "2.1.0" } },
    auth: { authenticated: true, source: "oauth_token" },
  });
  assert.equal(ready.cliFound, true);
  assert.equal(ready.cliVersion, "2.1.0");
  assert.equal(ready.authed, true);
  assert.equal(ready.canUseOwn, true);
  assert.equal(ready.ownBlockedReason, "");
});

test("evaluateWelcomeState blocks 'use own' when installed but not signed in", () => {
  const state = evaluateWelcomeState({
    check: { claudeCli: { found: true, version: "2.1.0" } },
    auth: { authenticated: false },
  });
  assert.equal(state.canUseOwn, false);
  assert.equal(state.ownBlockedReason, "not_signed_in");
});

test("evaluateWelcomeState blocks 'use own' when the CLI is missing", () => {
  const state = evaluateWelcomeState({
    check: { claudeCli: { found: false } },
    auth: { authenticated: true, source: "oauth_token" },
  });
  assert.equal(state.cliFound, false);
  assert.equal(state.cliVersion, "");
  assert.equal(state.canUseOwn, false);
  assert.equal(state.ownBlockedReason, "not_installed");
});

test("evaluateWelcomeState tolerates missing inputs", () => {
  const state = evaluateWelcomeState();
  assert.equal(state.cliFound, false);
  assert.equal(state.authed, false);
  assert.equal(state.canUseOwn, false);
  assert.equal(state.ownBlockedReason, "not_installed");
});

test("describePandaLoginProgress labels each stage", () => {
  assert.equal(describePandaLoginProgress({ stage: "starting" }), "Starting sign-in…");
  assert.equal(
    describePandaLoginProgress({ stage: "awaiting_browser", url: "https://x" }),
    "Waiting for you to approve in your browser…",
  );
  assert.equal(describePandaLoginProgress({ stage: "verifying" }), "Finishing sign-in…");
  assert.equal(describePandaLoginProgress({ stage: "done" }), "Signed in");
  assert.equal(describePandaLoginProgress({ stage: "error", message: "nope" }), "nope");
  assert.equal(describePandaLoginProgress(undefined), "Working…");
});

test("buildOnboardedSettings forces hasOnboarded and applies the Panda choice", () => {
  const next = buildOnboardedSettings(
    { defaultFilament: "PETG", slicerBinaryPath: "/orca", autoUpdate: true },
    { usePandaCloud: true, pandaToken: "tok-123" },
  );
  assert.equal(next.hasOnboarded, true);
  assert.equal(next.usePandaCloud, true);
  assert.equal(next.pandaToken, "tok-123");
  // Preserves the rest of the existing settings.
  assert.equal(next.defaultFilament, "PETG");
  assert.equal(next.slicerBinaryPath, "/orca");
  assert.equal(next.autoUpdate, true);
});

test("buildOnboardedSettings applies the bring-your-own-Claude choice", () => {
  const next = buildOnboardedSettings(
    { usePandaCloud: true, pandaToken: "stale" },
    { usePandaCloud: false },
  );
  assert.equal(next.hasOnboarded, true);
  assert.equal(next.usePandaCloud, false);
  // pandaToken is left untouched (no override) — harmless when use_panda_cloud is off.
  assert.equal(next.pandaToken, "stale");
});

test("buildOnboardedSettings defaults a fresh profile", () => {
  const next = buildOnboardedSettings(null, { usePandaCloud: false });
  assert.equal(next.hasOnboarded, true);
  assert.equal(next.defaultFilament, "PLA");
  assert.equal(next.slicerBinaryPath, "");
  assert.equal(next.usePandaCloud, false);
  assert.equal(next.autoUpdate, false);
});

test("buildPandaLoginFlow resolves to done and reports success to onComplete", async () => {
  let handler = null;
  let resolveLogin = null;
  const subscribe = (cb) => {
    handler = cb;
    return () => {
      handler = null;
    };
  };
  const runLogin = () =>
    new Promise((resolve) => {
      resolveLogin = resolve;
    });

  const transitions = [];
  let completedWith = null;
  const flow = buildPandaLoginFlow({
    runInstall: runLogin,
    subscribe,
    onComplete: (result) => {
      completedWith = result;
    },
    onChange: ({ state }) => {
      if (transitions[transitions.length - 1] !== state) transitions.push(state);
    },
  });

  const started = flow.start();
  // Let start() register the listener, then drive the progress stream.
  await new Promise((r) => setImmediate(r));
  handler?.({ stage: "starting" });
  await new Promise((r) => setImmediate(r));
  handler?.({ stage: "verifying" });
  await new Promise((r) => setImmediate(r));
  // The real command returns only `{ ok: true }` — the proxy key never crosses
  // into JS.
  resolveLogin?.({ ok: true });
  await started;

  assert.deepEqual(transitions, ["installing", "done"]);
  assert.equal(flow.state, "done");
  assert.deepEqual(completedWith, { ok: true });
});
