// Claude Code readiness gate for the chat.
//
// Every inference the app runs is a spawned `claude` CLI subprocess — even the
// signed-in Vibe Pro proxy models only redirect that CLI's API traffic (see
// `proxy_env` in claude_driver.rs). So before any turn reaches the backend, the
// CLI must exist on this machine. This store enforces that: `ensureClaudeReady`
// probes once per app run, and when the CLI is missing it opens the setup
// dialog, auto-runs the in-app installer (`app_install_claude_code`), and parks
// the send — resolving it `true` (send proceeds) once the install succeeds, or
// `false` (send dropped) if the user dismisses.
//
// Same "Zustand-style" external store shape as ./chat.js: a pure-ish reducer,
// module-level state, and a `useSyncExternalStore` hook. Flow mechanics reuse
// the already-tested `buildClaudeInstallFlow` from onboarding.

import { useSyncExternalStore } from "react";
import { getTransport } from "../lib/transport.ts";
import { buildClaudeInstallFlow } from "../components/onboarding/onboardingHelpers.js";

/**
 * @typedef {Object} ClaudeSetupState
 * @property {boolean} open the setup dialog is visible
 * @property {"installing"|"error"|"done"} phase
 * @property {object|null} progress last `claude_install_progress` event
 * @property {string} errorMessage distilled installer error (phase "error")
 * @property {boolean} cliReady positive detection cached for this app run
 * @property {boolean} hasPendingSend a chat send is parked awaiting the install
 */

/** @type {ClaudeSetupState} */
export const INITIAL_CLAUDE_SETUP_STATE = Object.freeze({
  open: false,
  phase: "installing",
  progress: null,
  errorMessage: "",
  cliReady: false,
  hasPendingSend: false,
});

/** True for the chat driver's CLAUDE_NOT_INSTALLED error messages — both the
 * user-facing "`claude` CLI not found. Install Claude Code (…)" chat event and
 * the raw DriverError display ("claude CLI not found on PATH"). */
export function isClaudeMissingError(message) {
  const text = String(message || "").toLowerCase();
  return text.includes("claude") && text.includes("cli not found");
}

