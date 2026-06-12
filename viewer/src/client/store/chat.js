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
 * @property {string=} toolUseId
 * @property {unknown=} input
 * @property {"running"|"ok"|"error"|"cancelled"} status
 * @property {string=} resultSummary short summary of the tool's output ("3 lines")
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
 * @typedef {Object} ChatRevertBlock
 * @property {"revert"} kind
 * @property {string} label
 *
 * @typedef {ChatTextBlock | ChatThinkingBlock | ChatToolUseBlock | ChatArtifactBlock | ChatErrorBlock | ChatPlanBlock | ChatRevertBlock} ChatBlock
 *
 * @typedef {Object} ChatTurn
 * @property {string} id
 * @property {"user"|"assistant"} role
 * @property {ChatBlock[]} blocks
 * @property {"pending"|"running"|"complete"|"cancelled"|"error"} status
 * @property {number} startedAt
 * @property {number=} firstTextAt
 * @property {number=} lastActivityAt timestamp of the most recent reasoning/tool event
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
 * @property {{id:string,name:string,mediaType:string,dataBase64:string,objectUrl:string}[]} pendingAttachments
 * @property {string} pendingViewContext
 * @property {string} lastError
 * @property {string} selectedMeshFile
 * @property {boolean} awaitingApproval
 * @property {string} activePlanTurnId
 * @property {boolean} isHydratingSession
 */

/** @type {ChatState} */
export const INITIAL_CHAT_STATE = Object.freeze({
  currentProjectId: "",
  currentTurnId: "",
  turnInProgress: false,
  history: [],
  pendingTokens: [],
  // Reference images the user has attached (paste/drag/pick) but not yet sent.
  // Parallel to pendingTokens; consumed at send. Each carries base64 data (for
  // transport) plus a local objectUrl (for an instant composer thumbnail).
  pendingAttachments: [],
  // A model-facing note describing WHERE the user highlighted (camera + region),
  // set by the viewer's "Send to AI" action alongside the annotated screenshot.
  // Appended to the next turn's userMessage (not shown in the echoed bubble) and
  // consumed at send; cleared if the highlight attachment is removed first.
  pendingViewContext: "",
  lastError: "",
  // Set when a turn fails because the Panda proxy rejected auth (revoked/expired
  // key → BE 401, surfaced as an `auth_expired` chat event). Drives the
  // "Sign in again" banner; cleared on a successful re-login or the next
  // turn_start. App-wide (not per-session) since the proxy key is global.
  needsPandaReauth: false,
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
  isHydratingSession: false,
  // Maps an in-flight turnId → the project that started it. Chat events carry
  // only a turnId, so this is how the reducer routes a streaming response back
  // to the chat it belongs to: events for a turn owned by a project other than
  // the one currently on screen are dropped from the visible history (the owner
  // project's session is persisted by the backend and reloaded on return),
  // instead of polluting whichever chat is active. Preserved across project
  // switches; entries are pruned when a turn ends.
  turnOwners: {},
  // Retained chat slices for NON-active projects that had a turn running when
  // we navigated away from them (keyed by projectId). Background turn events
  // keep these current, so returning to such a project restores its full
  // streamed conversation instead of losing what arrived before/while away. The
  // active project's slice lives at the top level; this only holds others.
  sessions: {},
  // The most recent toolbar "Slice for Bambu" result for the active project.
  // Unlike chat-driven slices (which arrive as `artifact_changed` blocks in
  // `history`), the toolbar `slice_run` is a direct IPC with no chat turn, so
  // we stash its output here to surface the Print button + the cloud `.3mf`.
  // Reset on project switch (via INITIAL_CHAT_STATE) and on `turn_start` (a
  // new chat turn may supersede it with a freshly generated/sliced model).
  lastSlice: { gcodeFile: "", gcode3mfFile: "" },
});

// User-facing copy when the Panda proxy key is revoked/expired (the BE 401 →
// `auth_expired` event). Shown in the chat error block and the re-auth banner.
export const PANDA_REAUTH_MESSAGE =
  "Your Panda sign-in expired or was revoked. Sign in again to keep chatting.";

