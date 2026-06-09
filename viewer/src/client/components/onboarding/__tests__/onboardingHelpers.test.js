import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClaudeLoginFlow,
  describeClaudeLoginProgress,
  describeSlicerInstallProgress,
  evaluateAuthCheck,
  evaluateClaudeCheck,
  evaluateSlicerCheck,
  installErrorHint,
  isOnboardingComplete,
  nextOnboardingStep,
  ONBOARDING_STEPS,
  previousOnboardingStep,
} from "../onboardingHelpers.js";

test("installErrorHint guides network/download failures toward proxy/TLS", () => {
  assert.match(
    installErrorHint("Failed to download binary: The remote name could not be resolved"),
    /internet|proxy|firewall|network/i
  );
  assert.match(installErrorHint("Failed to get manifest: timed out"), /internet|proxy|firewall|network/i);
  assert.match(installErrorHint("Failed to get latest version: 403"), /internet|proxy|firewall|network/i);
});

test("installErrorHint guides checksum failures toward antivirus/proxy", () => {
  assert.match(installErrorHint("Checksum verification failed"), /antivirus|proxy/i);
});

test("installErrorHint guides install sub-step failures toward antivirus", () => {
  assert.match(installErrorHint("Installation failed (exit code 1)"), /antivirus|allow/i);
});

test("installErrorHint returns null for unknown or empty errors", () => {
  assert.equal(installErrorHint("some unexpected error"), null);
  assert.equal(installErrorHint(""), null);
  assert.equal(installErrorHint(null), null);
  assert.equal(installErrorHint(undefined), null);
});

test("ONBOARDING_STEPS exposes the six-step machine with sign-in and slicer", () => {
  assert.deepEqual(ONBOARDING_STEPS, [
    "claude",
    "login",
    "orca",
    "printer",
    "filament",
    "done",
  ]);
});

test("nextOnboardingStep advances through sign-in and slicer and clamps at done", () => {
  assert.equal(nextOnboardingStep("claude"), "login");
  assert.equal(nextOnboardingStep("login"), "orca");
  assert.equal(nextOnboardingStep("orca"), "printer");
  assert.equal(nextOnboardingStep("printer"), "filament");
  assert.equal(nextOnboardingStep("filament"), "done");
  assert.equal(nextOnboardingStep("done"), "done");
});

test("nextOnboardingStep maps unknown labels back to the first step", () => {
  assert.equal(nextOnboardingStep("garbage"), "claude");
});

test("previousOnboardingStep clamps at the first step", () => {
  assert.equal(previousOnboardingStep("login"), "claude");
  assert.equal(previousOnboardingStep("orca"), "login");
  assert.equal(previousOnboardingStep("printer"), "orca");
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

test("evaluateAuthCheck proceeds when authenticated is true", () => {
  assert.deepEqual(
    evaluateAuthCheck({ authenticated: true, source: "oauth_token" }),
    { proceed: true, source: "oauth_token" },
  );
});

test("evaluateAuthCheck reports missing when not authenticated", () => {
  assert.deepEqual(evaluateAuthCheck({ authenticated: false }), {
    proceed: false,
    reason: "claude_not_authenticated",
  });
  assert.deepEqual(evaluateAuthCheck(undefined), {
    proceed: false,
    reason: "claude_not_authenticated",
  });
});

test("describeClaudeLoginProgress maps each stage to a label", () => {
  assert.equal(describeClaudeLoginProgress({ stage: "starting" }), "Starting sign-in…");
  assert.equal(
    describeClaudeLoginProgress({ stage: "awaiting_browser", url: "https://x" }),
    "Waiting for you to approve in your browser…",
  );
  assert.equal(describeClaudeLoginProgress({ stage: "done" }), "Signed in");
  assert.equal(describeClaudeLoginProgress({ stage: "error", message: "boom" }), "boom");
  assert.equal(describeClaudeLoginProgress(null), "Working…");
  assert.equal(describeClaudeLoginProgress({ stage: "weird" }), "Working…");
});

test("buildClaudeLoginFlow reaches done and fires onComplete on success", async () => {
  const changes = [];
  let completed = null;
  let unsubscribed = false;
  const flow = buildClaudeLoginFlow({
    runLogin: () => Promise.resolve({ authenticated: true, source: "oauth_token" }),
    subscribe: (handler) => {
      handler({ stage: "awaiting_browser", url: "https://claude.ai/oauth" });
      return () => {
        unsubscribed = true;
      };
    },
    onComplete: (result) => {
      completed = result;
    },
    onChange: (snapshot) => changes.push(snapshot),
  });
  await flow.start();
  assert.equal(flow.state, "done");
  assert.deepEqual(completed, { authenticated: true, source: "oauth_token" });
  assert.ok(unsubscribed, "listener cleaned up");
  assert.ok(
    changes.some((c) => c.progress && c.progress.stage === "awaiting_browser"),
    "awaiting_browser progress surfaced",
  );
});

test("buildClaudeLoginFlow goes to error when runLogin rejects", async () => {
  let completed = false;
  const flow = buildClaudeLoginFlow({
    runLogin: () => Promise.reject({ message: "no token" }),
    subscribe: () => () => {},
    onComplete: () => {
      completed = true;
    },
    onChange: () => {},
  });
  await flow.start();
  assert.equal(flow.state, "error");
  assert.equal(flow.progress.stage, "error");
  assert.equal(flow.progress.message, "no token");
  assert.equal(completed, false, "onComplete not called on failure");
});

test("buildClaudeLoginFlow treats a non-authenticated resolve as failure", async () => {
  const flow = buildClaudeLoginFlow({
    runLogin: () => Promise.resolve({ authenticated: false }),
    subscribe: () => () => {},
    onComplete: () => {},
    onChange: () => {},
  });
  await flow.start();
  assert.equal(flow.state, "error");
});

test("evaluateSlicerCheck proceeds when slicer.found is true", () => {
  const result = evaluateSlicerCheck({
    slicer: { found: true, binaryPath: "/Applications/OrcaSlicer.app" },
  });
  assert.deepEqual(result, {
    proceed: true,
    binaryPath: "/Applications/OrcaSlicer.app",
  });
});

test("evaluateSlicerCheck reports missing when found is false", () => {
  assert.deepEqual(evaluateSlicerCheck({ slicer: { found: false, binaryPath: "" } }), {
    proceed: false,
    reason: "slicer_missing",
  });
});

test("evaluateSlicerCheck guards against missing payloads", () => {
  assert.deepEqual(evaluateSlicerCheck(undefined), {
    proceed: false,
    reason: "slicer_missing",
  });
});

test("describeSlicerInstallProgress labels each stage", () => {
  assert.equal(
    describeSlicerInstallProgress({ stage: "downloading" }),
    "Downloading OrcaSlicer…",
  );
  assert.equal(
    describeSlicerInstallProgress({ stage: "extracting" }),
    "Preparing installer…",
  );
  assert.equal(
    describeSlicerInstallProgress({ stage: "installing" }),
    "Installing OrcaSlicer…",
  );
  assert.equal(
    describeSlicerInstallProgress({ stage: "verifying" }),
    "Verifying install…",
  );
  assert.equal(
    describeSlicerInstallProgress({ stage: "done", version: "v2.3.2", binaryPath: "/x" }),
    "Installed",
  );
  assert.equal(
    describeSlicerInstallProgress({ stage: "error", message: "boom" }),
    "boom",
  );
  assert.equal(describeSlicerInstallProgress(undefined), "Working…");
});