export function claudeSetupReducer(state, action) {
  switch (action.type) {
    case "install_start":
      return {
        ...state,
        open: true,
        phase: "installing",
        progress: null,
        errorMessage: "",
        hasPendingSend: action.hasPendingSend ?? state.hasPendingSend,
      };
    case "install_progress":
      return { ...state, progress: action.progress };
    case "install_error":
      return { ...state, phase: "error", errorMessage: String(action.message || "Install failed") };
    case "install_done":
      return {
        ...state,
        open: false,
        phase: "done",
        cliReady: true,
        errorMessage: "",
        hasPendingSend: false,
      };
    case "cli_ready":
      return state.cliReady ? state : { ...state, cliReady: true };
    case "pending_send":
      return state.hasPendingSend === action.value
        ? state
        : { ...state, hasPendingSend: action.value };
    case "dismiss":
      return { ...state, open: false, hasPendingSend: false };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// External store
// ---------------------------------------------------------------------------

/** @type {ClaudeSetupState} */
let currentState = INITIAL_CLAUDE_SETUP_STATE;
const listeners = new Set();
// Resolver of the most recent parked send. Only one send may resume (firing two
// would trip "A turn is already in progress"), so a newer send supersedes an
// older one by resolving it `false`.
let pendingSendResolve = null;
// The in-flight install flow (buildClaudeInstallFlow instance), if any.
let activeFlow = null;

function setState(next) {
  if (next === currentState) return;
  currentState = next;
  for (const listener of listeners) listener();
}

function dispatch(action) {
  setState(claudeSetupReducer(currentState, action));
}

export function getClaudeSetupState() {
  return currentState;
}

export function subscribeClaudeSetup(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useClaudeSetupStore(selector = (state) => state) {
  return useSyncExternalStore(
    subscribeClaudeSetup,
    () => selector(currentState),
    () => selector(currentState),
  );
}

export function resetClaudeSetupStore() {
  if (activeFlow) {
    activeFlow.cancel();
    activeFlow = null;
  }
  if (pendingSendResolve) {
    pendingSendResolve(false);
    pendingSendResolve = null;
  }
  setState(INITIAL_CLAUDE_SETUP_STATE);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function settlePendingSend(ok) {
  const resolve = pendingSendResolve;
  pendingSendResolve = null;
  resolve?.(ok);
}

function handleInstallSucceeded() {
  activeFlow = null;
  dispatch({ type: "install_done" });
  settlePendingSend(true);
}

/** Kick off the in-app installer and mirror its progress into the store. */
function runInstall(transport) {
  if (activeFlow) return; // an install is already streaming — don't double-spawn
  const flow = buildClaudeInstallFlow({
    runInstall: () => transport.app_install_claude_code(),
    subscribe: (handler) =>
      typeof transport.onClaudeInstallProgress === "function"
        ? transport.onClaudeInstallProgress(handler)
        : () => {},
    onChange: ({ state, progress }) => {
      if (progress) dispatch({ type: "install_progress", progress });
      if (state === "error") {
        activeFlow = null;
        dispatch({
          type: "install_error",
          message: progress?.stage === "error" ? progress.message : "Install failed",
        });
      }
    },
    onComplete: handleInstallSucceeded,
  });
  activeFlow = flow;
  void flow.start();
}

/**
 * Open the setup dialog and start installing. Safe to call repeatedly (e.g.
 * from every CLAUDE_NOT_INSTALLED chat error): a running install is never
 * duplicated, and an errored dialog restarts the install.
 */
export function openClaudeSetup(transport = getTransport()) {
  if (currentState.cliReady) return;
  if (activeFlow) {
    // Already installing — just make sure the dialog is visible.
    if (!currentState.open) dispatch({ type: "install_start" });
    return;
  }
  dispatch({ type: "install_start" });
  runInstall(transport);
}

/** Retry after a failed install (the flow instance is one-shot). */
export function retryClaudeInstall(transport = getTransport()) {
  if (activeFlow) return;
  dispatch({ type: "install_start" });
  runInstall(transport);
}

/**
 * Close the dialog. Any parked send is dropped (resolved `false`) — the user's
 * text stays in the composer, so nothing is lost. A Rust-side install that's
 * already running continues harmlessly; a later send just re-probes.
 */
export function dismissClaudeSetup() {
  if (activeFlow) {
    activeFlow.cancel();
    activeFlow = null;
  }
  settlePendingSend(false);
  dispatch({ type: "dismiss" });
}

/**
 * Re-probe for a manual install ("I installed it myself"). Passes → same as a
 * successful install (parked send resumes, dialog closes). Fails → keep the
 * dialog open with guidance.
 */
export async function recheckClaude(transport = getTransport()) {
  let found = false;
  try {
    const check = await transport.app_prereq_check();
    found = Boolean(check?.claudeCli?.found);
  } catch {
    found = false;
  }
  if (found) {
    if (activeFlow) {
      activeFlow.cancel();
      activeFlow = null;
    }
    handleInstallSucceeded();
    return true;
  }
  dispatch({
    type: "install_error",
    message:
      "Claude Code still wasn’t detected. If you installed it manually, make sure the install finished, then re-check.",
  });
  return false;
}

/**
 * The pre-inference gate. Resolves `true` when a turn may start:
 *  - the CLI was already detected this app run (cached), or
 *  - the probe finds it now, or
 *  - the probe itself is unavailable/broken (fail open — the driver still
 *    guards and its error event reopens this dialog), or
 *  - it was missing, the setup dialog ran the installer, and it succeeded.
 * Resolves `false` when the user dismissed the dialog (send dropped) or a
 * newer send superseded this one.
 */
export async function ensureClaudeReady(transport = getTransport()) {
  if (currentState.cliReady) return true;
  let found = null;
  if (typeof transport?.app_prereq_check === "function") {
    try {
      const check = await transport.app_prereq_check();
      found = Boolean(check?.claudeCli?.found);
    } catch {
      found = null;
    }
  }
  if (found === true) {
    dispatch({ type: "cli_ready" });
    return true;
  }
  if (found === null) return true;

  // CLI is definitively missing: park this send behind the setup dialog.
  const gate = new Promise((resolve) => {
    settlePendingSend(false); // supersede an older parked send
    pendingSendResolve = resolve;
  });
  dispatch({ type: "pending_send", value: true });
  openClaudeSetup(transport);
  return gate;
}
