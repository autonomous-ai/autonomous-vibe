// Pure helpers for the onboarding wizard. Kept JSX/dep-free so Node's
// --test runner can exercise the state machine and re-poll logic.

export const ONBOARDING_STEPS = Object.freeze([
  "claude",
  "login",
  "printer",
  "filament",
  "done",
]);

export const FILAMENT_CHOICES = Object.freeze([
  { value: "PLA", label: "PLA", helper: "Easy to print, great for most parts. Recommended for beginners." },
  { value: "PETG", label: "PETG", helper: "Tougher and slightly heat-resistant. Good for outdoor or load-bearing parts." },
  { value: "TPU", label: "TPU", helper: "Flexible rubber-like prints. Use only if your printer supports it." },
]);

const STEP_ORDER = ONBOARDING_STEPS;

export function nextOnboardingStep(current) {
  const index = STEP_ORDER.indexOf(current);
  if (index < 0) {
    return STEP_ORDER[0];
  }
  return STEP_ORDER[Math.min(index + 1, STEP_ORDER.length - 1)];
}

export function previousOnboardingStep(current) {
  const index = STEP_ORDER.indexOf(current);
  if (index <= 0) {
    return STEP_ORDER[0];
  }
  return STEP_ORDER[index - 1];
}

export function isOnboardingComplete(step) {
  return step === "done";
}

/**
 * Compute the next-step decision after a prereq check. Returns
 * `{ proceed: true }` once the Claude CLI is found; otherwise reports back
 * the missing reason so the UI can render the install card.
 */
export function evaluateClaudeCheck(check) {
  const found = Boolean(check?.claudeCli?.found);
  if (found) {
    return { proceed: true, version: String(check?.claudeCli?.version || "") };
  }
  return { proceed: false, reason: "claude_cli_missing" };
}

/**
 * Compute the next-step decision after an auth check. Returns
 * `{ proceed: true }` once Claude Code is authenticated; otherwise reports
 * back so the UI can render the sign-in card.
 */
export function evaluateAuthCheck(status) {
  const authenticated = Boolean(status?.authenticated);
  if (authenticated) {
    return { proceed: true, source: status?.source ? String(status.source) : "" };
  }
  return { proceed: false, reason: "claude_not_authenticated" };
}

/**
 * Drive the Claude-check polling loop. Returns the timer id so callers can
 * cancel. Pulled out so it can be unit-tested with a fake timer.
 */
export function schedulePoll(callback, intervalMs, scheduler = setTimeout) {
  return scheduler(callback, intervalMs);
}

export const CLAUDE_INSTALL_URL = "https://claude.ai/install";

export const CLAUDE_CHECK_POLL_INTERVAL_MS = 5000;

/**
 * Drive the Claude-check loop without React: caller passes a transport-like
 * `runCheck` and an `onAdvance` callback. Returns a `{ recheck, cancel }`
 * pair the test can drive. The loop polls at `intervalMs` until either
 * cancel() is called or `runCheck` resolves with `proceed: true`.
 */
export function buildClaudeCheckLoop({
  runCheck,
  onAdvance,
  intervalMs = CLAUDE_CHECK_POLL_INTERVAL_MS,
  scheduler = setTimeout,
  clear = clearTimeout,
}) {
  let cancelled = false;
  let timer = null;
  let advanced = false;
  let pollCount = 0;

  async function tick() {
    if (cancelled) return;
    pollCount += 1;
    const check = await runCheck();
    const result = evaluateClaudeCheck(check);
    if (cancelled) return;
    if (result.proceed && !advanced) {
      advanced = true;
      onAdvance?.();
      return;
    }
    if (!advanced && !cancelled) {
      timer = scheduler(tick, intervalMs);
    }
  }

  const recheck = () => {
    if (timer) {
      clear(timer);
      timer = null;
    }
    void tick();
  };

  const cancel = () => {
    cancelled = true;
    if (timer) {
      clear(timer);
      timer = null;
    }
  };

  // Kick off the initial probe.
  void tick();

  return {
    recheck,
    cancel,
    get pollCount() {
      return pollCount;
    },
  };
}