/**
 * How long the turn spent on behind-the-scenes work (reasoning + tool calls),
 * in ms. While running, counts up to `now` (work is ongoing). Once complete,
 * counts to the last reasoning/tool activity — so a long build reads its true
 * span, and a chat reply excludes the answer-streaming tail (older turns with
 * no `lastActivityAt` fall back through `firstTextAt`/`endedAt`).
 *
 * @param {ChatTurn} turn
 * @param {number=} now epoch ms for the live case; defaults to Date.now()
 * @returns {number}
 */
export function thinkingDurationMs(turn, now) {
  if (!turn || typeof turn.startedAt !== "number") return 0;
  const fallback = typeof now === "number" ? now : Date.now();
  const end =
    turn.endedAt == null
      ? fallback
      : turn.lastActivityAt ?? turn.firstTextAt ?? turn.endedAt;
  return Math.max(0, end - turn.startedAt);
}

/**
 * Split a turn's blocks into the collapsed pre-answer trace vs. the visible
 * answer body. The agentic loop emits inter-step narration as plain `text`
 * blocks between tool calls (structurally identical to the final answer); the
 * separating signal is position — any `text` before the last tool/thinking
 * activity is narration, while the trailing text is the real answer.
 *
 *   trace: thinking + tool_use + intermediate (pre-answer) text — for the pill
 *   body:  final answer text + plan/artifact/error — rendered inline as-is
 *
 * @param {ChatBlock[]} blocks
 * @returns {{ trace: ChatBlock[], body: ChatBlock[] }}
 */
export function partitionTurnBlocks(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  let lastActivityIdx = -1;
  list.forEach((block, i) => {
    if (block.kind === "thinking" || block.kind === "tool_use") lastActivityIdx = i;
  });
  const trace = [];
  const body = [];
  list.forEach((block, i) => {
    if (block.kind === "thinking" || block.kind === "tool_use") {
      trace.push(block);
    } else if (block.kind === "text" && i < lastActivityIdx) {
      trace.push(block); // narration emitted before the answer began
    } else {
      body.push(block);
    }
  });
  return { trace, body };
}

// Injected (model-facing only) when the user sends a highlighted view with no
// instruction of their own. Steers the plan phase toward proposing options for
// the marked region(s) instead of guessing at an edit. Pairs with the
// `pendingViewContext` note, which names where the badges are.
export const HIGHLIGHT_SUGGESTION_DIRECTIVE =
  "The user highlighted the numbered region(s) on the attached view but did not say what to change. " +
  "Before editing anything, view the image, then propose 3–5 specific, concrete improvement options for " +
  "the highlighted region(s) and ask the user which to apply (offer them via a panda-questions block). " +
  "Do not modify the model until they choose.";

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

function appendTextDelta(turn, text, now) {
  if (!text) return turn;
  const blocks = [...turn.blocks];
  const last = blocks[blocks.length - 1];
  if (last && last.kind === "text") {
    blocks[blocks.length - 1] = { kind: "text", text: last.text + text };
  } else {
    blocks.push({ kind: "text", text });
  }
  // Stamp when the final answer begins — closes the "thinking window" so the
  // collapsed indicator can show how long pre-answer work took. Set once.
  const firstTextAt = turn.firstTextAt ?? (typeof now === "number" ? now : undefined);
  return { ...turn, blocks, ...(firstTextAt != null ? { firstTextAt } : {}) };
}

// Stamp the time of the most recent reasoning/tool event so the duration
// reflects the full span of behind-the-scenes work — not just up to the first
// answer token (a build keeps working long after it starts talking).
function withActivity(turn, now) {
  return typeof now === "number" ? { ...turn, lastActivityAt: now } : turn;
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

function appendToolUseStart(turn, tool, input, toolUseId) {
  return {
    ...turn,
    blocks: [
      ...turn.blocks,
      { kind: "tool_use", tool, toolUseId, input, status: "running" },
    ],
  };
}

// Resolve a running tool block to ok/error. Pair by `toolUseId` when present
// (names collide when several tools of the same kind run in one turn — matching
// by name would flip the wrong block and strand the real one on "Running");
// fall back to name only for legacy/id-less events. An end with no matching
// start is still recorded, for observability.
function markToolUseEnd(turn, toolUseId, tool, ok, resultSummary) {
  const summary = resultSummary ? { resultSummary } : {};
  const blocks = [...turn.blocks];
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.kind !== "tool_use" || block.status !== "running") continue;
    const matches = toolUseId ? block.toolUseId === toolUseId : block.tool === tool;
    if (matches) {
      blocks[i] = { ...block, status: ok ? "ok" : "error", ...summary };
      return { ...turn, blocks };
    }
  }
  blocks.push({ kind: "tool_use", tool, toolUseId, status: ok ? "ok" : "error", ...summary });
  return { ...turn, blocks };
}

