import { VIEWER_SCENE_SCALE, getSceneScaleSettings } from "./sceneScale.js";
import {
  BASE_VIEWER_THEME,
  getStageFloorSize
} from "./stageTheme.js";
import {
  DEFAULT_FLOOR_GRID_SETTINGS,
  MAX_FLOOR_GRID_DENSITY,
  MIN_FLOOR_GRID_DENSITY,
  THEME_FLOOR_MODES
} from "../themeSettings.js";

export const DEFAULT_GRID_DIVISIONS = 28;
export const GRID_TARGET_DIVISIONS = 40;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeGridDensity(value) {
  const density = Number(value);
  return Number.isFinite(density)
    ? clamp(density, MIN_FLOOR_GRID_DENSITY, MAX_FLOOR_GRID_DENSITY)
    : DEFAULT_FLOOR_GRID_SETTINGS.gridDensity;
}

function resolveGridStyle(viewerTheme = {}, floorSettings = {}) {
  return {
    centerColor: floorSettings?.gridCenterColor
      || floorSettings?.gridCenter
      || viewerTheme?.gridCenter
      || BASE_VIEWER_THEME.gridCenter,
    cellColor: floorSettings?.gridCellColor
      || floorSettings?.gridCell
      || viewerTheme?.gridCell
      || BASE_VIEWER_THEME.gridCell,
    opacity: Number.isFinite(Number(floorSettings?.gridOpacity))
      ? clamp(Number(floorSettings.gridOpacity), 0, 1)
      : (viewerTheme?.gridOpacity ?? BASE_VIEWER_THEME.gridOpacity)
  };
}

export function niceGridStep(minimumStep) {
  if (!Number.isFinite(minimumStep) || minimumStep <= 0) {
    return getSceneScaleSettings(VIEWER_SCENE_SCALE.CAD).minGridSize / DEFAULT_GRID_DIVISIONS;
  }
  const exponent = Math.floor(Math.log10(minimumStep));
  const base = 10 ** exponent;
  for (const multiplier of [1, 2, 5, 10]) {
    const step = base * multiplier;
    if (step >= minimumStep) {
      return step;
    }
  }
  return base * 10;
}

export function buildGridConfig(radius, sceneScaleMode, floorSettings = {}) {
  const desiredSize = getStageFloorSize(radius, sceneScaleMode);
  const gridDensity = normalizeGridDensity(floorSettings?.gridDensity);
  const targetDivisions = GRID_TARGET_DIVISIONS * gridDensity;
  const cellSize = niceGridStep(desiredSize / targetDivisions);
  let divisions = Math.ceil(desiredSize / cellSize);
  if (divisions % 2 !== 0) {
    divisions += 1;
  }
  return {
    size: Math.max(desiredSize, cellSize * divisions),
    divisions: Math.max(DEFAULT_GRID_DIVISIONS, divisions)
  };
}

export function updateGridHelper(
  runtime,
  viewerTheme,
  radius,
  floorZ = 0,
  sceneScaleMode = VIEWER_SCENE_SCALE.CAD,
  floorMode = THEME_FLOOR_MODES.STAGE,
  { disposeSceneObject = () => {}, floorSettings = {} } = {}
) {
  if (!runtime?.THREE || !runtime?.scene) {
    return;
  }
  runtime.gridRadius = radius;
  runtime.gridFloorZ = floorZ;
  runtime.floorMode = floorMode;
  if (floorMode !== THEME_FLOOR_MODES.GRID) {
    disposeSceneObject(runtime.gridHelper);
    runtime.gridHelper = null;
    runtime.gridConfig = null;
    return;
  }
  const nextConfig = {
    ...buildGridConfig(radius, sceneScaleMode, floorSettings),
    ...resolveGridStyle(viewerTheme, floorSettings)
  };
  const currentConfig = runtime.gridConfig;
  if (
    currentConfig &&
    currentConfig.size === nextConfig.size &&
    currentConfig.divisions === nextConfig.divisions &&
    currentConfig.centerColor === nextConfig.centerColor &&
    currentConfig.cellColor === nextConfig.cellColor &&
    currentConfig.opacity === nextConfig.opacity
  ) {
    if (runtime.gridHelper) {
      runtime.gridHelper.rotation.x = Math.PI / 2;
    }
    runtime.gridHelper?.position.set(0, 0, floorZ);
    return;
  }

  disposeSceneObject(runtime.gridHelper);
  runtime.gridHelper = new runtime.THREE.GridHelper(
    nextConfig.size,
    nextConfig.divisions,
    nextConfig.centerColor,
    nextConfig.cellColor
  );
  const materials = Array.isArray(runtime.gridHelper.material)
    ? runtime.gridHelper.material
    : [runtime.gridHelper.material];
  for (const material of materials) {
    material.transparent = true;
    material.opacity = nextConfig.opacity;
    material.depthWrite = false;
    material.toneMapped = false;
  }
  runtime.gridHelper.rotation.x = Math.PI / 2;
  runtime.gridHelper.position.set(0, 0, floorZ);
  runtime.scene.add(runtime.gridHelper);
  runtime.gridConfig = nextConfig;
}
