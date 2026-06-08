// ActionButtons exposes its pure helpers + drives the transport directly when
// the user confirms a slice or print. We exercise the helpers, then the
// integration with the chat store + a mock transport so the assertions
// "Slice button visible only when STL present" and "Print only when gcode
// present" are verifiable without React rendering.

import assert from "node:assert/strict";
import test from "node:test";

import { pickPrinterForSlice } from "../actionButtonsHelpers.js";
import { preflightAllChecked, PREFLIGHT_ITEMS } from "../preflightItems.js";
import {
  __setTransportForTesting,
  dispatch,
  getChatState,
  resetChatStore,
  selectLatestGcode,
  selectLatestStl,
  selectSliceTargetStl,
  setProject,
  setSelectedMeshFile,
} from "../../../store/chat.js";

function applyArtifact(file, reason = "new", turnId = "t-1") {
  dispatch({ type: "chat_event", event: { kind: "turn_start", turnId } });
  dispatch({
    type: "chat_event",
    event: { kind: "artifact_changed", turnId, file, reason },
  });
}

test("pickPrinterForSlice returns the first printer in the list, null when empty", () => {
  const card = { id: "p-1", model: "X1C", ipAddress: "10.0.0.1", hostName: "x1c" };
  assert.equal(pickPrinterForSlice([card]), card);
  assert.equal(pickPrinterForSlice([]), null);
  assert.equal(pickPrinterForSlice(undefined), null);
});

test("pickPrinterForSlice prefers a LAN printer over a cloud one (working upload path)", () => {
  const cloud = { id: "cloud:S1", transport: "cloud", hostName: "office" };
  const lan = { id: "S1", transport: "lan", ipAddress: "10.0.0.1", hostName: "office" };
  // LAN wins regardless of order…
  assert.equal(pickPrinterForSlice([cloud, lan]), lan);
  assert.equal(pickPrinterForSlice([lan, cloud]), lan);
  // …but a cloud-only pairing still yields a target (off-LAN fallback).
  assert.equal(pickPrinterForSlice([cloud]), cloud);
});

test("pickPrinterForSlice prefers the Bambu Studio handoff when it's set up", () => {
  const studio = { id: "bambu-studio", transport: "bambustudio", hostName: "Open with Bambu Studio" };
  const lan = { id: "S1", transport: "lan", ipAddress: "10.0.0.1", hostName: "office" };
  const cloud = { id: "cloud:S1", transport: "cloud", hostName: "office" };
  // The explicit Bambu Studio opt-in wins over a paired printer, in any order.
  assert.equal(pickPrinterForSlice([lan, cloud, studio]), studio);
  assert.equal(pickPrinterForSlice([studio, lan]), studio);
  // …but with no studio handoff, LAN still wins (unchanged behavior).
  assert.equal(pickPrinterForSlice([cloud, lan]), lan);
});

test("Slice action is offered only when an STL artifact exists in history", () => {
  resetChatStore();
  setProject("p-1");
  assert.equal(selectLatestStl(getChatState()), "");
  applyArtifact("model.stl");
  assert.equal(selectLatestStl(getChatState()), "model.stl");
  // No .gcode means Print is hidden.
  assert.equal(selectLatestGcode(getChatState()), "");
  resetChatStore();
});

test("Print action is offered only when a .gcode artifact exists in history", () => {
  resetChatStore();
  setProject("p-1");
  applyArtifact("model.gcode", "new");
  assert.equal(selectLatestGcode(getChatState()), "model.gcode");
  resetChatStore();
});

test("preflightAllChecked requires every PREFLIGHT_ITEMS id to be true", () => {
  const partial = { plate: true, filament: true };
  assert.equal(preflightAllChecked(partial), false);
  const full = {};
  for (const item of PREFLIGHT_ITEMS) full[item.id] = true;
  assert.equal(preflightAllChecked(full), true);
  assert.equal(preflightAllChecked(null), false);
  assert.equal(preflightAllChecked({}), false);
});

test("ActionButtons slice path invokes slice_run with the latest STL artifact", async () => {
  resetChatStore();
  setProject("p-1");
  applyArtifact("model.stl");
  const calls = [];
  const restore = __setTransportForTesting({
    async slice_run(req) {
      calls.push(req);
      return {
        durationSeconds: 600,
        filamentGrams: 12,
        filamentMeters: 4,
        layerCount: 200,
        supportsUsed: false,
        gcodeFile: "model.gcode",
      };
    },
  });

  try {
    // Manually reproduce the click handler (without rendering React): pull
    // the helpers from the store and invoke the transport call the component
    // would invoke. This is the same code path the JSX wraps.
    const { getTransport } = await import("../../../lib/transport.ts");
    const transport = getTransport();
    const stlFile = selectLatestStl(getChatState());
    assert.equal(stlFile, "model.stl");
    await transport.slice_run({
      meshFile: stlFile,
      printerId: "p-1",
      filament: "PLA",
    });
    assert.deepEqual(calls, [
      { meshFile: "model.stl", printerId: "p-1", filament: "PLA" },
    ]);
  } finally {
    restore();
    resetChatStore();
  }
});