// When a turn ends, any tool still "running" never received a tool_result (a
// dropped/desynced event, or the child was killed early on plan/cancel) — sweep
// it to "cancelled" so the UI can't show a permanent spinner after the turn is
// done. Real tool failures arrive as tool_use_end{ok:false} → "error" and are
// left untouched: "cancelled" means "no result ever came back", not "it failed".
function finalizeRunningTools(turn) {
  let changed = false;
  const blocks = turn.blocks.map((block) => {
    if (block.kind === "tool_use" && block.status === "running") {
      changed = true;
      return { ...block, status: "cancelled" };
    }
    return block;
  });
  return changed ? { ...turn, blocks } : turn;
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

function isUserCancelled(message) {
  return String(message || "").trim().toLowerCase() === "cancelled";
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
// The per-project chat fields a `chat_event` can mutate. The active project's
// slice lives at the top level of state; backgrounded projects keep theirs in
// `state.sessions`. Both are advanced by `applyChatEventToSession` so a turn
// that keeps streaming after you switch away updates the right conversation.
function sessionSlice(state) {
  return {
    history: state.history,
    currentTurnId: state.currentTurnId,
    turnInProgress: state.turnInProgress,
    awaitingApproval: state.awaitingApproval,
    activePlanTurnId: state.activePlanTurnId,
    lastError: state.lastError,
  };
}

function projectHasInFlightTurn(turnOwners, projectId) {
  if (!projectId || !turnOwners) return false;
  return Object.values(turnOwners).some((owner) => owner === projectId);
}

function withProjectTurnProgress(session, turnOwners, projectId) {
  if (!projectId) return session;
  const turnInProgress = projectHasInFlightTurn(turnOwners, projectId);
  return {
    ...session,
    turnInProgress,
    currentTurnId: turnInProgress ? session.currentTurnId : "",
  };
}

// Pure: apply one chat event to a session slice and return the next slice.
// Owner/turn-tracking (`turnOwners`) is handled by the caller — this only
// evolves the conversation itself, so it works identically for the active
// project and for a backgrounded project's retained slice.
function applyChatEventToSession(session, event, now) {
  const turnId = event.turnId;
  switch (event.kind) {
    case "turn_start":
      return {
        ...session,
        history: ensureAssistantTurn(session.history, turnId, now, event.phase),
        currentTurnId: turnId,
        turnInProgress: true,
      };
    case "plan_proposed":
      return {
        ...session,
        awaitingApproval: true,
        activePlanTurnId: turnId,
        history: updateAssistantTurn(
          ensureAssistantTurn(session.history, turnId, now, "plan"),
          turnId,
          (turn) => appendPlan(turn, event.plan),
        ),
      };
    case "text_delta":
      return {
        ...session,
        history: updateAssistantTurn(
          ensureAssistantTurn(session.history, turnId, now),
          turnId,
          (turn) => appendTextDelta(turn, event.text, now),
        ),
      };
    case "thinking_delta":
      return {
        ...session,
        history: updateAssistantTurn(
          ensureAssistantTurn(session.history, turnId, now),
          turnId,
          (turn) => withActivity(appendThinkingDelta(turn, event.text), now),
        ),
      };
    case "tool_use_start":
      return {
        ...session,
        history: updateAssistantTurn(
          ensureAssistantTurn(session.history, turnId, now),
          turnId,
          (turn) => withActivity(appendToolUseStart(turn, event.tool, event.input, event.toolUseId), now),
        ),
      };
    case "tool_use_end":
      return {
        ...session,
        history: updateAssistantTurn(
          ensureAssistantTurn(session.history, turnId, now),
          turnId,
          (turn) => withActivity(markToolUseEnd(turn, event.toolUseId, event.tool, event.ok, event.resultSummary), now),
        ),
      };
    case "artifact_changed":
      return {
        ...session,
        history: updateAssistantTurn(
          ensureAssistantTurn(session.history, turnId, now),
          turnId,
          (turn) => appendArtifact(turn, event.file, event.reason),
        ),
      };
    case "turn_end":
      return {
        ...session,
        currentTurnId: session.currentTurnId === turnId ? "" : session.currentTurnId,
        turnInProgress: false,
        history: updateAssistantTurn(session.history, turnId, (turn) => ({
          ...finalizeRunningTools(turn),
          status:
            turn.status === "error" || turn.status === "cancelled"
              ? turn.status
              : "complete",
          endedAt: now,
        })),
      };
    case "error": {
      const cancelled = isUserCancelled(event.message);
      return {
        ...session,
        currentTurnId: session.currentTurnId === turnId ? "" : session.currentTurnId,
        turnInProgress: false,
        lastError: cancelled ? session.lastError : event.message,
        history: updateAssistantTurn(
          ensureAssistantTurn(session.history, turnId, now),
          turnId,
          (turn) => {
            const finalized = finalizeRunningTools(turn);
            if (cancelled) {
              return { ...finalized, status: "cancelled", endedAt: now };
            }
            return { ...appendError(finalized, event.message), endedAt: now };
          },
        ),
      };
    }
    case "auth_expired":
      // Same turn lifecycle as `error`, with fixed copy. The top-level
      // `needsPandaReauth` flag (set in chatReducer) drives the action banner.
      return {
        ...session,
        currentTurnId: session.currentTurnId === turnId ? "" : session.currentTurnId,
        turnInProgress: false,
        lastError: PANDA_REAUTH_MESSAGE,
        history: updateAssistantTurn(
          ensureAssistantTurn(session.history, turnId, now),
          turnId,
          (turn) => ({ ...appendError(turn, PANDA_REAUTH_MESSAGE), endedAt: now }),
        ),
      };
    default:
      return session;
  }
}

export function chatReducer(state, action, now = Date.now()) {
  switch (action.type) {
    case "set_project": {
      if (state.currentProjectId === action.projectId) return state;
      // Stash the project we're leaving if a turn is still running there, so its
      // streamed-so-far chat survives the switch and background events keep it
      // current. (Completed projects reload cheaply from the backend on return.)
      let sessions = state.sessions;
      if (
        state.currentProjectId &&
        (state.turnInProgress || projectHasInFlightTurn(state.turnOwners, state.currentProjectId))
      ) {
        sessions = { ...sessions, [state.currentProjectId]: sessionSlice(state) };
      }
      // Restore a retained session for the project we're entering (consuming it
      // from the map); otherwise start blank and let hydrateSession fill it in.
      const retained = sessions[action.projectId];
      const { [action.projectId]: _consumed, ...remaining } = sessions;
      const next = {
        ...INITIAL_CHAT_STATE,
        currentProjectId: action.projectId,
        isHydratingSession: action.hydrating === true,
        pendingTokens: state.pendingTokens,
        // Keep tracking any turn still running elsewhere so its events keep
        // routing to its own (retained) session, not this project's chat.
        turnOwners: state.turnOwners,
        sessions: remaining,
      };
      return retained ? { ...next, ...retained } : next;
    }
    case "set_selected_mesh_file": {
      const file = String(action.file || "").trim();
      if (file === state.selectedMeshFile) return state;
      return { ...state, selectedMeshFile: file };
    }
    case "set_last_slice": {
      return {
        ...state,
        lastSlice: {
          gcodeFile: String(action.gcodeFile || ""),
          gcode3mfFile: String(action.gcode3mfFile || ""),
        },
      };
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
        isHydratingSession: false,
      };
    }
    case "hydrate_session_complete":
      if (state.currentProjectId !== action.projectId) return state;
      return { ...state, isHydratingSession: false };
    case "queue_user_message": {
      const userTurn = {
        id: `user-${action.turnId}`,
        role: "user",
        blocks: [{ kind: "text", text: action.text }],
        status: "complete",
        startedAt: action.at,
        endedAt: action.at,
        userText: action.text,
        // Thumbnails of any images attached to this prompt (`{name,url}`).
        images: action.images || [],
      };
      // The backend's `turn_start` (assistant turn) can race ahead of this
      // dispatch — it rides a separate event channel and may land while
      // `chat_start_turn` is still awaiting. If the matching assistant turn is
      // already present, slot the user turn immediately before it so the prompt
      // always renders above Claude's response; otherwise append.
      const assistantIdx = state.history.findIndex(
        (turn) => turn.id === action.turnId && turn.role === "assistant",
      );
      const history =
        assistantIdx === -1
          ? [...state.history, userTurn]
          : [
              ...state.history.slice(0, assistantIdx),
              userTurn,
              ...state.history.slice(assistantIdx),
            ];
      return {
        ...state,
        history,
        currentTurnId: action.turnId,
        turnInProgress: true,
        isHydratingSession: false,
        lastError: "",
        turnOwners: { ...state.turnOwners, [action.turnId]: state.currentProjectId },
      };
    }
    case "chat_event": {
      const event = action.event;
      const turnId = event.turnId;
      const knownOwner = state.turnOwners[turnId];
      // The backend stamps every event with its owning `projectId`, so routing
      // never has to guess. Fall back to the recorded owner, then (only for a
      // legacy/stub event that omits the id) to adopting the current project on
      // a fresh `turn_start`.
      const ownerProject =
        event.projectId ||
        knownOwner ||
        (event.kind === "turn_start" ? state.currentProjectId : undefined);

      // Maintain the global turn→project map: register the owner from ANY
      // in-flight event (not just `turn_start`) so a turn whose start we missed
      // — e.g. an HMR/Vite reload mid-build — still gets an owner, and thus a
      // running indicator. Prune on end.
      let turnOwners = state.turnOwners;
      if (
        event.kind === "turn_end" ||
        event.kind === "error" ||
        event.kind === "auth_expired"
      ) {
        const { [turnId]: _drop, ...rest } = turnOwners;
        turnOwners = rest;
      } else if (ownerProject && knownOwner !== ownerProject) {
        turnOwners = { ...turnOwners, [turnId]: ownerProject };
      }

      // The proxy key is app-wide, so a Panda auth rejection raises the re-auth
      // flag regardless of which project's turn hit it; a fresh turn_start
      // clears it (the user re-signed-in or is retrying).
      const reauthPatch =
        event.kind === "auth_expired"
          ? { needsPandaReauth: true }
          : event.kind === "turn_start"
            ? { needsPandaReauth: false }
            : {};

      // Owned by (or just started in) the project on screen → advance the
      // visible session. A new turn supersedes a stale toolbar slice — clear
      // it so a chat-produced gcode (arriving as an artifact) wins.
      if (!ownerProject || ownerProject === state.currentProjectId) {
        const session = applyChatEventToSession(sessionSlice(state), event, now);
        return {
          ...state,
          ...withProjectTurnProgress(session, turnOwners, state.currentProjectId),
          turnOwners,
          ...reauthPatch,
          ...(event.kind === "turn_start" ? { isHydratingSession: false } : {}),
          ...(event.kind === "turn_start"
            ? { lastSlice: INITIAL_CHAT_STATE.lastSlice }
            : {}),
        };
      }

      // Backgrounded project: advance its retained session so returning shows
      // the full streamed response, not just what arrived after returning. If
      // it wasn't retained (no turn was running when we left it), drop the
      // event — its result is persisted and reloaded on return.
      const stash = state.sessions[ownerProject];
      if (!stash) {
        return { ...state, turnOwners, ...reauthPatch };
      }
      return {
        ...state,
        turnOwners,
        ...reauthPatch,
        sessions: {
          ...state.sessions,
          [ownerProject]: withProjectTurnProgress(
            applyChatEventToSession(stash, event, now),
            turnOwners,
            ownerProject,
          ),
        },
      };
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
    case "add_pending_attachment": {
      const att = action.attachment;
      if (!att || !att.id) return state;
      if (state.pendingAttachments.some((a) => a.id === att.id)) return state;
      return { ...state, pendingAttachments: [...state.pendingAttachments, att] };
    }
    case "remove_pending_attachment": {
      const pendingAttachments = state.pendingAttachments.filter((a) => a.id !== action.id);
      // The view-context note describes a highlight that was attached; once the
      // user has cleared every attachment, that note is stale — drop it too.
      const pendingViewContext = pendingAttachments.length ? state.pendingViewContext : "";
      return { ...state, pendingAttachments, pendingViewContext };
    }
    case "consume_pending_attachments":
      if (!state.pendingAttachments.length) return state;
      return { ...state, pendingAttachments: [] };
    case "set_pending_view_context":
      return { ...state, pendingViewContext: String(action.note || "") };
    case "consume_pending_view_context":
      if (!state.pendingViewContext) return state;
      return { ...state, pendingViewContext: "" };
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
    case "note_revert": {
      // A model revert (snapshot restore) drops one self-explaining marker into
      // the *same* linear conversation — nothing is reloaded or hidden. The
      // backend already stashed a note so the next turn tells the model its
      // files went back; this is the user-facing half. (Transient: it isn't in
      // the session JSONL, so it won't reappear after a reload — by design.)
      const marker = {
        id: action.id,
        role: "assistant",
        blocks: [{ kind: "revert", label: action.label }],
        status: "complete",
        startedAt: action.at,
        endedAt: action.at,
      };
      return { ...state, history: [...state.history, marker] };
    }
    case "set_error":
      return { ...state, lastError: action.message };
    case "clear_panda_reauth":
      if (!state.needsPandaReauth) return state;
      return { ...state, needsPandaReauth: false };
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
  // A toolbar `slice_run` (no chat turn) stashes its gcode in `lastSlice`; it
  // wins until a new chat turn clears it. Otherwise fall back to the latest
  // chat-produced `.gcode` artifact.
  const fromSlice = String(state.lastSlice?.gcodeFile || "");
  if (fromSlice) return fromSlice;
  const artifacts = selectArtifactFiles(state);
  for (let i = artifacts.length - 1; i >= 0; i -= 1) {
    if (endsWith(artifacts[i].file, ".gcode")) return artifacts[i].file;
  }
  return "";
}

/**
 * The sliced `.gcode.3mf` (cloud upload artifact) from the most recent toolbar
 * slice, or "" when none. Only the toolbar `slice_run` produces a 3mf; the
 * chat `gcode` skill emits plain gcode only.
 *
 * @param {ChatState} state
 */
export function selectLatestGcode3mf(state) {
  return String(state.lastSlice?.gcode3mfFile || "");
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

/**
 * True while *any* session is mid-turn: the active project (top-level slice) or
 * any backgrounded project whose retained slice is still streaming. Auth mode is
 * a global setting that decides how the `claude` subprocess is spawned, so the
 * proxy/local switch is gated on this — flipping it while a turn runs is blocked.
 *
 * @param {ChatState} state
 */
export function selectAnyTurnInProgress(state) {
  if (state?.turnInProgress) return true;
  const sessions = state?.sessions;
  if (!sessions) return false;
  return Object.values(sessions).some((s) => s?.turnInProgress === true);
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

export async function startTurn(userMessage, { attachments = [] } = {}, transport = getTransport()) {
  const text = String(userMessage || "").trim();
  const images = Array.isArray(attachments) ? attachments : [];
  // A turn needs either text or at least one attached image.
  if (!text && !images.length) return null;
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
    // The highlight context (if any) goes to the model only — append it to the
    // message the backend sees, but keep `text` clean for the echoed bubble.
    // When a highlight is sent with no instruction, prepend a directive asking
    // the model to suggest options rather than guess at an edit.
    const viewContext = String(state.pendingViewContext || "").trim();
    const parts = [];
    if (text) parts.push(text);
    if (viewContext && !text) parts.push(HIGHLIGHT_SUGGESTION_DIRECTIVE);
    if (viewContext) parts.push(viewContext);
    const sentMessage = parts.join("\n\n");
    // Keep the request shape identical to the text-only case unless images are
    // actually attached (additive `images` field; see transport + chat.rs).
    const request = { projectId: state.currentProjectId, userMessage: sentMessage };
    if (images.length) {
      request.images = images.map(({ name, mediaType, dataBase64 }) => ({
        name,
        mediaType,
        dataBase64,
      }));
    }
    const response = await transport.chat_start_turn(request);
    dispatch({
      type: "queue_user_message",
      turnId: response.turnId,
      text,
      at: Date.now(),
      // Thumbnails for the echoed bubble use the local object URLs — no backend
      // round-trip. Reloaded history shows text only (see parse_session_history).
      images: images.map((a) => ({ name: a.name, url: a.objectUrl })),
    });
    dispatch({ type: "consume_pending_tokens" });
    dispatch({ type: "consume_pending_attachments" });
    dispatch({ type: "consume_pending_view_context" });
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
  const previous = getChatState().currentProjectId;
  // A retained session (a project we left mid-turn) is restored by the reducer
  // with its live history; re-hydrating would clobber the still-streaming turn
  // with the backend's not-yet-persisted snapshot, so skip the fetch for it.
  const hadRetained = Boolean(getChatState().sessions?.[projectId]);
  const shouldHydrate = Boolean(projectId && projectId !== previous && !hadRetained);
  dispatch({ type: "set_project", projectId, hydrating: shouldHydrate });
  // Switching into a real project pulls its persisted transcript back in so
  // chat history survives restarts and project switches. Same-project calls
  // (the reducer no-ops them) and clearing to "" skip the fetch.
  if (shouldHydrate) hydrateSession(projectId);
}

/**
 * Rehydrate the chat history for `projectId` from the backend, which rebuilds
 * it from Claude Code's persisted session transcript. Best-effort: a missing,
 * empty, or unreadable session leaves the freshly-reset state untouched.
 * Guards against a stale response landing after the user switched away again
 * or started a turn in the meantime, so it never clobbers live state.
 */
export async function hydrateSession(projectId, transport = getTransport()) {
  if (!projectId) return;
  try {
    const session = await transport.chat_session_state(projectId);
    const state = getChatState();
    if (
      state.currentProjectId !== projectId ||
      state.turnInProgress ||
      projectHasInFlightTurn(state.turnOwners, projectId)
    ) {
      return;
    }
    if (!session || !Array.isArray(session.history) || session.history.length === 0) {
      dispatch({ type: "hydrate_session_complete", projectId });
      return;
    }
    dispatch({ type: "hydrate_session", session });
  } catch {
    // No transport / unreadable session -> nothing to restore.
    const state = getChatState();
    if (state.currentProjectId === projectId) {
      dispatch({ type: "hydrate_session_complete", projectId });
    }
  }
}

/**
 * Record which part the workspace currently has selected so the Slice button
 * targets it. Pass "" (or a non-STL path) to clear the selection and fall
 * back to the latest STL artifact. Called by CadWorkspace as selection moves.
 */
export function setSelectedMeshFile(file) {
  dispatch({ type: "set_selected_mesh_file", file });
}

/**
 * Record the output of a toolbar "Slice for Bambu" (`slice_run`) so the Print
 * button surfaces it even though no chat turn produced it. `gcode3mfFile` is
 * the cloud upload artifact (may be "" if the slicer didn't emit one).
 */
export function recordSlice(gcodeFile, gcode3mfFile = "") {
  dispatch({ type: "set_last_slice", gcodeFile, gcode3mfFile });
}

/**
 * Drop a "↩ Reverted to <label>" marker into the active project's chat after a
 * model save-state is restored. Keeps the conversation linear (see the
 * `note_revert` reducer case and `docs/future-work-version-control.md`).
 */
export function noteRevert(label) {
  const now = Date.now();
  dispatch({
    type: "note_revert",
    label: String(label || "saved state"),
    id: `revert-${now}`,
    at: now,
  });
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

export function addPendingAttachment(attachment) {
  dispatch({ type: "add_pending_attachment", attachment });
}

export function removePendingAttachment(id) {
  dispatch({ type: "remove_pending_attachment", id });
}

export function consumePendingAttachments() {
  dispatch({ type: "consume_pending_attachments" });
}

/** Set the model-facing "where did the user highlight" note for the next turn. */
export function setPendingViewContext(note) {
  dispatch({ type: "set_pending_view_context", note });
}

/** Clear the "Sign in again" banner after a successful Panda re-login. */
export function clearPandaReauth() {
  dispatch({ type: "clear_panda_reauth" });
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
