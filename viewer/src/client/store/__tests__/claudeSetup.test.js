// Tests for the Claude Code readiness gate: no inference attempt may reach the
// backend without a working `claude` CLI. When it's missing, the gate opens the
// setup dialog, auto-runs the in-app installer, and resumes the parked send on
// success. Uses fake transports throughout — no Tauri, no network.

import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureClaudeReady,
  dismissClaudeSetup,
  getClaudeSetupState,
  isClaudeMissingError,
  openClaudeSetup,
  recheckClaude,
  resetClaudeSetupStore,
  retryClaudeInstall,
} from "../claudeSetup.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// isClaudeMissingError — detection of the driver's CLAUDE_NOT_INSTALLED errors
// ---------------------------------------------------------------------------

test("isClaudeMissingError matches the chat driver's not-found message", () => {
  assert.equal(
    isClaudeMissingError(
      "`claude` CLI not found. Install Claude Code (https://claude.ai/install).",
    ),
    true,
  );
});

test("isClaudeMissingError matches the DriverError display form", () => {
  assert.equal(isClaudeMissingError("claude CLI not found on PATH"), true);
});

test("isClaudeMissingError ignores unrelated errors", () => {
  assert.equal(isClaudeMissingError("cancelled"), false);
  assert.equal(isClaudeMissingError("A paid subscription is required"), false);
  assert.equal(isClaudeMissingError(""), false);
  assert.equal(isClaudeMissingError(null), false);
});

// ---------------------------------------------------------------------------
// ensureClaudeReady — the pre-inference gate
// ---------------------------------------------------------------------------

test("gate passes when the CLI is detected, and caches the positive result", async (t) => {
  t.after(resetClaudeSetupStore);
  resetClaudeSetupStore();
  let checks = 0;
  const transport = {
    async app_prereq_check() {
      checks += 1;
      return { claudeCli: { found: true, version: "2.1.0" } };
    },
  };
  assert.equal(await ensureClaudeReady(transport), true);
  assert.equal(await ensureClaudeReady(transport), true);
  assert.equal(checks, 1, "positive detection is cached — no re-probe per send");
  assert.equal(getClaudeSetupState().open, false);
});

test("gate fails open when the prereq check is unavailable or throws", async (t) => {
  t.after(resetClaudeSetupStore);
  resetClaudeSetupStore();
  assert.equal(await ensureClaudeReady({}), true, "no prereq method → let the driver report");
  resetClaudeSetupStore();
  const throwing = {
    async app_prereq_check() {
      throw new Error("dev route missing");
    },
  };
  assert.equal(await ensureClaudeReady(throwing), true, "check failure → fail open");
  assert.equal(getClaudeSetupState().open, false);
});

test("missing CLI opens the dialog, auto-installs, then resumes the parked send", async (t) => {
  t.after(resetClaudeSetupStore);
  resetClaudeSetupStore();
  let resolveInstall;
  let progressHandler = null;
  let installCalls = 0;
  const transport = {
    async app_prereq_check() {
      return { claudeCli: { found: false } };
    },
    app_install_claude_code() {
      installCalls += 1;
      return new Promise((resolve) => {
        resolveInstall = resolve;
      });
    },
    onClaudeInstallProgress(handler) {
      progressHandler = handler;
      return () => {};
    },
  };

  const gate = ensureClaudeReady(transport);
  await tick();

  let state = getClaudeSetupState();
  assert.equal(state.open, true, "dialog opens");
  assert.equal(state.phase, "installing", "install starts without user action");
  assert.equal(state.hasPendingSend, true);
  assert.equal(installCalls, 1);

  progressHandler?.({ stage: "downloading" });
  assert.equal(getClaudeSetupState().progress?.stage, "downloading");

  resolveInstall({ version: "2.1.0", binaryPath: "/home/u/.local/bin/claude" });
  assert.equal(await gate, true, "parked send resumes after install");

  state = getClaudeSetupState();
  assert.equal(state.open, false, "dialog closes on success");
  assert.equal(state.cliReady, true);

  // Later sends skip straight through without re-checking.
  assert.equal(await ensureClaudeReady({}), true);
});

test("install failure keeps the dialog open with the error; dismiss drops the send", async (t) => {
  t.after(resetClaudeSetupStore);
  resetClaudeSetupStore();
  const transport = {
    async app_prereq_check() {
      return { claudeCli: { found: false } };
    },
    app_install_claude_code() {
      return Promise.reject(new Error("Failed to download manifest"));
    },
    onClaudeInstallProgress() {
      return () => {};
    },
  };

  const gate = ensureClaudeReady(transport);
  await tick();

  const state = getClaudeSetupState();
  assert.equal(state.open, true, "dialog stays open so the user can act");
  assert.equal(state.phase, "error");
  assert.match(state.errorMessage, /Failed to download manifest/);

  dismissClaudeSetup();
  assert.equal(await gate, false, "dismissing resolves the parked send as blocked");
  assert.equal(getClaudeSetupState().open, false);
});

