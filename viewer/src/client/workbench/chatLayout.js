// Pure geometry for the chat panel's width relative to the rest of the
// workspace. The chat panel is a fixed right-hand column; everything to its
// left (the collapsible "Models" sidebar, the file tools sheet, and the 3D
// model viewer) shares `window − chatWidth`. These helpers keep the chat from
// growing so wide that the model viewer loses a usable amount of space, while
// still letting it reach a generous fraction of the viewport.
//
// All functions here are DOM-free and deterministic so they can be unit-tested
// in isolation; the React wiring (ChatSidebar drag, AppRoot effects) only reads
// live widths and calls these.
//
// Two layers of layout math exist and are deliberately separate:
//   - This module is the chat-vs-workspace floor, using
//     CAD_VIEWER_MIN_VISIBLE_WIDTH (480).
//   - useCadWorkspaceLayout owns how the sidebar + tools sheet size themselves
//     *within* the workspace, using CAD_WORKSPACE_MIN_MODEL_VIEWPORT_WIDTH
//     (700). That layer is not touched by the chat resize feature.

// Chat never shrinks below this — below it the conversation is unreadable.
export const CHAT_MIN_WIDTH = 320;
// Upper bound on the chat panel as a fraction of the whole window.
export const CHAT_MAX_VIEWPORT_FRACTION = 0.8;
// The model viewer must always keep at least this many pixels visible; the
// chat clamp treats it as a hard floor (only breached as a last resort on a
// viewport too small to fit chat-min + open panels + this floor).
export const CAD_VIEWER_MIN_VISIBLE_WIDTH = 480;

function positiveNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

// Width consumed by the non-chat, non-viewer panels. The tools sheet is always
// counted when open (it is never auto-closed); the left "Models" sidebar is
// counted only when `includeLeftSidebar` is set — clearing it models the
// "auto-close the sidebar to free space" path.
function reservedNonChatWidth(layout, includeLeftSidebar) {
  const left =
    includeLeftSidebar && layout.leftSidebarOpen
      ? positiveNumber(layout.leftSidebarWidth)
      : 0;
  const tools = layout.toolsSheetOpen ? positiveNumber(layout.toolsSheetWidth) : 0;
  return left + tools;
}

/**
 * The three caps that bound the chat width for a given layout:
 *   - `fractionCap`: CHAT_MAX_VIEWPORT_FRACTION of the window.
 *   - `openCap`: widest chat that still leaves the viewer its floor with the
 *     left sidebar kept as-is.
 *   - `closedCap`: same, but with the left sidebar reclaimed. Equals `openCap`
 *     when the sidebar is already closed.
 *
 * @param {object} layout
 * @returns {{ fractionCap: number, openCap: number, closedCap: number }}
 */
export function chatWidthCaps(layout = {}) {
  const viewportWidth = positiveNumber(layout.viewportWidth);
  const fractionCap = Math.floor(viewportWidth * CHAT_MAX_VIEWPORT_FRACTION);
  const openCap = Math.floor(
    viewportWidth - reservedNonChatWidth(layout, true) - CAD_VIEWER_MIN_VISIBLE_WIDTH,
  );
  const closedCap = Math.floor(
    viewportWidth - reservedNonChatWidth(layout, false) - CAD_VIEWER_MIN_VISIBLE_WIDTH,
  );
  return {
    fractionCap,
    openCap: Math.min(fractionCap, openCap),
    closedCap: Math.min(fractionCap, closedCap),
  };
}

/**
 * Clamp a desired chat width to the layout. When `allowCloseLeftSidebar` is set
 * and the desired width only fits by reclaiming the (currently open) left
 * sidebar, returns the wider cap and signals the caller to close it.
 *
 * @param {number} desiredWidth
 * @param {object} layout - viewportWidth, leftSidebar{Open,Width},
 *   toolsSheet{Open,Width}, allowCloseLeftSidebar
 * @returns {{ width: number, closeLeftSidebar: boolean }}
 */
export function clampChatWidth(desiredWidth, layout = {}) {
  const { openCap, closedCap } = chatWidthCaps(layout);
  const numericDesired = Number(desiredWidth);
  const desired = Number.isFinite(numericDesired) ? numericDesired : CHAT_MIN_WIDTH;

  const canReclaimSidebar =
    layout.allowCloseLeftSidebar === true && layout.leftSidebarOpen === true;
  // Only worth closing the sidebar if the user is reaching past what fits with
  // it open AND closing actually unlocks more room.
  const closeLeftSidebar =
    canReclaimSidebar && desired > openCap && closedCap > openCap;

  const cap = Math.max(CHAT_MIN_WIDTH, closeLeftSidebar ? closedCap : openCap);
  const width = Math.round(Math.min(Math.max(desired, CHAT_MIN_WIDTH), cap));
  return { width, closeLeftSidebar };
}

/**
 * Largest chat width that respects the layout without closing the sidebar —
 * used to re-clamp on window resize (a resize shouldn't close panels).
 *
 * @param {object} layout
 * @returns {number}
 */
export function maxChatWidth(layout = {}) {
  return Math.max(CHAT_MIN_WIDTH, chatWidthCaps(layout).openCap);
}

/**
 * New chat width after the non-chat panels grew (the left sidebar re-opened or
 * the tools sheet opened) such that the viewer floor would be breached. Shrinks
 * chat just enough to restore the floor, never below CHAT_MIN. If even
 * CHAT_MIN cannot restore the floor (viewport too small), returns CHAT_MIN and
 * the viewer absorbs the remaining overflow.
 *
 * @param {object} layout - chatWidth + the grown layout (leftSidebarOpen true)
 * @returns {number}
 */
export function chatWidthAfterPanelsGrew(layout = {}) {
  const chatWidth = positiveNumber(layout.chatWidth, CHAT_MIN_WIDTH);
  const cap = Math.max(CHAT_MIN_WIDTH, chatWidthCaps(layout).openCap);
  return Math.round(Math.min(chatWidth, cap));
}