/**
 * Drive the printer step "skip" path. Returns whether the wizard should
 * advance. Mirrors the JSX-level handler so tests can assert behavior.
 */
export function handlePrinterSkip({ onAdvance }) {
  onAdvance?.();
  return true;
}

/**
 * Translate a `claude_install_progress` event into a short status label
 * suitable for the Install for me button + progress card. Returns one of:
 *   - "downloading" → "Downloading Claude Code…"
 *   - "running"     → "Installing…"
 *   - "verifying"   → "Verifying install…"
 *   - "done"        → "Installed"
 *   - "error"       → the event's message (so the UI can surface why)
 *
 * Defensive: unknown stages report a generic "Working…" rather than
 * throwing.
 */
export function describeClaudeInstallProgress(event) {
  if (!event || typeof event !== "object") {
    return "Working…";
  }
  switch (event.stage) {
    case "downloading":
      return "Downloading Claude Code…";
    case "running":
      return "Installing…";
    case "verifying":
      return "Verifying install…";
    case "done":
      return "Installed";
    case "error":
      return String(event.message || "Install failed");
    default:
      return "Working…";
  }
}

/**
 * Drive the auto-install flow without React. Caller wires three deps:
 *  - `runInstall`  → kicks off the install (returns a Promise resolving
 *    to an `InstalledClaude` on success, rejecting on failure)
 *  - `subscribe`   → registers a `claude_install_progress` listener and
 *    returns its unsubscribe function (matches `transport.onClaudeInstallProgress`)
 *  - `onComplete`  → invoked exactly once when the install finishes
 *    successfully (i.e., the `done` event is observed AND `runInstall`
 *    resolves). Never called on the error path.
 *
 * The flow's state machine is one of:
 *   "idle" → "installing" → "done"   (happy path)
 *   "idle" → "installing" → "error"  (any failure)
 *
 * Returns a `{ state, progress, start, cancel }` snapshot:
 *  - `start()` flips the state to "installing", fires `runInstall`, and
 *    settles into "done" or "error". Idempotent — subsequent calls while
 *    already installing/done are no-ops.
 *  - `cancel()` unsubscribes the listener and prevents further state
 *    transitions; the underlying install subprocess is NOT killed (the
 *    Rust side doesn't expose a cancel handle today).
 *
 * `onChange(snapshot)` fires on every state or progress update so a
 * React caller can re-render. The snapshot's `state` field is one of
 * "idle" | "installing" | "done" | "error"; `progress` is the most
 * recent `ClaudeInstallProgress` event or null.
 */
export function buildClaudeInstallFlow({
  runInstall,
  subscribe,
  onComplete,
  onChange,
}) {
  let state = "idle";
  let progress = null;
  let started = false;
  let cancelled = false;
  let unsubscribe = null;

  function emit() {
    onChange?.({ state, progress });
  }

  async function start() {
    if (started || cancelled) return;
    started = true;
    state = "installing";
    emit();

    // Subscribe before kicking off the install so we don't miss the
    // first event.
    if (typeof subscribe === "function") {
      try {
        const off = await subscribe((event) => {
          if (cancelled) return;
          progress = event;
          if (event?.stage === "error") {
            state = "error";
          }
          emit();
        });
        if (typeof off === "function") {
          unsubscribe = off;
        }
      } catch {
        // Subscription failures don't abort the install — the runInstall
        // promise still drives the terminal state.
      }
    }

    try {
      const result = await runInstall();
      if (cancelled) return;
      // If a prior error event flipped us to "error", honor it and
      // don't auto-advance.
      if (state === "error") {
        return;
      }
      state = "done";
      // Synthesize a final progress event if one wasn't streamed. Lets
      // the UI render "Installed" even when the backend forgot to emit
      // the done frame.
      if (!progress || progress.stage !== "done") {
        progress = {
          stage: "done",
          version: String(result?.version || ""),
          binaryPath: String(result?.binaryPath || ""),
        };
      }
      emit();
      onComplete?.(result);
    } catch (err) {
      if (cancelled) return;
      state = "error";
      const message =
        err && typeof err === "object" && "message" in err
          ? String(err.message || "Install failed")
          : String(err || "Install failed");
      progress = { stage: "error", message };
      emit();
    } finally {
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch {
          /* ignore */
        }
        unsubscribe = null;
      }
    }
  }

  function cancel() {
    cancelled = true;
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
      unsubscribe = null;
    }
  }

  return {
    start,
    cancel,
    get state() {
      return state;
    },
    get progress() {
      return progress;
    },
  };
}

