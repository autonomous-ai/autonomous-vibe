// Chat store for the Panda sidebar.
//
// Holds the per-project turn history, pending @cad[…] tokens queued by face
// clicks, and the active turn/event subscription. Implemented as a tiny
// "Zustand-style" external store with `useSyncExternalStore` bindings so
// React can read snapshots without introducing a new runtime dependency.
//
// Pure reducer + selector functions are exported separately so tests can
// exercise state transitions without touching React.

import { useSyncExternalStore } from "react";
import { __setTransportForTesting, getTransport } from "../lib/transport.ts";

/**
 * @typedef {Object} ChatTextBlock
 * @property {"text"} kind
 * @property {string} text
 *
 * @typedef {Object} ChatThinkingBlock
 * @property {"thinking"} kind
 * @property {string} text
 *
 * @typedef {Object} ChatToolUseBlock
 * @property {"tool_use"} kind
 * @property {string} tool
 * @property {unknown=} input
 * @property {"running"|"ok"|"error"} status
 *
 * @typedef {Object} ChatArtifactBlock
 * @property {"artifact"} kind
 * @property {string} file
 * @property {"new"|"modified"} reason
 *
 * @typedef {Object} ChatErrorBlock
 * @property {"error"} kind
 * @property {string} message
 *
 * @typedef {Object} ChatPlanBlock
 * @property {"plan"} kind
 * @property {string} plan
 * @property {"proposed"|"approved"|"superseded"} status
 *
 * @typedef {ChatTextBlock | ChatThinkingBlock | ChatToolUseBlock | ChatArtifactBlock | ChatErrorBlock | ChatPlanBlock} ChatBlock
 *
 * @typedef {Object} ChatTurn
 * @property {string} id
 * @property {"user"|"assistant"} role
 * @property {ChatBlock[]} blocks
 * @property {"pending"|"running"|"complete"|"cancelled"|"error"} status
 * @property {number} startedAt
 * @property {number=} endedAt
 * @property {string=} userText
 * @property {"plan"|"implement"=} phase
 *
 * @typedef {Object} ChatState
 * @property {string} currentProjectId
 * @property {string} currentTurnId
 * @property {boolean} turnInProgress
 * @property {ChatTurn[]} history
 * @property {string[]} pendingTokens
 * @property {string} lastError
 * @property {string} selectedMeshFile
 * @property {boolean} awaitingApproval
 * @property {string} activePlanTurnId
 */

/** @type {ChatState} */
export const INITIAL_CHAT_STATE = Object.freeze({
  currentProjectId: "",
  currentTurnId: "",
  turnInProgress: false,
  history: [],
  pendingTokens: [],
  lastError: "",
  // Project-relative path of the part the user currently has selected in the
  // workspace (the breadcrumb / Models rail). Drives the Slice button target
  // so "slice" acts on the viewed part, not just the most recent artifact.
  // Empty when nothing (sliceable) is selected — callers fall back to the
  // latest STL artifact. Bridged in from CadWorkspace via setSelectedMeshFile.
  selectedMeshFile: "",
  // True while a proposed plan is waiting for the user to approve / request
  // changes. `activePlanTurnId` is the assistant turn carrying that plan
  // block, so the approve/request thunks can mark it.
  awaitingApproval: false,
  activePlanTurnId: "",
});

// ---------------------------------------------------------------------------
// Reducer — pure; the only place state evolves
// ---------------------------------------------------------------------------

function ensureAssistantTurn(history, turnId, now, phase) {
  if (history.some((turn) => turn.id === turnId && turn.role === "assistant")) {
    return history;
  }
  return [
    ...history,
    {
      id: turnId,
      role: "assistant",
      blocks: [],
      status: "running",
      startedAt: now,
      ...(phase ? { phase } : {}),
    },
  ];
}

function appendPlan(turn, plan) {
  return {
    ...turn,
    phase: "plan",
    blocks: [...turn.blocks, { kind: "plan", plan, status: "proposed" }],
  };
}

function updateAssistantTurn(history, turnId, updater) {
  let touched = false;
  const next = history.map((turn) => {
    if (turn.id === turnId && turn.role === "assistant") {
      touched = true;
      return updater(turn);
    }
    return turn;
  });
  return touched ? next : history;
}

function appendTextDelta(turn, text) {
  if (!text) return turn;
  const blocks = [...turn.blocks];
  const last = blocks[blocks.length - 1];
  if (last && last.kind === "text") {
    blocks[blocks.length - 1] = { kind: "text", text: last.text + text };
  } else {
    blocks.push({ kind: "text", text });
  }
  return { ...turn, blocks };
}

