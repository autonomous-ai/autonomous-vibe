import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOnboardedSettings,
  describeClaudeLoginProgress,
  describeSocialLoginProgress,
  evaluateWelcomeState,
  shouldOnboard,
} from "../onboardingHelpers.js";

test("shouldOnboard gates only on hasOnboarded", () => {
  // Fresh / never-onboarded → show the wizard.
  assert.equal(shouldOnboard(null), true);
  assert.equal(shouldOnboard({}), true);
  assert.equal(shouldOnboard({ hasOnboarded: false }), true);
  // Onboarded with their own Claude Code → into the app.
  assert.equal(shouldOnboard({ hasOnboarded: true }), false);
  assert.equal(
    shouldOnboard({ hasOnboarded: true, claudeOauthToken: "oauth-x" }),
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

test("describeSocialLoginProgress labels each stage", () => {
  assert.equal(describeSocialLoginProgress({ stage: "starting" }), "Starting Vibe sign-in…");
  assert.equal(
    describeSocialLoginProgress({ stage: "awaiting_browser", url: "https://x" }),
    "Waiting for you to finish sign-in in your browser…",
  );
  assert.equal(describeSocialLoginProgress({ stage: "verifying" }), "Finishing Vibe sign-in…");
  assert.equal(describeSocialLoginProgress({ stage: "done" }), "Signed in");
  assert.equal(describeSocialLoginProgress({ stage: "error", message: "nope" }), "nope");
  assert.equal(describeSocialLoginProgress(undefined), "Working…");
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
  assert.equal(ready.pandaSignedIn, false);
  assert.equal(ready.canContinue, true);
  assert.equal(ready.ownBlockedReason, "");
});

test("evaluateWelcomeState allows continue when Panda account is signed in", () => {
  const state = evaluateWelcomeState({
    check: { claudeCli: { found: false } },
    auth: { authenticated: false },
    user: { id: "u_123", username: "panda-user" },
  });
  assert.equal(state.canUseOwn, false);
  assert.equal(state.pandaSignedIn, true);
  assert.equal(state.canContinue, true);
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

test("buildOnboardedSettings forces hasOnboarded and preserves existing settings", () => {
  const next = buildOnboardedSettings({
    defaultFilament: "PETG",
    slicerBinaryPath: "/orca",
    autoUpdate: true,
  });
  assert.equal(next.hasOnboarded, true);
  // Preserves the rest of the existing settings.
  assert.equal(next.defaultFilament, "PETG");
  assert.equal(next.slicerBinaryPath, "/orca");
  assert.equal(next.autoUpdate, true);
});

test("buildOnboardedSettings preserves the local Claude OAuth token", () => {
  const next = buildOnboardedSettings({ claudeOauthToken: "oauth-abc" });
  assert.equal(next.hasOnboarded, true);
  assert.equal(next.claudeOauthToken, "oauth-abc");
});

test("buildOnboardedSettings defaults a fresh profile", () => {
  const next = buildOnboardedSettings(null);
  assert.equal(next.hasOnboarded, true);
  assert.equal(next.defaultFilament, "PLA");
  assert.equal(next.slicerBinaryPath, "");
  assert.equal(next.autoUpdate, false);
});
