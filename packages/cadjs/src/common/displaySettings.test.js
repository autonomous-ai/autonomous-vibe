import assert from "node:assert/strict";
import test from "node:test";

import {
  CAD_DISPLAY_MODE,
  DEFAULT_DISPLAY_SETTINGS,
  displaySettingsEqual,
  normalizeDisplaySettings,
  resolveDisplayMode
} from "./displaySettings.js";

test("display settings normalize mode and clip independently from appearance settings", () => {
  assert.deepEqual(normalizeDisplaySettings(), DEFAULT_DISPLAY_SETTINGS);
  assert.equal(resolveDisplayMode({ mode: "wireframe" }), CAD_DISPLAY_MODE.WIREFRAME);
  assert.deepEqual(normalizeDisplaySettings({
    mode: "wireframe",
    clip: {
      enabled: true,
      axis: "z",
      offset: 0.4,
      invert: true
    }
  }), {
    mode: CAD_DISPLAY_MODE.WIREFRAME,
    clip: {
      enabled: true,
      axis: "z",
      offset: 0.4,
      offsets: {
        x: 0,
        y: 0,
        z: 0.4
      },
      invert: true
    }
  });
});

test("display settings compare after normalization", () => {
  assert.equal(displaySettingsEqual(
    { mode: "wireframe", clip: { enabled: true, axis: "x", offset: 0.5 } },
    { mode: CAD_DISPLAY_MODE.WIREFRAME, clip: { enabled: true, axis: "x", offsets: { x: 0.5 } } }
  ), true);
  assert.equal(displaySettingsEqual(
    { mode: "solid", clip: { enabled: true } },
    { mode: "wireframe", clip: { enabled: true } }
  ), false);
});
