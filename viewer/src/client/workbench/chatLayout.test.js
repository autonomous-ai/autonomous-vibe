import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_MIN_WIDTH,
  CHAT_MAX_VIEWPORT_FRACTION,
  CAD_VIEWER_MIN_VISIBLE_WIDTH,
  chatWidthCaps,
  clampChatWidth,
  maxChatWidth,
  chatWidthAfterPanelsGrew,
} from "./chatLayout.js";

// A roomy desktop where the fraction cap, not the viewer floor, binds.
const WIDE = {
  viewportWidth: 1920,
  leftSidebarOpen: false,
  leftSidebarWidth: 0,
  toolsSheetOpen: false,
  toolsSheetWidth: 0,
};

test("fraction cap bounds chat on a wide viewport", () => {
  const { width, closeLeftSidebar } = clampChatWidth(9999, WIDE);
  assert.equal(width, Math.floor(1920 * CHAT_MAX_VIEWPORT_FRACTION));
  assert.equal(closeLeftSidebar, false);
});

test("chat never drops below CHAT_MIN", () => {
  const { width } = clampChatWidth(10, WIDE);
  assert.equal(width, CHAT_MIN_WIDTH);
});

test("viewer floor caps chat below the fraction on a narrow viewport", () => {
  // 1200 wide, no panels: floor cap = 1200 - 480 = 720; fraction = 840.
  // The floor (720) binds.
  const layout = { ...WIDE, viewportWidth: 1200 };
  const { width } = clampChatWidth(9999, layout);
  assert.equal(width, 1200 - CAD_VIEWER_MIN_VISIBLE_WIDTH);
});

test("open left sidebar + tools sheet reduce the cap", () => {
  const layout = {
    viewportWidth: 1600,
    leftSidebarOpen: true,
    leftSidebarWidth: 250,
    toolsSheetOpen: true,
    toolsSheetWidth: 400,
  };
  // openCap = 1600 - 250 - 400 - 480 = 470; fraction = 1120 -> 470 binds.
  const { openCap } = chatWidthCaps(layout);
  assert.equal(openCap, 470);
  const { width } = clampChatWidth(9999, { ...layout, allowCloseLeftSidebar: false });
  assert.equal(width, 470);
});

test("auto-close signals when reaching past the open cap unlocks room", () => {
  const layout = {
    viewportWidth: 1600,
    leftSidebarOpen: true,
    leftSidebarWidth: 250,
    toolsSheetOpen: false,
    toolsSheetWidth: 0,
    allowCloseLeftSidebar: true,
  };
  // openCap = 1600 - 250 - 480 = 870; closedCap = 1600 - 480 = 1120;
  // fraction = 1120. Reaching past 870 should close the sidebar and reach 1120.
  const { openCap, closedCap } = chatWidthCaps(layout);
  assert.equal(openCap, 870);
  assert.equal(closedCap, 1120);

  const below = clampChatWidth(800, layout);
  assert.equal(below.closeLeftSidebar, false);
  assert.equal(below.width, 800);

  const past = clampChatWidth(1000, layout);
  assert.equal(past.closeLeftSidebar, true);
  assert.equal(past.width, 1000);

  const max = clampChatWidth(9999, layout);
  assert.equal(max.closeLeftSidebar, true);
  assert.equal(max.width, 1120);
});

test("no auto-close when the sidebar is already closed", () => {
  const layout = {
    viewportWidth: 1600,
    leftSidebarOpen: false,
    leftSidebarWidth: 0,
    toolsSheetOpen: false,
    toolsSheetWidth: 0,
    allowCloseLeftSidebar: true,
  };
  const { closeLeftSidebar } = clampChatWidth(9999, layout);
  assert.equal(closeLeftSidebar, false);
});

test("maxChatWidth ignores the close path (resize clamp)", () => {
  const layout = {
    viewportWidth: 1600,
    leftSidebarOpen: true,
    leftSidebarWidth: 250,
    toolsSheetOpen: false,
    toolsSheetWidth: 0,
  };
  // Uses openCap = 870 even though closing would allow more.
  assert.equal(maxChatWidth(layout), 870);
});

test("squeeze shrinks chat to restore the viewer floor when a panel opens", () => {
  // Chat was 900 with the sidebar closed; sidebar opens at 250 on a 1600 view.
  // openCap now = 1600 - 250 - 480 = 870, so chat shrinks to 870.
  const next = chatWidthAfterPanelsGrew({
    chatWidth: 900,
    viewportWidth: 1600,
    leftSidebarOpen: true,
    leftSidebarWidth: 250,
    toolsSheetOpen: false,
    toolsSheetWidth: 0,
  });
  assert.equal(next, 870);
});

test("squeeze leaves chat alone when there is already room", () => {
  const next = chatWidthAfterPanelsGrew({
    chatWidth: 500,
    viewportWidth: 1600,
    leftSidebarOpen: true,
    leftSidebarWidth: 250,
    toolsSheetOpen: false,
    toolsSheetWidth: 0,
  });
  assert.equal(next, 500);
});

test("last resort: tiny viewport pins chat at CHAT_MIN and viewer absorbs overflow", () => {
  // 700 wide, sidebar 250 open: floor would need 250 + 480 = 730 > 700.
  // Chat can't go below 320, so it pins at 320 and the viewer takes < 480.
  const next = chatWidthAfterPanelsGrew({
    chatWidth: 600,
    viewportWidth: 700,
    leftSidebarOpen: true,
    leftSidebarWidth: 250,
    toolsSheetOpen: false,
    toolsSheetWidth: 0,
  });
  assert.equal(next, CHAT_MIN_WIDTH);
});