function appendThinkingDelta(turn, text) {
  if (!text) return turn;
  const blocks = [...turn.blocks];
  const last = blocks[blocks.length - 1];
  if (last && last.kind === "thinking") {
    blocks[blocks.length - 1] = { kind: "thinking", text: last.text + text };
  } else {
    blocks.push({ kind: "thinking", text });
  }
  return { ...turn, blocks };
}

function appendToolUseStart(turn, tool, input) {
  return {
    ...turn,
    blocks: [
      ...turn.blocks,
      { kind: "tool_use", tool, input, status: "running" },
    ],
  };
}

function markToolUseEnd(turn, tool, ok) {
  const blocks = [...turn.blocks];
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.kind === "tool_use" && block.tool === tool && block.status === "running") {
      blocks[i] = { ...block, status: ok ? "ok" : "error" };
      return { ...turn, blocks };
    }
  }
  blocks.push({ kind: "tool_use", tool, status: ok ? "ok" : "error" });
  return { ...turn, blocks };
}

function appendArtifact(turn, file, reason) {
  return {
    ...turn,
    blocks: [...turn.blocks, { kind: "artifact", file, reason }],
  };
}

function appendError(turn, message) {
  return {
    ...turn,
    blocks: [...turn.blocks, { kind: "error", message }],
    status: "error",
  };
}

function dedupe(values) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const trimmed = String(value || "").trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * @param {ChatState} state
 * @param {Object} action
 * @param {number=} now
 * @returns {ChatState}
 */
