import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClaudeInstallFlow,
  describeClaudeInstallProgress,
} from "../onboardingHelpers.js";

type ProgressEvent =
  | { stage: "downloading"; receivedBytes?: number; totalBytes?: number }
  | { stage: "running" }
  | { stage: "verifying" }
  | { stage: "done"; version: string; binaryPath: string }
  | { stage: "error"; message: string };

interface InstalledClaude {
  version: string;
  binaryPath: string;
}

/**
 * Helper: build a mock pair of {runInstall, subscribe} that fires the
 * canned `events` sequence on the next event-loop tick, then resolves
 * the install promise with `result` (or rejects with `error`).
 */
function buildMockTransport(opts: {
  events: ProgressEvent[];
  result?: InstalledClaude;
  error?: unknown;
}) {
  let handler: ((event: ProgressEvent) => void) | null = null;
  let installResolve: ((value: InstalledClaude) => void) | null = null;
  let installReject: ((err: unknown) => void) | null = null;

  const subscribe = (cb: (event: ProgressEvent) => void) => {
    handler = cb;
    return () => {
      handler = null;
    };
  };

  const runInstall = (): Promise<InstalledClaude> =>
    new Promise<InstalledClaude>((resolve, reject) => {
      installResolve = resolve;
      installReject = reject;
    });

  async function drive(): Promise<void> {
    // Let `start()` register the listener before we fire events.
    await new Promise<void>((r) => setImmediate(r));
    for (const event of opts.events) {
      if (handler) {
        handler(event);
      }
      // Spin the loop so onChange propagates before the next event.
      await new Promise<void>((r) => setImmediate(r));
    }
    if (opts.error !== undefined) {
      installReject?.(opts.error);
    } else if (opts.result) {
      installResolve?.(opts.result);
    } else {
      installResolve?.({ version: "", binaryPath: "" });
    }
    // Final tick to settle the post-promise state transitions.
    await new Promise<void>((r) => setImmediate(r));
  }

  return { subscribe, runInstall, drive };
}

test("describeClaudeInstallProgress labels each stage", () => {
  assert.equal(
    describeClaudeInstallProgress({ stage: "downloading" }),
    "Downloading Claude Code…",
  );
  assert.equal(describeClaudeInstallProgress({ stage: "running" }), "Installing…");
  assert.equal(
    describeClaudeInstallProgress({ stage: "verifying" }),
    "Verifying install…",
  );
  assert.equal(
    describeClaudeInstallProgress({ stage: "done", version: "1.0", binaryPath: "/x" }),
    "Installed",
  );
  assert.equal(
    describeClaudeInstallProgress({ stage: "error", message: "boom" }),
    "boom",
  );
  assert.equal(describeClaudeInstallProgress(undefined), "Working…");
});

test("buildClaudeInstallFlow walks idle → installing → done, then calls onComplete once", async () => {
  const events: ProgressEvent[] = [
    { stage: "downloading", receivedBytes: 0, totalBytes: 6_000 },
    { stage: "running" },
    { stage: "verifying" },
    { stage: "done", version: "2.1.153", binaryPath: "/home/user/.local/bin/claude" },
  ];
  const mock = buildMockTransport({
    events,
    result: { version: "2.1.153", binaryPath: "/home/user/.local/bin/claude" },
  });

  const transitions: string[] = [];
  let completedWith: InstalledClaude | null = null;
  const flow = buildClaudeInstallFlow({
    runInstall: mock.runInstall,
    subscribe: mock.subscribe,
    onComplete: (result) => {
      completedWith = result as InstalledClaude;
    },
    onChange: ({ state }) => {
      if (transitions[transitions.length - 1] !== state) {
        transitions.push(state);
      }
    },
  });

  // Kick off the install + drive the canned event stream in parallel.
  const startPromise = flow.start();
  await mock.drive();
  await startPromise;

  assert.deepEqual(transitions, ["installing", "done"]);
  assert.equal(flow.state, "done");
  assert.equal(flow.progress?.stage, "done");
  assert.deepEqual(completedWith, {
    version: "2.1.153",
    binaryPath: "/home/user/.local/bin/claude",
  });
});

test("buildClaudeInstallFlow start() is idempotent", async () => {
  const mock = buildMockTransport({
    events: [{ stage: "done", version: "1.0.0", binaryPath: "/bin/claude" }],
    result: { version: "1.0.0", binaryPath: "/bin/claude" },
  });
  let completes = 0;
  const flow = buildClaudeInstallFlow({
    runInstall: mock.runInstall,
    subscribe: mock.subscribe,
    onComplete: () => {
      completes += 1;
    },
    onChange: () => {},
  });

  const first = flow.start();
  // Second start() before the first settles must be a no-op.
  await flow.start();
  await mock.drive();
  await first;

  assert.equal(completes, 1, "onComplete fires exactly once");
});

test("buildClaudeInstallFlow halts on an error event and does NOT call onComplete", async () => {
  const events: ProgressEvent[] = [
    { stage: "downloading" },
    { stage: "running" },
    { stage: "error", message: "shasum mismatch" },
  ];
  const mock = buildMockTransport({
    events,
    error: { code: "INSTALL_FAILED", message: "shasum mismatch" },
  });

  const transitions: string[] = [];
  let completed = false;
  const flow = buildClaudeInstallFlow({
    runInstall: mock.runInstall,
    subscribe: mock.subscribe,
    onComplete: () => {
      completed = true;
    },
    onChange: ({ state }) => {
      if (transitions[transitions.length - 1] !== state) {
        transitions.push(state);
      }
    },
  });

  const startPromise = flow.start();
  await mock.drive();
  await startPromise;

  assert.deepEqual(transitions, ["installing", "error"]);
  assert.equal(flow.state, "error");
  assert.equal(completed, false, "onComplete must not fire on the error path");
  assert.equal(flow.progress?.stage, "error");
});

test("buildClaudeInstallFlow surfaces a rejection even if no error event arrives", async () => {
  // Some failure modes (e.g., subprocess spawn failure) reject the
  // promise without first emitting an `error` event. The flow must
  // still settle into "error" state.
  const mock = buildMockTransport({
    events: [],
    error: { code: "INSTALL_FAILED", message: "could not spawn sh" },
  });

  const transitions: string[] = [];
  let completed = false;
  const flow = buildClaudeInstallFlow({
    runInstall: mock.runInstall,
    subscribe: mock.subscribe,
    onComplete: () => {
      completed = true;
    },
    onChange: ({ state }) => {
      if (transitions[transitions.length - 1] !== state) {
        transitions.push(state);
      }
    },
  });

  const startPromise = flow.start();
  await mock.drive();
  await startPromise;

  assert.deepEqual(transitions, ["installing", "error"]);
  assert.equal(completed, false);
  assert.equal(flow.progress?.stage, "error");
  assert.equal(
    (flow.progress as { stage: "error"; message: string } | null)?.message,
    "could not spawn sh",
  );
});
