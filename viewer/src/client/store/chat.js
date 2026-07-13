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
import {
  ensureClaudeReady,
  isClaudeMissingError,
  openClaudeSetup,
} from "./claudeSetup.js";

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
  // Maps projectId → why its session is paused waiting for the user: "plan" (a
  // proposed plan) or "questions" (a preference fork). Kept at the top level
  // (like turnOwners) rather than in the per-session slice, so it survives
  // project switches: a project that pauses then is navigated away from would
  // otherwise lose its retained slice (the retain condition is "turn in flight",
  // and a paused turn has ended). Drives the sidebar "needs your answer" dot and
  // the composer status line — but only after `awaitingNeedsUser` resolves the
  // reason against autopilot (which auto-builds plans, so a "plan" reason isn't a
  // real wait then). Set when a turn ends paused; cleared when the user responds.
  // Not persisted — lost on a full reload, where the card is still in chat.
  awaitingAnswerProjectIds: {},
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
 * @typedef {Object} TurnSegment
 * @property {ChatBlock[]} reasoning thinking + pre-answer narration (shown inline)
 * @property {ChatBlock[]} activity tool_use blocks (the collapsible group)
 */

/**
 * Segment a turn's blocks into chronological reasoning→tools groups plus the
 * trailing answer body — so the thread reads like the work actually unfolded
 * ("check the workspace" → 2 reads · "write the parts" → 17 writes) instead of
 * hoisting all reasoning to the top and lumping every tool into one blob.
 *
 * A segment is a run of reasoning (thinking + narration) followed by the tool
 * calls that ran after it; the next reasoning block that appears *after* tools
 * begins a new segment. The agentic loop emits inter-step narration as plain
 * `text` blocks between tool calls — the separating signal from the real answer
 * is position: any `text` before the last tool/thinking activity is narration,
 * the trailing text is the answer.
 *
 *   segments: ordered { reasoning, activity } groups
 *   body:     final answer text + plan/artifact/error — rendered inline as-is
 *
 * @param {ChatBlock[]} blocks
 * @returns {{ segments: TurnSegment[], body: ChatBlock[] }}
 */
export function segmentTurnBlocks(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  let lastActivityIdx = -1;
  list.forEach((block, i) => {
    if (block.kind === "thinking" || block.kind === "tool_use") lastActivityIdx = i;
  });
  const segments = [];
  const body = [];
  let current = null;
  const flush = () => {
    if (current && (current.reasoning.length || current.activity.length)) {
      segments.push(current);
    }
    current = null;
  };
  list.forEach((block, i) => {
    const isReasoning =
      block.kind === "thinking" || (block.kind === "text" && i < lastActivityIdx);
    if (block.kind === "tool_use") {
      if (!current) current = { reasoning: [], activity: [] };
      current.activity.push(block);
    } else if (isReasoning) {
      // Reasoning that follows tool calls opens a fresh segment; consecutive
      // reasoning blocks accumulate into the same one.
      if (current && current.activity.length > 0) flush();
      if (!current) current = { reasoning: [], activity: [] };
      current.reasoning.push(block);
    } else {
      // Trailing answer text, plan, artifact, error.
      body.push(block);
    }
  });
  flush();
  return { segments, body };
}

/**
 * Contiguous, gapless wall-clock spans (epoch ms) for a turn's segments, so each
 * segment's counter reflects all the time it owned — not just its own block
 * span. Each segment starts where the previous one ended; the first starts at
 * the turn's `startedAt` (so a planning turn's "think a while → one fast tool"
 * reads the real elapsed time, not 0s when the thinking wasn't a streamed
 * block). A segment's end is the latest of its blocks' `at`/`endedAt`. The
 * active (live) segment's end is overridden with `now` by the renderer so it
 * ticks. Falls back to block times when `startedAt` is unknown.
 *
 * @param {TurnSegment[]} segments
 * @param {number=} startedAt the turn's start time (epoch ms)
 * @returns {{ start: number, end: number }[]}
 */