test("a newer send supersedes an older parked one", async (t) => {
  t.after(resetClaudeSetupStore);
  resetClaudeSetupStore();
  let resolveInstall;
  const transport = {
    async app_prereq_check() {
      return { claudeCli: { found: false } };
    },
    app_install_claude_code() {
      return new Promise((resolve) => {
        resolveInstall = resolve;
      });
    },
    onClaudeInstallProgress() {
      return () => {};
    },
  };

  const first = ensureClaudeReady(transport);
  await tick();
  const second = ensureClaudeReady(transport);
  await tick();

  assert.equal(await first, false, "older send is dropped, not double-fired");
  resolveInstall({ version: "2.1.0", binaryPath: "/x" });
  assert.equal(await second, true, "only the latest send fires after install");
});

test("retry after a failed install runs the installer again", async (t) => {
  t.after(resetClaudeSetupStore);
  resetClaudeSetupStore();
  let installCalls = 0;
  let resolveInstall;
  const transport = {
    async app_prereq_check() {
      return { claudeCli: { found: false } };
    },
    app_install_claude_code() {
      installCalls += 1;
      if (installCalls === 1) return Promise.reject(new Error("checksum mismatch"));
      return new Promise((resolve) => {
        resolveInstall = resolve;
      });
    },
    onClaudeInstallProgress() {
      return () => {};
    },
  };

  const gate = ensureClaudeReady(transport);
  await tick();
  assert.equal(getClaudeSetupState().phase, "error");

  retryClaudeInstall(transport);
  await tick();
  assert.equal(getClaudeSetupState().phase, "installing");
  assert.equal(installCalls, 2);

  resolveInstall({ version: "2.1.0", binaryPath: "/x" });
  assert.equal(await gate, true, "the parked send survives a retry");
});

test("re-check picks up a manual install and resumes the parked send", async (t) => {
  t.after(resetClaudeSetupStore);
  resetClaudeSetupStore();
  let found = false;
  const transport = {
    async app_prereq_check() {
      return { claudeCli: { found } };
    },
    app_install_claude_code() {
      return Promise.reject(new Error("network blocked"));
    },
    onClaudeInstallProgress() {
      return () => {};
    },
  };

  const gate = ensureClaudeReady(transport);
  await tick();
  assert.equal(getClaudeSetupState().phase, "error");

  // Not installed yet → stays open with guidance.
  await recheckClaude(transport);
  let state = getClaudeSetupState();
  assert.equal(state.open, true);
  assert.match(state.errorMessage, /wasn.t detected/i);

  // The user ran the terminal install themselves → re-check passes.
  found = true;
  await recheckClaude(transport);
  assert.equal(await gate, true);
  state = getClaudeSetupState();
  assert.equal(state.open, false);
  assert.equal(state.cliReady, true);
});

test("openClaudeSetup from a chat error installs without a parked send", async (t) => {
  t.after(resetClaudeSetupStore);
  resetClaudeSetupStore();
  let resolveInstall;
  const transport = {
    app_install_claude_code() {
      return new Promise((resolve) => {
        resolveInstall = resolve;
      });
    },
    onClaudeInstallProgress() {
      return () => {};
    },
  };

  openClaudeSetup(transport);
  await tick();
  let state = getClaudeSetupState();
  assert.equal(state.open, true);
  assert.equal(state.phase, "installing");
  assert.equal(state.hasPendingSend, false);

  resolveInstall({ version: "2.1.0", binaryPath: "/x" });
  await tick();
  state = getClaudeSetupState();
  assert.equal(state.open, false);
  assert.equal(state.cliReady, true);
});

test("openClaudeSetup is a no-op while an install is already running", async (t) => {
  t.after(resetClaudeSetupStore);
  resetClaudeSetupStore();
  let installCalls = 0;
  const transport = {
    app_install_claude_code() {
      installCalls += 1;
      return new Promise(() => {});
    },
    onClaudeInstallProgress() {
      return () => {};
    },
  };

  openClaudeSetup(transport);
  await tick();
  openClaudeSetup(transport);
  await tick();
  assert.equal(installCalls, 1, "no duplicate installer subprocesses");
});