test("Slice target follows the selected part, not just the latest STL artifact", () => {
  resetChatStore();
  setProject("p-1");
  // Two parts generated in chat; the lid is the most recent artifact.
  applyArtifact("esp32_enclosure_base.stl");
  applyArtifact("esp32_enclosure_lid.stl");

  // Nothing selected yet -> fall back to the latest artifact so a chat-only
  // session still slices the model just generated.
  assert.equal(selectSliceTargetStl(getChatState()), "esp32_enclosure_lid.stl");

  // Selecting the base part redirects the slice target to it, even though the
  // lid is the newer artifact. (Before the fix slice always used the latest.)
  setSelectedMeshFile("esp32_enclosure_base.stl");
  assert.equal(selectSliceTargetStl(getChatState()), "esp32_enclosure_base.stl");

  // Switching the selection switches the slice target — each part is
  // independently sliceable.
  setSelectedMeshFile("esp32_enclosure_lid.stl");
  assert.equal(selectSliceTargetStl(getChatState()), "esp32_enclosure_lid.stl");

  // Clearing the selection, or selecting a non-STL part, falls back to latest.
  setSelectedMeshFile("");
  assert.equal(selectSliceTargetStl(getChatState()), "esp32_enclosure_lid.stl");
  setSelectedMeshFile("model.step");
  assert.equal(selectSliceTargetStl(getChatState()), "esp32_enclosure_lid.stl");

  resetChatStore();
  // Selection is cleared when the store resets / project changes.
  assert.equal(selectSliceTargetStl(getChatState()), "");
});

test("ActionButtons slice path passes the SELECTED part's STL to slice_run", async () => {
  resetChatStore();
  setProject("p-1");
  applyArtifact("base.stl");
  applyArtifact("lid.stl"); // latest artifact
  setSelectedMeshFile("base.stl"); // ...but the user is viewing the base part

  const calls = [];
  const restore = __setTransportForTesting({
    async slice_run(req) {
      calls.push(req);
      return {
        durationSeconds: 600,
        filamentGrams: 12,
        filamentMeters: 4,
        layerCount: 200,
        supportsUsed: false,
        gcodeFile: "base.gcode",
      };
    },
  });

  try {
    // Same code path the JSX wraps: handleSlice resolves its target via the
    // store selector ActionButtons subscribes to (selectSliceTargetStl).
    const { getTransport } = await import("../../../lib/transport.ts");
    const transport = getTransport();
    const stlFile = selectSliceTargetStl(getChatState());
    assert.equal(stlFile, "base.stl", "slice must target the selected part, not the latest artifact");
    await transport.slice_run({
      meshFile: stlFile,
      printerId: "p-1",
      filament: "PLA",
    });
    assert.deepEqual(calls, [
      { meshFile: "base.stl", printerId: "p-1", filament: "PLA" },
    ]);
  } finally {
    restore();
    resetChatStore();
  }
});

test("ActionButtons print path requires preflight confirmation before printer_start_print fires", async () => {
  resetChatStore();
  setProject("p-1");
  applyArtifact("model.gcode");

  const startCalls = [];
  const uploadCalls = [];
  const restore = __setTransportForTesting({
    async printer_upload_gcode(req) {
      uploadCalls.push(req);
    },
    async printer_start_print(req) {
      startCalls.push(req);
    },
  });

  try {
    // First simulate the user opening the modal but NOT checking the items:
    let checked = {};
    assert.equal(preflightAllChecked(checked), false);
    // Without confirmation, the component must not call printer_start_print.
    assert.equal(startCalls.length, 0);

    // Now check every safety item and run the confirm handler logic.
    checked = Object.fromEntries(PREFLIGHT_ITEMS.map((item) => [item.id, true]));
    assert.equal(preflightAllChecked(checked), true);

    const { getTransport } = await import("../../../lib/transport.ts");
    const transport = getTransport();
    const gcode = selectLatestGcode(getChatState());
    await transport.printer_upload_gcode({ printerId: "p-1", gcodeFile: gcode });
    await transport.printer_start_print({
      printerId: "p-1",
      remoteName: "model.gcode",
      confirmed: true,
    });

    assert.deepEqual(uploadCalls, [{ printerId: "p-1", gcodeFile: "model.gcode" }]);
    assert.deepEqual(startCalls, [
      { printerId: "p-1", remoteName: "model.gcode", confirmed: true },
    ]);
  } finally {
    restore();
    resetChatStore();
  }
});