export function segmentSpans(segments, startedAt) {
  const list = Array.isArray(segments) ? segments : [];
  const spans = [];
  let prevEnd = typeof startedAt === "number" ? startedAt : null;
  for (const seg of list) {
    const times = [];
    for (const b of (seg && seg.reasoning) || []) if (typeof b.at === "number") times.push(b.at);
    for (const b of (seg && seg.activity) || []) {
      if (typeof b.at === "number") times.push(b.at);
      if (typeof b.endedAt === "number") times.push(b.endedAt);
    }
    const start = prevEnd != null ? prevEnd : times.length ? Math.min(...times) : 0;
    const end = Math.max(start, times.length ? Math.max(...times) : start);
    spans.push({ start, end });
    prevEnd = end;
  }
  return spans;
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
    blocks[blocks.length - 1] = { ...last, text: last.text + text };
  } else {
    // `at` (creation time) drives per-segment durations.
    blocks.push({ kind: "text", text, ...(typeof now === "number" ? { at: now } : {}) });
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

function appendThinkingDelta(turn, text, now) {
  if (!text) return turn;
  const blocks = [...turn.blocks];
  const last = blocks[blocks.length - 1];
  if (last && last.kind === "thinking") {
    blocks[blocks.length - 1] = { ...last, text: last.text + text };
  } else {
    blocks.push({ kind: "thinking", text, ...(typeof now === "number" ? { at: now } : {}) });
  }
  return { ...turn, blocks };
}

function appendToolUseStart(turn, tool, input, toolUseId, now) {
  return {
    ...turn,
    blocks: [
      ...turn.blocks,
      // `at` (start time) anchors this segment's duration.
      { kind: "tool_use", tool, toolUseId, input, status: "running", ...(typeof now === "number" ? { at: now } : {}) },
    ],
  };
}

// Resolve a running tool block to ok/error. Pair by `toolUseId` when present
// (names collide when several tools of the same kind run in one turn — matching
// by name would flip the wrong block and strand the real one on "Running");
// fall back to name only for legacy/id-less events. An end with no matching
// start is still recorded, for observability.
function markToolUseEnd(turn, toolUseId, tool, ok, resultSummary, now) {
  const summary = resultSummary ? { resultSummary } : {};
  const ended = typeof now === "number" ? { endedAt: now } : {};
  const blocks = [...turn.blocks];
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.kind !== "tool_use" || block.status !== "running") continue;
    const matches = toolUseId ? block.toolUseId === toolUseId : block.tool === tool;
    if (matches) {
      blocks[i] = { ...block, status: ok ? "ok" : "error", ...summary, ...ended };
      return { ...turn, blocks };
    }
  }
  // No matching start. Record it for observability only if we have a tool name
  // to show; a nameless orphan (a stray result for an intercepted built-in the
  // driver suppressed the start for) would render as a meaningless "Working"
  // error chip, so drop it.
  if (!tool) return turn;
  blocks.push({ kind: "tool_use", tool, toolUseId, status: ok ? "ok" : "error", ...summary, ...ended });
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

// The fence the driver emits (as a TextDelta) for both the AskUserQuestion tool
// and a model-authored preference fork; the chat renders it as a QuestionCard.
// Its presence in a finished turn means the model is waiting on the user.
const PANDA_QUESTIONS_FENCE = "```panda-questions";

function turnHasPendingQuestions(turn) {
  if (!turn || !Array.isArray(turn.blocks)) return false;
  return turn.blocks.some(
    (b) => b.kind === "text" && typeof b.text === "string" && b.text.includes(PANDA_QUESTIONS_FENCE),
  );
}

// Mark `projectId` as awaiting a user answer, tagging *why* — "plan" (a proposed
// plan) or "questions" (preference fork). The reason matters because autopilot
// auto-builds plans (so a "plan" reason isn't really a wait then) but never
// auto-answers questions; consumers resolve that via `awaitingNeedsUser`.
// Value-stable: returns the same map when already set to the same reason.
function setAwaiting(map, projectId, reason) {
  if (!projectId || map[projectId] === reason) return map;
  return { ...map, [projectId]: reason };
}

// Clear `projectId` from the awaiting map (the user responded / the pause ended).
function clearAwaiting(map, projectId) {
  if (!projectId || !map[projectId]) return map;
  const { [projectId]: _drop, ...rest } = map;
  return rest;
}