export function chatReducer(state, action, now = Date.now()) {
  switch (action.type) {
    case "set_project": {
      if (state.currentProjectId === action.projectId) return state;
      return {
        ...INITIAL_CHAT_STATE,
        currentProjectId: action.projectId,
        pendingTokens: state.pendingTokens,
      };
    }
    case "set_selected_mesh_file": {
      const file = String(action.file || "").trim();
      if (file === state.selectedMeshFile) return state;
      return { ...state, selectedMeshFile: file };
    }
    case "hydrate_session": {
      const history = action.session.history.map((item, index) => ({
        id: `hydrated-${index}`,
        role: item.role,
        blocks: [{ kind: "text", text: item.content }],
        status: "complete",
        startedAt: item.at,
        endedAt: item.at,
        userText: item.role === "user" ? item.content : undefined,
      }));
      return {
        ...state,
        history,
        turnInProgress: action.session.turnInProgress === true,
        currentTurnId: action.session.turnInProgress ? state.currentTurnId : "",
      };
    }
    case "queue_user_message": {
      const userTurn = {
        id: `user-${action.turnId}`,
        role: "user",
        blocks: [{ kind: "text", text: action.text }],
        status: "complete",
        startedAt: action.at,
        endedAt: action.at,
        userText: action.text,
      };
      return {
        ...state,
        history: [...state.history, userTurn],
        currentTurnId: action.turnId,
        turnInProgress: true,
        lastError: "",
      };
    }
    case "chat_event": {
      const event = action.event;
      const turnId = event.turnId;
      switch (event.kind) {
        case "turn_start":
          return {
            ...state,
            history: ensureAssistantTurn(state.history, turnId, now, event.phase),
            currentTurnId: turnId,
            turnInProgress: true,
          };
        case "plan_proposed":
          return {
            ...state,
            awaitingApproval: true,
            activePlanTurnId: turnId,
            history: updateAssistantTurn(
              ensureAssistantTurn(state.history, turnId, now, "plan"),
              turnId,
              (turn) => appendPlan(turn, event.plan),
            ),
          };
        case "text_delta":
          return {
            ...state,
            history: updateAssistantTurn(
              ensureAssistantTurn(state.history, turnId, now),
              turnId,
              (turn) => appendTextDelta(turn, event.text),
            ),
          };
        case "thinking_delta":
          return {
            ...state,
            history: updateAssistantTurn(
              ensureAssistantTurn(state.history, turnId, now),
              turnId,
              (turn) => appendThinkingDelta(turn, event.text),
            ),
          };
        case "tool_use_start":
          return {
            ...state,
            history: updateAssistantTurn(
              ensureAssistantTurn(state.history, turnId, now),
              turnId,
              (turn) => appendToolUseStart(turn, event.tool, event.input),
            ),
          };
        case "tool_use_end":
          return {
            ...state,
            history: updateAssistantTurn(
              ensureAssistantTurn(state.history, turnId, now),
              turnId,
              (turn) => markToolUseEnd(turn, event.tool, event.ok),
            ),
          };
        case "artifact_changed":
          return {
            ...state,
            history: updateAssistantTurn(
              ensureAssistantTurn(state.history, turnId, now),
              turnId,
              (turn) => appendArtifact(turn, event.file, event.reason),
            ),
          };
        case "turn_end":
          return {
            ...state,
            currentTurnId: state.currentTurnId === turnId ? "" : state.currentTurnId,
            turnInProgress: false,
            history: updateAssistantTurn(state.history, turnId, (turn) => ({
              ...turn,
              status: turn.status === "error" ? "error" : "complete",
              endedAt: now,
            })),
          };
        case "error":
          return {
            ...state,
            currentTurnId: state.currentTurnId === turnId ? "" : state.currentTurnId,
            turnInProgress: false,
            lastError: event.message,
            history: updateAssistantTurn(
              ensureAssistantTurn(state.history, turnId, now),
              turnId,
              (turn) => ({ ...appendError(turn, event.message), endedAt: now }),
            ),
          };
        default:
          return state;
      }
    }
    case "set_pending_tokens":
      return { ...state, pendingTokens: dedupe(action.tokens) };
    case "add_pending_token": {
      const token = String(action.token || "").trim();
      if (!token || state.pendingTokens.includes(token)) return state;
      return { ...state, pendingTokens: [...state.pendingTokens, token] };
    }
    case "consume_pending_tokens":
      if (!state.pendingTokens.length) return state;
      return { ...state, pendingTokens: [] };
    case "mark_plan": {
      // Flip a proposed plan block's status (approved | superseded) and,
      // once it's acted on, clear the awaiting-approval gate.
      const stillProposed = action.status === "proposed";
      return {
        ...state,
        awaitingApproval: stillProposed ? state.awaitingApproval : false,
        activePlanTurnId: stillProposed ? state.activePlanTurnId : "",
        history: updateAssistantTurn(state.history, action.turnId, (turn) => ({
          ...turn,
          blocks: turn.blocks.map((b) =>
            b.kind === "plan" ? { ...b, status: action.status } : b,
          ),
        })),
      };
    }
    case "set_error":
      return { ...state, lastError: action.message };
    case "reset":
      return INITIAL_CHAT_STATE;
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Selectors — pure
// ---------------------------------------------------------------------------

/** @param {ChatState} state */
export function selectArtifactFiles(state) {
  const seen = new Map();
  for (const turn of state.history) {
    if (turn.role !== "assistant") continue;
    for (const block of turn.blocks) {
      if (block.kind !== "artifact") continue;
      const previous = seen.get(block.file);
      seen.set(
        block.file,
        previous && block.reason === "modified" && previous === "new" ? "new" : block.reason,
      );
    }
  }
  return Array.from(seen.entries()).map(([file, reason]) => ({ file, reason }));
}

function endsWith(file, suffix) {
  return String(file || "").toLowerCase().endsWith(suffix);
}

/** @param {ChatState} state */
export function selectLatestStl(state) {
  const artifacts = selectArtifactFiles(state);
  for (let i = artifacts.length - 1; i >= 0; i -= 1) {
    if (endsWith(artifacts[i].file, ".stl")) return artifacts[i].file;
  }
  return "";
}

/** @param {ChatState} state */
export function selectLatestGcode(state) {
  const artifacts = selectArtifactFiles(state);
  for (let i = artifacts.length - 1; i >= 0; i -= 1) {
    if (endsWith(artifacts[i].file, ".gcode")) return artifacts[i].file;
  }
  return "";
}

/**
 * The STL the Slice button should target: the part the user currently has
 * selected in the workspace, if it's an STL. Falls back to the latest STL
 * artifact when nothing sliceable is selected, so a fresh chat-only session
 * (no explicit selection yet) still slices the model just generated.
 *
 * @param {ChatState} state
 */
export function selectSliceTargetStl(state) {
  const selected = String(state?.selectedMeshFile || "").trim();
  if (endsWith(selected, ".stl")) return selected;
  return selectLatestStl(state);
}

// ---------------------------------------------------------------------------
// External store + React bindings
// ---------------------------------------------------------------------------

/** @type {ChatState} */
let currentState = INITIAL_CHAT_STATE;
const listeners = new Set();
/** @type {(() => void)|null} */
let eventUnsubscribe = null;

function setState(next) {
  if (next === currentState) return;
  currentState = next;
  for (const listener of listeners) {
    listener();
  }
}

export function getChatState() {
  return currentState;
}

export function subscribeChat(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function dispatch(action) {
  setState(chatReducer(currentState, action));
}

/**
 * Subscribe to the transport's chat_event stream. Returns an unsubscribe.
 * Safe to call multiple times — only the latest subscription is retained.
 */
export function attachChatEventStream(transport = getTransport()) {
  if (eventUnsubscribe) {
    eventUnsubscribe();
    eventUnsubscribe = null;
  }
  eventUnsubscribe = transport.events.subscribe("chat_event", (event) => {
    dispatch({ type: "chat_event", event });
    if (event?.kind === "turn_end") {
      // A finished turn may have produced Claude Code's AI title for the
      // session; refresh the project list so the placeholder name upgrades in
      // the switcher (the Rust project_list reads it lazily). Dynamic import
      // keeps the projects store out of chat-store unit tests' module graph;
      // errors (e.g. no transport in tests) are intentionally ignored.
      import("./projects.ts")
        .then((m) => m.useProjectsStore.getState().refresh())
        .catch(() => {});
    }
  });
  return () => {
    if (eventUnsubscribe) {
      eventUnsubscribe();
      eventUnsubscribe = null;
    }
  };
}

export function detachChatEventStream() {
  if (eventUnsubscribe) {
    eventUnsubscribe();
    eventUnsubscribe = null;
  }
}

// ---------------------------------------------------------------------------
// Action helpers used by components (components never hit transport directly).
// ---------------------------------------------------------------------------

export async function startTurn(userMessage, transport = getTransport()) {
  const text = String(userMessage || "").trim();
  if (!text) return null;
  const state = getChatState();
  if (!state.currentProjectId) {
    dispatch({ type: "set_error", message: "No project selected" });
    return null;
  }
  if (state.turnInProgress) {
    dispatch({ type: "set_error", message: "A turn is already in progress" });
    return null;
  }
  try {
    const response = await transport.chat_start_turn({
      projectId: state.currentProjectId,
      userMessage: text,
    });
    dispatch({
      type: "queue_user_message",
      turnId: response.turnId,
      text,
      at: Date.now(),
    });
    dispatch({ type: "consume_pending_tokens" });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dispatch({ type: "set_error", message });
    return null;
  }
}

/**
 * Approve the proposed plan (optionally with the user's edits) and kick off
 * the implementation turn. The backend resumes the session in acceptEdits
 * mode; the resulting `turn_start` (phase "implement") drives the rest.
 */
export async function approvePlan(planText, transport = getTransport()) {
  const state = getChatState();
  if (!state.awaitingApproval || !state.currentProjectId) return null;
  const turnId = state.activePlanTurnId;
  try {
    const response = await transport.chat_approve_plan({
      projectId: state.currentProjectId,
      planText: String(planText || ""),
    });
    dispatch({ type: "mark_plan", turnId, status: "approved" });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dispatch({ type: "set_error", message });
    return null;
  }
}

/**
 * Ask the model to revise the proposed plan. Stays in planning mode; the
 * prior plan is marked superseded and a fresh plan turn streams in.
 */
export async function requestPlanChanges(feedback, transport = getTransport()) {
  const state = getChatState();
  if (!state.awaitingApproval || !state.currentProjectId) return null;
  const turnId = state.activePlanTurnId;
  const text = String(feedback || "").trim();
  if (!text) return null;
  try {
    const response = await transport.chat_request_plan_changes({
      projectId: state.currentProjectId,
      feedback: text,
    });
    // Show what the user asked to change, then supersede the old plan.
    dispatch({
      type: "queue_user_message",
      turnId: response.turnId,
      text,
      at: Date.now(),
    });
    dispatch({ type: "mark_plan", turnId, status: "superseded" });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dispatch({ type: "set_error", message });
    return null;
  }
}

export async function cancelTurn(transport = getTransport()) {
  const turnId = getChatState().currentTurnId;
  if (!turnId) return;
  try {
    await transport.chat_cancel_turn(turnId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dispatch({ type: "set_error", message });
  }
}

export function setProject(projectId) {
  dispatch({ type: "set_project", projectId });
}

/**
 * Record which part the workspace currently has selected so the Slice button
 * targets it. Pass "" (or a non-STL path) to clear the selection and fall
 * back to the latest STL artifact. Called by CadWorkspace as selection moves.
 */
export function setSelectedMeshFile(file) {
  dispatch({ type: "set_selected_mesh_file", file });
}

export function setPendingTokens(tokens) {
  dispatch({ type: "set_pending_tokens", tokens });
}

export function addPendingToken(token) {
  dispatch({ type: "add_pending_token", token });
}

export function consumePendingTokens() {
  dispatch({ type: "consume_pending_tokens" });
}

export function resetChatStore() {
  detachChatEventStream();
  setState(INITIAL_CHAT_STATE);
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

export function useChatStore(selector = (state) => state) {
  return useSyncExternalStore(
    subscribeChat,
    () => selector(currentState),
    () => selector(currentState),
  );
}

export { __setTransportForTesting };