/**
 * Translate a `claude_login_progress` event into a short status label for the
 * sign-in button + progress card. Defensive: unknown stages report a generic
 * "Working…" rather than throwing.
 */
export function describeClaudeLoginProgress(event) {
  if (!event || typeof event !== "object") {
    return "Working…";
  }
  switch (event.stage) {
    case "starting":
      return "Starting sign-in…";
    case "awaiting_browser":
      return "Waiting for you to approve in your browser…";
    case "verifying":
      return "Finishing sign-in…";
    case "done":
      return "Signed in";
    case "error":
      return String(event.message || "Sign-in failed");
    default:
      return "Working…";
  }
}

/**
 * Drive the sign-in flow without React. Mirrors `buildClaudeInstallFlow`:
 *  - `runLogin`   → kicks off `app_login_claude` (resolves to a
 *    `ClaudeAuthStatus` on success, rejects on failure)
 *  - `subscribe`  → registers a `claude_login_progress` listener and returns
 *    its unsubscribe function (matches `transport.onClaudeLoginProgress`)
 *  - `onComplete` → invoked once when sign-in succeeds (the promise resolves
 *    with `authenticated: true` and no prior error event)
 *  - `onChange`   → fires on every state/progress update for re-render
 *
 * State machine: "idle" → "signing_in" → "done" | "error".
 */
export function buildClaudeLoginFlow({ runLogin, subscribe, onComplete, onChange }) {
  let state = "idle";
  let progress = null;
  let started = false;
  let cancelled = false;
  let unsubscribe = null;

  function emit() {
    onChange?.({ state, progress });
  }

  async function start() {
    if (started || cancelled) return;
    started = true;
    state = "signing_in";
    emit();

    if (typeof subscribe === "function") {
      try {
        const off = await subscribe((event) => {
          if (cancelled) return;
          progress = event;
          if (event?.stage === "error") {
            state = "error";
          }
          emit();
        });
        if (typeof off === "function") {
          unsubscribe = off;
        }
      } catch {
        // Subscription failures don't abort sign-in — runLogin still drives
        // the terminal state.
      }
    }

    try {
      const result = await runLogin();
      if (cancelled) return;
      if (state === "error") return;
      // A resolved promise without `authenticated` is treated as failure.
      if (!result || result.authenticated !== true) {
        state = "error";
        progress = { stage: "error", message: "Sign-in did not complete" };
        emit();
        return;
      }
      state = "done";
      if (!progress || progress.stage !== "done") {
        progress = { stage: "done" };
      }
      emit();
      onComplete?.(result);
    } catch (err) {
      if (cancelled) return;
      state = "error";
      const message =
        err && typeof err === "object" && "message" in err
          ? String(err.message || "Sign-in failed")
          : String(err || "Sign-in failed");
      progress = { stage: "error", message };
      emit();
    } finally {
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch {
          /* ignore */
        }
        unsubscribe = null;
      }
    }
  }

  function cancel() {
    cancelled = true;
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
      unsubscribe = null;
    }
  }

  return {
    start,
    cancel,
    get state() {
      return state;
    },
    get progress() {
      return progress;
    },
  };
}