// Evolve the awaiting-answer map for one chat event. `ownerProject` is the event's
// resolved owner and `history` is the owner session's history (post-apply, where
// the paused turn's blocks already hold any panda-questions fence text).
function nextAwaitingMap(map, event, ownerProject, history) {
  if (!ownerProject) return map;
  switch (event.kind) {
    case "plan_proposed":
      return setAwaiting(map, ownerProject, "plan");
    case "turn_end": {
      const turn = history.find((t) => t.id === event.turnId && t.role === "assistant");
      return turnHasPendingQuestions(turn) ? setAwaiting(map, ownerProject, "questions") : map;
    }
    case "turn_start":
    case "error":
      return clearAwaiting(map, ownerProject);
    default:
      return map;
  }
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
          (turn) => withActivity(appendThinkingDelta(turn, event.text, now), now),
        ),
      };
    case "tool_use_start":
      return {
        ...session,
        history: updateAssistantTurn(
          ensureAssistantTurn(session.history, turnId, now),
          turnId,
          (turn) => withActivity(appendToolUseStart(turn, event.tool, event.input, event.toolUseId, now), now),
        ),
      };
    case "tool_use_end":
      return {
        ...session,
        history: updateAssistantTurn(
          ensureAssistantTurn(session.history, turnId, now),
          turnId,
          (turn) => withActivity(markToolUseEnd(turn, event.toolUseId, event.tool, event.ok, event.resultSummary, now), now),
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
      // A turn error renders inline as an error block (below); it is deliberately
      // NOT mirrored into `lastError` — the bottom banner is reserved for
      // client-side errors (set_error: no project, turn already running) that
      // have no inline turn. Mirroring both duplicated the same message on screen.
      return {
        ...session,
        currentTurnId: session.currentTurnId === turnId ? "" : session.currentTurnId,
        turnInProgress: false,
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
      //
      // Also retain a project that's paused waiting for the user (a proposed
      // plan or unanswered questions). Its turn has ENDED, so the in-flight
      // checks miss it — but its rich blocks (the plan/QuestionCard) only live
      // in this slice: re-hydrating from the persisted transcript flattens them
      // to plain text AND can't recover the driver-synthesized `panda-questions`
      // fence at all, so the answer UI would vanish on return. Keeping the slice
      // restores it intact (and skips the hydrate fetch — see `setProject`).
      let sessions = state.sessions;
      if (
        state.currentProjectId &&
        (state.turnInProgress ||
          projectHasInFlightTurn(state.turnOwners, state.currentProjectId) ||
          state.awaitingAnswerProjectIds[state.currentProjectId])
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
        // Per-project awaiting-answer flags are independent of which project is
        // on screen, so carry them across the switch (this is the whole reason
        // the map lives at the top level rather than in the session slice).
        awaitingAnswerProjectIds: state.awaitingAnswerProjectIds,
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
      const history = action.session.history.map((item, index) => {
        // A rehydrated assistant turn carries structured `blocks` (reasoning +
        // tool calls with timings) so the inline trace rebuilds exactly as it
        // streamed live; user and text-only turns fall back to a single text
        // block from `content`.
        const blocks =
          Array.isArray(item.blocks) && item.blocks.length > 0
            ? item.blocks
            : [{ kind: "text", text: item.content }];
        // startedAt/endedAt from the block timings drive per-segment durations;
        // flat turns (no timestamps) fall back to the entry's own timestamp.
        const times = [];
        for (const b of blocks) {
          if (typeof b.at === "number") times.push(b.at);
          if (typeof b.endedAt === "number") times.push(b.endedAt);
        }
        const blockMin = times.length ? Math.min(...times) : item.at;
        // Floor an assistant turn's start at the prompt that triggered it, so the
        // first segment counts the model's pre-first-block thinking (a planning
        // turn reads its real time, not 0s) on reload too.
        const prev = action.session.history[index - 1];
        const startedAt =
          item.role === "assistant" && prev && prev.role === "user" && typeof prev.at === "number"
            ? Math.min(prev.at, blockMin)
            : blockMin;
        const endedAt = times.length ? Math.max(...times) : item.at;
        return {
          id: `hydrated-${index}`,
          role: item.role,
          blocks,
          status: "complete",
          startedAt,
          endedAt,
          userText: item.role === "user" ? item.content : undefined,
        };
      });
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
        // The user just responded (a fresh message, answered questions, or
        // requested plan changes), so this project is no longer blocked on them.
        awaitingAnswerProjectIds: clearAwaiting(
          state.awaitingAnswerProjectIds,
          state.currentProjectId,
        ),
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
      if (event.kind === "turn_end" || event.kind === "error") {
        const { [turnId]: _drop, ...rest } = turnOwners;
        turnOwners = rest;
      } else if (ownerProject && knownOwner !== ownerProject) {
        turnOwners = { ...turnOwners, [turnId]: ownerProject };
      }

      // Owned by (or just started in) the project on screen → advance the
      // visible session. A new turn supersedes a stale toolbar slice — clear
      // it so a chat-produced gcode (arriving as an artifact) wins.
      if (!ownerProject || ownerProject === state.currentProjectId) {
        const session = applyChatEventToSession(sessionSlice(state), event, now);
        return {
          ...state,
          ...withProjectTurnProgress(session, turnOwners, state.currentProjectId),
          turnOwners,
          awaitingAnswerProjectIds: nextAwaitingMap(
            state.awaitingAnswerProjectIds,
            event,
            ownerProject,
            session.history,
          ),
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
        // No retained slice (the turn wasn't running when we left), but a
        // paused-for-input event still needs its dot — these don't depend on the
        // session history (turn_end question-detection does, and is moot here).
        return {
          ...state,
          turnOwners,
          awaitingAnswerProjectIds: nextAwaitingMap(
            state.awaitingAnswerProjectIds,
            event,
            ownerProject,
            [],
          ),
        };
      }
      const stashed = applyChatEventToSession(stash, event, now);
      return {
        ...state,
        turnOwners,
        awaitingAnswerProjectIds: nextAwaitingMap(
          state.awaitingAnswerProjectIds,
          event,
          ownerProject,
          stashed.history,
        ),
        sessions: {
          ...state.sessions,
          [ownerProject]: withProjectTurnProgress(stashed, turnOwners, ownerProject),
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
        // Acting on the plan (approve/supersede) ends the pause. Plan actions
        // only ever apply to the active project (approvePlan/requestPlanChanges
        // gate on currentProjectId), so clear that one.
        awaitingAnswerProjectIds: stillProposed
          ? state.awaitingAnswerProjectIds
          : clearAwaiting(state.awaitingAnswerProjectIds, state.currentProjectId),
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

const EMPTY_AWAITING = Object.freeze({});

/**
 * The `{ projectId: "plan"|"questions" }` map of projects whose session is paused
 * waiting for the user. Resolve each reason through `awaitingNeedsUser` before
 * surfacing it. Stable empty object when none, so memoized consumers don't churn.
 *
 * @param {ChatState} state
 */
export function selectAwaitingAnswerProjectIds(state) {
  return state?.awaitingAnswerProjectIds || EMPTY_AWAITING;
}

/**
 * Whether a paused reason should surface to the user as "waiting for you", given
 * the autopilot setting. Questions always wait (autopilot never auto-answers
 * them); a proposed plan waits only when autopilot is OFF — under autopilot the
 * backend auto-chains the build (see `spawn_chat_turn` in chat.rs), so a "plan"
 * reason is really "working", not "waiting".
 *
 * @param {"plan"|"questions"|undefined} reason
 * @param {boolean} autopilot
 * @returns {boolean}
 */
export function awaitingNeedsUser(reason, autopilot) {
  if (reason === "questions") return true;
  if (reason === "plan") return !autopilot;
  return false;
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
    // Belt-and-braces behind the pre-send gate in `startTurn`: if a turn still
    // reached the driver without a `claude` CLI (e.g. it vanished mid-session,
    // or an approve-path raced the gate), open the in-app installer instead of
    // leaving the user with only the raw "install Claude Code" error text.
    if (event?.kind === "error" && isClaudeMissingError(event.message)) {
      openClaudeSetup(transport);
    }
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
  // No inference without a working `claude` CLI. When it's missing, this parks
  // the send behind the setup dialog (which auto-runs the in-app installer) and
  // resumes here on success; a dismissed dialog resolves false and the send is
  // dropped (the composer keeps the text — we return null before consuming).
  if (!(await ensureClaudeReady(transport))) return null;
  // Read state AFTER the gate: an install wait can span minutes, and the user
  // may have switched projects or queued tokens in the meantime.
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
  // The build turn is inference too — same CLI gate as `startTurn`.
  if (!(await ensureClaudeReady(transport))) return null;
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
  // Revising the plan resumes the Claude session — gate it like any turn.
  if (!(await ensureClaudeReady(transport))) return null;
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
  // A retained session (a project we left mid-turn, or one paused waiting for an
  // answer) is restored by the reducer with its live history; re-hydrating would
  // clobber it with the backend's snapshot — which lacks the not-yet-persisted
  // stream and the synthesized question/plan blocks — so skip the fetch for it.
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
