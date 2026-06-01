import {
  DEFAULT_STEP_CLIP_SETTINGS,
  normalizeStepClipSettings,
  stepClipSettingsEqual
} from "../lib/viewer/clipPlane.js";

export const CAD_DISPLAY_MODE = Object.freeze({
  SOLID: "solid",
  WIREFRAME: "wireframe"
});

export const DEFAULT_DISPLAY_SETTINGS = Object.freeze({
  mode: CAD_DISPLAY_MODE.SOLID,
  clip: DEFAULT_STEP_CLIP_SETTINGS
});

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeDisplayMode(value) {
  return String(value || "").trim().toLowerCase() === CAD_DISPLAY_MODE.WIREFRAME
    ? CAD_DISPLAY_MODE.WIREFRAME
    : CAD_DISPLAY_MODE.SOLID;
}

export function normalizeDisplaySettings(value = null) {
  const source = isObject(value) ? value : {};
  return {
    mode: normalizeDisplayMode(source.mode),
    clip: normalizeStepClipSettings(source.clip)
  };
}

export function cloneDisplaySettings(value = DEFAULT_DISPLAY_SETTINGS) {
  return normalizeDisplaySettings(value);
}

export function displaySettingsEqual(left, right) {
  const a = normalizeDisplaySettings(left);
  const b = normalizeDisplaySettings(right);
  return a.mode === b.mode && stepClipSettingsEqual(a.clip, b.clip);
}

export function resolveDisplayMode(displaySettings) {
  return normalizeDisplaySettings(displaySettings).mode;
}
