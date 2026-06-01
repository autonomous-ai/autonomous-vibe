import assert from "node:assert/strict";
import test from "node:test";

import {
  cloneThemePresetSettings,
  DEFAULT_FLOOR_GRID_SETTINGS,
  DEFAULT_THEME_PRESET_ID,
  DEFAULT_THEME_SETTINGS,
  getThemePresetIdForSettings,
  inferThemeSettingsSceneTone,
  MAX_FLOOR_GRID_DENSITY,
  THEME_COLOR_MODES,
  THEME_FLOOR_MODES,
  THEME_PRESETS,
  MAX_THEME_FILL_COLORS,
  normalizeThemeFillColors,
  normalizeThemeSettings,
  resolveThemeFillColor,
  resolveThemeSettingsForColorMode,
  resolveThemeSettingsDisplayEdgeSettings,
  resolveSystemThemePresetId,
  themeSettingsSupportsSystemColorMode
} from "./themeSettings.js";

const WORKBENCH_FILL_COLORS = Object.freeze([
  "#b6c4ce",
  "#f4a7a7",
  "#f8c77e",
  "#f7e38d",
  "#b9e88f",
  "#8fe3c0",
  "#92d7f5",
  "#a9b8ff",
  "#c7a8ff",
  "#f2a7d9"
]);

const BLUE_FILL_COLORS = Object.freeze(["#4cc9f0"]);
const MAGENTA_FILL_COLORS = Object.freeze(["#ff4faf"]);
const CLAY_FILL_COLORS = Object.freeze(["#b9856e"]);
const BEACH_FILL_COLORS = Object.freeze(["#178f9f", "#ef7459"]);
const TERMINAL_FILL_COLORS = Object.freeze(["#0b7a3f"]);
const DARKOAL_FILL_COLORS = Object.freeze([
  "#b6c4ce",
  "#c2a1a5",
  "#e6d1af",
  "#b0ab85",
  "#91ae86",
  "#7cab9f",
  "#7da5b9",
  "#8996be",
  "#988ebe",
  "#ad8dab"
]);

test("theme presets expose a default material color", () => {
  const blue = cloneThemePresetSettings("blue");
  const pink = cloneThemePresetSettings("pink");

  assert.equal(THEME_PRESETS.find((preset) => preset.id === "pink")?.label, "Magenta");
  assert.equal(blue.materials.defaultColor, "#4cc9f0");
  assert.deepEqual(blue.materials.fillColors, BLUE_FILL_COLORS);
  assert.equal(blue.materials.cycleColors, false);
  assert.equal(resolveThemeFillColor(blue.materials, 3), "#4cc9f0");
  assert.equal(pink.materials.defaultColor, "#ff4faf");
  assert.deepEqual(pink.materials.fillColors, MAGENTA_FILL_COLORS);
  assert.equal(pink.materials.cycleColors, false);
  assert.equal(resolveThemeFillColor(pink.materials, 3), "#ff4faf");
  assert.equal(getThemePresetIdForSettings(blue), "blue");
  assert.equal(getThemePresetIdForSettings(pink), "pink");
});

test("workbench is the default system-aware theme preset", () => {
  assert.equal(DEFAULT_THEME_PRESET_ID, "workbench");
  assert.equal(THEME_PRESETS[0]?.id, "workbench");
  assert.equal(THEME_PRESETS[0]?.label, "Workbench");
  assert.equal(getThemePresetIdForSettings(DEFAULT_THEME_SETTINGS), "workbench");
  assert.deepEqual(cloneThemePresetSettings("cinematic"), cloneThemePresetSettings("workbench"));
  assert.deepEqual(cloneThemePresetSettings("light"), cloneThemePresetSettings("workbench"));
  assert.deepEqual(cloneThemePresetSettings("dark"), cloneThemePresetSettings("workbench"));
});

test("workbench preset uses neutral material treatment while preserving source colors", () => {
  const cinematic = cloneThemePresetSettings("workbench");

  assert.equal(cinematic.colorMode, THEME_COLOR_MODES.SYSTEM);
  assert.equal(cinematic.materials.defaultColor, "#b6c4ce");
  assert.deepEqual(cinematic.materials.fillColors, WORKBENCH_FILL_COLORS);
  assert.equal(cinematic.materials.cycleColors, false);
  assert.equal(resolveThemeFillColor(cinematic.materials, 3), "#b6c4ce");
  assert.equal(cinematic.materials.overrideSourceColors, false);
  assert.equal(cinematic.materials.tintMode, "blend");
  assert.equal(cinematic.materials.tintStrength, 0);
  assert.equal(cinematic.materials.saturation, 1.18);
  assert.equal(cinematic.materials.contrast, 1.12);
  assert.equal(cinematic.materials.brightness, 1.02);
  assert.equal(cinematic.materials.roughness, 0.58);
  assert.equal(cinematic.materials.clearcoat, 0.12);
  assert.equal(cinematic.materials.opacity, 1);
  assert.equal(cinematic.materials.envMapIntensity, 0.42);
  assert.equal(cinematic.materials.emissiveIntensity, 0.02);
  assert.equal(cinematic.edges.enabled, true);
  assert.equal(cinematic.edges.contrastMode, "manual");
  assert.equal(cinematic.edges.color, "#132232");
  assert.equal(Object.hasOwn(cinematic.edges, "opacity"), false);
  assert.equal(cinematic.edges.thickness, 1);
  assert.deepEqual(cinematic.edges.classes, {
    feature: { opacity: 1, thickness: 1.15 },
    tangent: { opacity: 0.5, thickness: 1.15 },
    seam: { opacity: 0.85, thickness: 1.15 },
    degenerate: { opacity: 1, thickness: 0 }
  });
  assert.equal(cinematic.edges.highlightColor, "#8dc5ff");
  assert.equal(cinematic.edges.highlightOpacity, 1);
  assert.equal(cinematic.edges.highlightThickness, 3);
  assert.equal(cinematic.edges.silhouette, false);
  assert.equal(cinematic.environment.enabled, false);
  assert.equal(cinematic.environment.intensity, 0.32);
  assert.equal(cinematic.background.type, "solid");
  assert.equal(cinematic.background.solidColor, "#fbfdff");
  assert.equal(cinematic.background.linearStart, "#fbfdff");
  assert.equal(cinematic.background.linearEnd, "#fbfdff");
  assert.equal(cinematic.floor.reflectivity, 0.14);
  assert.equal(cinematic.lighting.toneMappingExposure, 1.16);
  assert.equal(cinematic.lighting.ambient.intensity, 0.4);
  assert.equal(cinematic.lighting.hemisphere.intensity, 1.12);
  assert.equal(cinematic.modeColors.light.background.linearStart, "#fbfdff");
  assert.equal(cinematic.modeColors.dark.background.linearStart, "#212e3c");
  assert.equal(cinematic.modeColors.dark.floor.color, "#111d29");
});

test("studio showroom preset exposes realistic studio settings", () => {
  const studio = cloneThemePresetSettings("studio-showroom");
  const studioPreset = THEME_PRESETS.find((preset) => preset.id === "studio-showroom");

  assert.equal(studioPreset?.label, "Studio");
  assert.equal(studio.colorMode, THEME_COLOR_MODES.SYSTEM);
  assert.equal(studio.materials.defaultColor, "#b6c4ce");
  assert.deepEqual(studio.materials.fillColors, WORKBENCH_FILL_COLORS);
  assert.equal(studio.materials.cycleColors, false);
  assert.equal(resolveThemeFillColor(studio.materials, 4), "#b6c4ce");
  assert.equal(studio.materials.overrideSourceColors, false);
  assert.equal(studio.materials.tintStrength, 0);
  assert.equal(studio.materials.roughness, 0.82);
  assert.equal(studio.materials.metalness, 0);
  assert.equal(studio.materials.clearcoat, 0.02);
  assert.equal(studio.materials.envMapIntensity, 0.55);
  assert.equal(studio.environment.enabled, true);
  assert.equal(studio.environment.presetId, "studio-hdri-41");
  assert.equal(studio.environment.intensity, 0.85);
  assert.equal(studio.floor.mode, "stage");
  assert.equal(studio.floor.reflectivity, 0.22);
  assert.equal(studio.edges.enabled, false);
  assert.equal(studio.edges.contrastMode, "manual");
  assert.equal(studio.edges.color, "#132232");
  assert.equal(studio.lighting.directional.intensity, 1.55);
  assert.equal(inferThemeSettingsSceneTone(studio), "light");
  assert.equal(inferThemeSettingsSceneTone(studio, { prefersDark: true }), "dark");
  assert.equal(studio.modeColors.dark.background.linearStart, "#212e3c");
  assert.equal(studio.modeColors.dark.floor.color, "#111d29");
  assert.equal(getThemePresetIdForSettings(studio), "studio-showroom");
});

test("workbench dark color mode uses the darkoal color treatment", () => {
  const workbench = cloneThemePresetSettings("workbench");
  const dark = resolveThemeSettingsForColorMode(workbench, { prefersDark: true });

  assert.equal(THEME_PRESETS.some((preset) => preset.id === "dark"), false);
  assert.equal(dark.colorMode, THEME_COLOR_MODES.DARK);
  assert.equal(dark.materials.defaultColor, "#b6c4ce");
  assert.deepEqual(dark.materials.fillColors, WORKBENCH_FILL_COLORS);
  assert.equal(dark.materials.cycleColors, false);
  assert.equal(resolveThemeFillColor(dark.materials, 3), "#b6c4ce");
  assert.equal(dark.materials.tintMode, "blend");
  assert.equal(dark.materials.tintStrength, 0);
  assert.equal(dark.materials.saturation, 1.18);
  assert.equal(dark.materials.contrast, 1.12);
  assert.equal(dark.materials.brightness, 1.02);
  assert.equal(dark.materials.opacity, 1);
  assert.equal(dark.edges.enabled, true);
  assert.equal(dark.edges.contrastMode, "manual");
  assert.equal(dark.edges.color, "#132232");
  assert.equal(Object.hasOwn(dark.edges, "opacity"), false);
  assert.equal(dark.environment.enabled, false);
  assert.equal(dark.environment.intensity, 0.32);
  assert.equal(dark.background.type, "solid");
  assert.equal(dark.background.solidColor, "#0f1922");
  assert.equal(dark.background.linearStart, "#212e3c");
  assert.equal(dark.background.linearEnd, "#05090f");
  assert.equal(dark.background.radialInner, "#243a4d");
  assert.equal(dark.background.radialOuter, "#05090f");
  assert.equal(dark.floor.color, "#111d29");
  assert.equal(dark.floor.roughness, 0.7);
  assert.equal(dark.floor.reflectivity, 0.14);
  assert.equal(dark.floor.shadowOpacity, 0.16);
  assert.equal(dark.floor.horizonBlend, 0.18);
  assert.equal(dark.lighting.toneMappingExposure, 1.16);
  assert.equal(dark.lighting.spot.enabled, true);
  assert.equal(dark.lighting.spot.color, "#70c4ff");
  assert.equal(dark.lighting.spot.intensity, 0.52);
  assert.equal(dark.lighting.point.color, "#9bd0ff");
  assert.equal(dark.lighting.ambient.intensity, 0.4);
  assert.equal(dark.lighting.hemisphere.groundColor, "#020713");
  assert.equal(dark.lighting.hemisphere.intensity, 1.12);
  assert.equal(getThemePresetIdForSettings(workbench), "workbench");
});

test("beach preset keeps light materials with sunlit sand presentation styling", () => {
  const beach = cloneThemePresetSettings("beach");
  const beachPreset = THEME_PRESETS.find((preset) => preset.id === "beach");

  assert.equal(beachPreset?.label, "Beach");
  assert.equal(beach.colorMode, THEME_COLOR_MODES.LIGHT);
  assert.equal(beach.materials.defaultColor, BEACH_FILL_COLORS[0]);
  assert.deepEqual(beach.materials.fillColors, BEACH_FILL_COLORS);
  assert.equal(beach.materials.cycleColors, true);
  assert.equal(resolveThemeFillColor(beach.materials, 0), BEACH_FILL_COLORS[0]);
  assert.equal(resolveThemeFillColor(beach.materials, 1), BEACH_FILL_COLORS[1]);
  assert.equal(beach.materials.overrideSourceColors, false);
  assert.equal(beach.materials.tintMode, "blend");
  assert.equal(beach.materials.tintStrength, 0);
  assert.equal(beach.materials.opacity, 1);
  assert.equal(beach.edges.enabled, false);
  assert.equal(beach.edges.contrastMode, "manual");
  assert.equal(beach.edges.color, "#132232");
  assert.equal(beach.background.type, "linear");
  assert.equal(beach.background.solidColor, "#dff7f7");
  assert.equal(beach.background.linearStart, "#fff4d6");
  assert.equal(beach.background.linearEnd, "#47c5d6");
  assert.equal(beach.floor.mode, "stage");
  assert.equal(beach.floor.color, "#f2d59b");
  assert.equal(beach.floor.reflectivity, 0.18);
  assert.equal(beach.environment.enabled, true);
  assert.equal(beach.environment.presetId, "studio-hdri-12");
  assert.equal(beach.lighting.directional.color, "#fff7df");
  assert.equal(beach.lighting.point.color, "#ffd08a");
  assert.equal(beach.lighting.hemisphere.skyColor, "#bff8ff");
  assert.equal(inferThemeSettingsSceneTone(beach), "light");
  assert.equal(getThemePresetIdForSettings(beach), "beach");
});

test("built-in theme presets omit deprecated edge detail settings", () => {
  for (const preset of THEME_PRESETS) {
    const settings = normalizeThemeSettings(preset.settings);
    assert.equal(Object.hasOwn(settings.edges, "source"), false, `${preset.id} edge source`);
    assert.equal(Object.hasOwn(settings.edges, "topologyFilter"), false, `${preset.id} CAD edge detail`);
    assert.equal(Object.hasOwn(settings.edges, "topologyMinRelevance"), false, `${preset.id} CAD edge relevance`);
    for (const classSettings of Object.values(settings.edges.classes)) {
      assert.equal(Object.hasOwn(classSettings, "enabled"), false, `${preset.id} class enabled flag`);
    }
  }
});

test("legacy edge detail settings are accepted and normalized away", () => {
  const legacyWorkbench = cloneThemePresetSettings("workbench");
  delete legacyWorkbench.edges.source;
  legacyWorkbench.edges.topologyFilter = "feature";
  legacyWorkbench.edges.topologyMinRelevance = 12;
  legacyWorkbench.edges.classes.tangent.enabled = false;
  const normalized = normalizeThemeSettings(legacyWorkbench);

  assert.equal(Object.hasOwn(normalized.edges, "source"), false);
  assert.equal(Object.hasOwn(normalized.edges, "topologyFilter"), false);
  assert.equal(Object.hasOwn(normalized.edges, "topologyMinRelevance"), false);
  assert.equal(Object.hasOwn(normalized.edges.classes.tangent, "enabled"), false);
  assert.equal(normalized.edges.classes.tangent.thickness, 0);
});

test("built-in theme preset ids stay explicit", () => {
  assert.deepEqual(THEME_PRESETS.map((preset) => preset.id), [
    "workbench",
    "studio-showroom",
    "blue",
    "pink",
    "clay-sunrise",
    "beach",
    "terminal"
  ]);
});

test("legacy darkoal and charcoal ids resolve to workbench", () => {
  const workbench = cloneThemePresetSettings("workbench");

  assert.equal(THEME_PRESETS.some((preset) => preset.id === "darkoal"), false);
  assert.equal(THEME_PRESETS.some((preset) => preset.id === "charcoal"), false);
  assert.deepEqual(cloneThemePresetSettings("darkoal"), workbench);
  assert.deepEqual(cloneThemePresetSettings("charcoal"), workbench);
  assert.deepEqual(cloneThemePresetSettings("dark-2"), workbench);
});

test("stylized presets keep their palettes and declare an opinionated color mode", () => {
  const paletteExpectations = [
    {
      presetId: "blue",
      colorMode: THEME_COLOR_MODES.DARK,
      materialColor: BLUE_FILL_COLORS[0],
      fillColors: BLUE_FILL_COLORS,
      cycleColors: false,
      edgesEnabled: false,
      edgeColor: "#132232",
      backgroundColor: "#04131f",
      floorColor: "#06324f"
    },
    {
      presetId: "pink",
      colorMode: THEME_COLOR_MODES.DARK,
      materialColor: MAGENTA_FILL_COLORS[0],
      fillColors: MAGENTA_FILL_COLORS,
      cycleColors: false,
      edgesEnabled: false,
      edgeColor: "#132232",
      backgroundColor: "#281323",
      floorColor: "#4a1833"
    },
    {
      presetId: "clay-sunrise",
      colorMode: THEME_COLOR_MODES.LIGHT,
      materialColor: CLAY_FILL_COLORS[0],
      fillColors: CLAY_FILL_COLORS,
      cycleColors: false,
      edgesEnabled: false,
      edgeColor: "#132232",
      backgroundColor: "#f3eadc",
      floorColor: "#d4a070"
    },
    {
      presetId: "beach",
      colorMode: THEME_COLOR_MODES.LIGHT,
      materialColor: BEACH_FILL_COLORS[0],
      fillColors: BEACH_FILL_COLORS,
      cycleColors: true,
      edgesEnabled: false,
      edgeColor: "#132232",
      backgroundColor: "#dff7f7",
      floorColor: "#f2d59b"
    },
    {
      presetId: "terminal",
      colorMode: THEME_COLOR_MODES.DARK,
      materialColor: TERMINAL_FILL_COLORS[0],
      fillColors: TERMINAL_FILL_COLORS,
      cycleColors: false,
      edgesEnabled: true,
      edgeColor: "#66ff99",
      backgroundColor: "#020403",
      floorColor: "#020403"
    }
  ];

  for (const expectation of paletteExpectations) {
    const settings = cloneThemePresetSettings(expectation.presetId);
    assert.equal(settings.colorMode, expectation.colorMode);
    assert.equal(settings.materials.defaultColor, expectation.materialColor);
    assert.deepEqual(settings.materials.fillColors, expectation.fillColors);
    assert.equal(settings.materials.cycleColors, expectation.cycleColors);
    assert.equal(settings.edges.enabled, expectation.edgesEnabled);
    assert.equal(settings.edges.color, expectation.edgeColor);
    assert.equal(settings.background.solidColor, expectation.backgroundColor);
    assert.equal(settings.floor.color, expectation.floorColor);
    assert.equal(getThemePresetIdForSettings(settings), expectation.presetId);
  }

  const terminal = cloneThemePresetSettings("terminal");
  assert.equal(terminal.edges.highlightColor, "#b7ffc9");
  assert.deepEqual(terminal.edges.classes, {
    feature: { opacity: 1, thickness: 1.15 },
    tangent: { opacity: 0.84, thickness: 0.95 },
    seam: { opacity: 0.92, thickness: 1 },
    degenerate: { opacity: 0.72, thickness: 0.8 }
  });
});

test("fill color normalization keeps up to fifty colors and syncs the default fill", () => {
  assert.deepEqual(normalizeThemeFillColors(["#ABC", "nope", "#123456"], "#ffffff"), ["#aabbcc", "#123456"]);
  assert.deepEqual(normalizeThemeFillColors([], "#abc123"), ["#abc123"]);
  const fillColors = Array.from({ length: MAX_THEME_FILL_COLORS + 1 }, (_, index) => {
    return `#${String(index + 1).padStart(6, "0")}`;
  });

  const normalized = normalizeThemeSettings({
    ...cloneThemePresetSettings("dark"),
    materials: {
      ...cloneThemePresetSettings("dark").materials,
      defaultColor: "#111111",
      fillColors,
      cycleColors: true,
      overrideSourceColors: true
    }
  });

  assert.equal(normalized.materials.defaultColor, "#000001");
  assert.equal(normalized.materials.fillColors.length, MAX_THEME_FILL_COLORS);
  assert.equal(normalized.materials.fillColors.at(-1), "#000050");
  assert.equal(normalized.materials.cycleColors, true);
  assert.equal(normalized.materials.overrideSourceColors, true);
  assert.equal(resolveThemeFillColor(normalized.materials, 51), "#000002");
});

test("floor grid settings normalize as theme-owned controls", () => {
  const normalized = normalizeThemeSettings({
    floor: {
      mode: "grid",
      color: "#101820",
      gridCenter: "#123",
      gridCellColor: "#456789",
      gridOpacity: 2,
      gridDensity: 99
    }
  });

  assert.equal(normalized.floor.mode, THEME_FLOOR_MODES.GRID);
  assert.equal(normalized.floor.gridCenterColor, "#112233");
  assert.equal(normalized.floor.gridCellColor, "#456789");
  assert.equal(normalized.floor.gridOpacity, 1);
  assert.equal(normalized.floor.gridDensity, MAX_FLOOR_GRID_DENSITY);

  const fallback = normalizeThemeSettings({ floor: { color: "#111111" } });
  assert.notEqual(fallback.floor.gridCenterColor, DEFAULT_FLOOR_GRID_SETTINGS.gridCenterColor);
  assert.equal(fallback.floor.gridOpacity, DEFAULT_FLOOR_GRID_SETTINGS.gridOpacity);
});

test("disabled color cycling preserves palettes without rotating fills", () => {
  const normalized = normalizeThemeSettings({
    materials: {
      defaultColor: "#111111",
      fillColors: ["#111111", "#222222", "#333333"],
      cycleColors: false
    }
  });

  assert.deepEqual(normalized.materials.fillColors, ["#111111", "#222222", "#333333"]);
  assert.equal(resolveThemeFillColor(normalized.materials, 0), "#111111");
  assert.equal(resolveThemeFillColor(normalized.materials, 2), "#111111");
});

test("display edge settings keep uniform theme-owned line styles", () => {
  const lightEdges = resolveThemeSettingsDisplayEdgeSettings(cloneThemePresetSettings("light"));
  const darkEdges = resolveThemeSettingsDisplayEdgeSettings(cloneThemePresetSettings("dark"));
  const darkSurfaceEdges = resolveThemeSettingsDisplayEdgeSettings({
    ...cloneThemePresetSettings("dark"),
    materials: {
      ...cloneThemePresetSettings("dark").materials,
      defaultColor: "#141821",
      fillColors: ["#141821"]
    }
  });
  const workbenchEdges = resolveThemeSettingsDisplayEdgeSettings(cloneThemePresetSettings("workbench"));

  assert.equal(lightEdges.color, "#132232");
  assert.equal(Object.hasOwn(lightEdges, "opacity"), false);
  assert.equal(lightEdges.thickness, 1);
  assert.equal(darkEdges.color, "#132232");
  assert.equal(Object.hasOwn(darkEdges, "opacity"), false);
  assert.equal(darkEdges.thickness, 1);
  assert.equal(darkSurfaceEdges.color, "#132232");
  assert.equal(Object.hasOwn(darkSurfaceEdges, "opacity"), false);
  assert.equal(workbenchEdges.contrastMode, "manual");
  assert.equal(workbenchEdges.color, "#132232");
  assert.equal(Object.hasOwn(workbenchEdges, "opacity"), false);
  assert.equal(workbenchEdges.thickness, 1);
  assert.equal(workbenchEdges.classes.feature.thickness, 1.15);
  assert.equal(workbenchEdges.classes.tangent.thickness, 1.15);
  assert.equal(workbenchEdges.classes.tangent.opacity, 0.5);
  assert.equal(workbenchEdges.classes.seam.thickness, 1.15);
  assert.equal(workbenchEdges.classes.seam.opacity, 0.85);
  assert.equal(workbenchEdges.classes.degenerate.thickness, 0);
  assert.equal(workbenchEdges.highlightColor, "#8dc5ff");
  assert.equal(workbenchEdges.highlightThickness, 3);
});

test("system theme preset stays on the workbench preset", () => {
  assert.equal(resolveSystemThemePresetId({ prefersDark: false }), "workbench");
  assert.equal(resolveSystemThemePresetId({ prefersDark: true }), "workbench");
});

test("scene tone is inferred from the active floor color", () => {
  assert.equal(inferThemeSettingsSceneTone(cloneThemePresetSettings("workbench")), "light");
  assert.equal(inferThemeSettingsSceneTone(cloneThemePresetSettings("workbench"), { prefersDark: true }), "dark");
  assert.equal(inferThemeSettingsSceneTone(cloneThemePresetSettings("charcoal"), { prefersDark: true }), "dark");
  assert.equal(inferThemeSettingsSceneTone(cloneThemePresetSettings("blue")), "dark");
  assert.equal(inferThemeSettingsSceneTone(cloneThemePresetSettings("clay-sunrise")), "light");
  assert.equal(inferThemeSettingsSceneTone({
    ...cloneThemePresetSettings("workbench"),
    colorMode: THEME_COLOR_MODES.LIGHT,
    background: {
      ...cloneThemePresetSettings("workbench").background,
      type: "solid",
      solidColor: "#f8fafc"
    }
  }), "light");
  assert.equal(inferThemeSettingsSceneTone({
    ...cloneThemePresetSettings("workbench"),
    colorMode: THEME_COLOR_MODES.LIGHT,
    background: {
      ...cloneThemePresetSettings("workbench").background,
      type: "solid",
      solidColor: "#030914"
    },
    floor: {
      ...cloneThemePresetSettings("workbench").floor,
      color: "#f8fafc"
    }
  }), "light");
});

test("system color mode support is exposed only for system-aware themes", () => {
  assert.equal(themeSettingsSupportsSystemColorMode(cloneThemePresetSettings("workbench")), true);
  assert.equal(themeSettingsSupportsSystemColorMode(cloneThemePresetSettings("studio-showroom")), true);
  assert.equal(themeSettingsSupportsSystemColorMode(cloneThemePresetSettings("blue")), false);
  assert.equal(themeSettingsSupportsSystemColorMode(cloneThemePresetSettings("terminal")), false);
});

test("normalizeThemeSettings migrates legacy tint color into default color", () => {
  const normalized = normalizeThemeSettings({
    materials: {
      tintColor: "#abc123"
    }
  });

  assert.equal(normalized.materials.defaultColor, "#abc123");
  assert.equal(Object.hasOwn(normalized.materials, "tintColor"), false);
});

test("normalizeThemeSettings migrates persisted legacy cinematic preset values", () => {
  const legacyCinematic = cloneThemePresetSettings("cinematic");
  delete legacyCinematic.colorMode;
  delete legacyCinematic.modeColors;
  delete legacyCinematic.materials.fillColors;
  delete legacyCinematic.materials.overrideSourceColors;
  delete legacyCinematic.materials.tintMode;
  delete legacyCinematic.materials.emissiveIntensity;
  legacyCinematic.materials.defaultColor = "#aeb9c3";
  legacyCinematic.materials.tintStrength = 0.28;
  legacyCinematic.materials.saturation = 0.42;
  legacyCinematic.materials.contrast = 1.02;
  legacyCinematic.materials.brightness = 0.94;
  legacyCinematic.materials.roughness = 0.46;
  legacyCinematic.materials.metalness = 0.02;
  legacyCinematic.materials.clearcoat = 0.18;
  legacyCinematic.materials.clearcoatRoughness = 0.34;
  legacyCinematic.materials.opacity = 1;
  legacyCinematic.materials.envMapIntensity = 0.58;
  legacyCinematic.edges.enabled = false;
  legacyCinematic.edges.color = "#8fa1b5";
  legacyCinematic.edges.opacity = 0.1;
  legacyCinematic.edges.thickness = 1;
  legacyCinematic.background.solidColor = "#050711";
  legacyCinematic.background.linearStart = "#02040b";
  legacyCinematic.background.linearEnd = "#252f47";
  legacyCinematic.background.linearAngle = 90;
  legacyCinematic.background.radialInner = "#171d30";
  legacyCinematic.background.radialOuter = "#02040b";
  legacyCinematic.floor.color = "#141a29";
  legacyCinematic.floor.roughness = 0.62;
  legacyCinematic.floor.reflectivity = 0.22;
  legacyCinematic.floor.shadowOpacity = 0.24;
  legacyCinematic.floor.horizonBlend = 0.28;
  legacyCinematic.environment.enabled = true;
  legacyCinematic.environment.intensity = 0.46;
  legacyCinematic.environment.rotationY = -0.35;
  legacyCinematic.lighting.toneMappingExposure = 1.2;
  legacyCinematic.lighting.directional.color = "#f1f6fb";
  legacyCinematic.lighting.directional.intensity = 2.45;
  legacyCinematic.lighting.directional.position = { x: -190, y: 300, z: 210 };
  legacyCinematic.lighting.spot.color = "#dbeafe";
  legacyCinematic.lighting.spot.intensity = 1.34;
  legacyCinematic.lighting.spot.angle = 0.72;
  legacyCinematic.lighting.spot.position = { x: 160, y: 245, z: 126 };
  legacyCinematic.lighting.point.color = "#8fb6d8";
  legacyCinematic.lighting.point.intensity = 0.34;
  legacyCinematic.lighting.point.position = { x: -260, y: 95, z: -220 };
  legacyCinematic.lighting.ambient.color = "#1e293b";
  legacyCinematic.lighting.ambient.intensity = 0.2;
  legacyCinematic.lighting.hemisphere.skyColor = "#dbe7f3";
  legacyCinematic.lighting.hemisphere.groundColor = "#070a14";
  legacyCinematic.lighting.hemisphere.intensity = 0.68;

  assert.deepEqual(normalizeThemeSettings(legacyCinematic), cloneThemePresetSettings("workbench"));
});

test("normalizeThemeSettings migrates previous cinematic preset values", () => {
  const transitionalCinematic = cloneThemePresetSettings("cinematic");
  delete transitionalCinematic.colorMode;
  delete transitionalCinematic.modeColors;
  delete transitionalCinematic.materials.fillColors;
  delete transitionalCinematic.materials.overrideSourceColors;
  transitionalCinematic.materials.defaultColor = "#aeb9c3";
  transitionalCinematic.materials.tintStrength = 0.08;
  transitionalCinematic.materials.saturation = 1;
  transitionalCinematic.materials.contrast = 1.04;
  transitionalCinematic.materials.brightness = 1.02;
  transitionalCinematic.materials.roughness = 0.46;
  transitionalCinematic.materials.metalness = 0.02;
  transitionalCinematic.materials.clearcoat = 0.18;
  transitionalCinematic.materials.clearcoatRoughness = 0.34;
  transitionalCinematic.materials.opacity = 1;
  transitionalCinematic.materials.envMapIntensity = 0.58;
  transitionalCinematic.materials.emissiveIntensity = 0.06;
  transitionalCinematic.edges.enabled = true;
  transitionalCinematic.edges.color = "#8fa1b5";
  transitionalCinematic.edges.opacity = 1;
  transitionalCinematic.edges.thickness = 1.65;
  transitionalCinematic.background.solidColor = "#050711";
  transitionalCinematic.background.linearStart = "#02040b";
  transitionalCinematic.background.linearEnd = "#252f47";
  transitionalCinematic.background.linearAngle = 90;
  transitionalCinematic.background.radialInner = "#171d30";
  transitionalCinematic.background.radialOuter = "#02040b";
  transitionalCinematic.floor.color = "#141a29";
  transitionalCinematic.floor.roughness = 0.62;
  transitionalCinematic.floor.reflectivity = 0.06;
  transitionalCinematic.floor.shadowOpacity = 0.24;
  transitionalCinematic.floor.horizonBlend = 0.12;
  transitionalCinematic.lighting.toneMappingExposure = 1.2;
  transitionalCinematic.lighting.directional.color = "#f1f6fb";
  transitionalCinematic.lighting.directional.intensity = 2.45;
  transitionalCinematic.lighting.directional.position = { x: -190, y: 300, z: 210 };
  transitionalCinematic.lighting.spot.color = "#dbeafe";
  transitionalCinematic.lighting.spot.intensity = 1.34;
  transitionalCinematic.lighting.spot.angle = 0.72;
  transitionalCinematic.lighting.spot.position = { x: 160, y: 245, z: 126 };
  transitionalCinematic.lighting.point.color = "#8fb6d8";
  transitionalCinematic.lighting.point.intensity = 0.34;
  transitionalCinematic.lighting.point.position = { x: -260, y: 95, z: -220 };
  transitionalCinematic.lighting.ambient.color = "#1e293b";
  transitionalCinematic.lighting.ambient.intensity = 0.2;
  transitionalCinematic.lighting.hemisphere.skyColor = "#dbe7f3";
  transitionalCinematic.lighting.hemisphere.groundColor = "#070a14";
  transitionalCinematic.lighting.hemisphere.intensity = 0.68;

  assert.deepEqual(normalizeThemeSettings(transitionalCinematic), cloneThemePresetSettings("workbench"));
});

test("normalizeThemeSettings migrates dim cinematic preset values", () => {
  const dimCinematic = cloneThemePresetSettings("cinematic");
  delete dimCinematic.colorMode;
  delete dimCinematic.modeColors;
  delete dimCinematic.materials.fillColors;
  delete dimCinematic.materials.overrideSourceColors;
  dimCinematic.materials.defaultColor = "#aeb9c3";
  dimCinematic.materials.tintMode = "blend";
  dimCinematic.materials.tintStrength = 0;
  dimCinematic.materials.saturation = 1.34;
  dimCinematic.materials.contrast = 1.02;
  dimCinematic.materials.brightness = 0.82;
  dimCinematic.materials.roughness = 0.76;
  dimCinematic.materials.metalness = 0;
  dimCinematic.materials.clearcoat = 0;
  dimCinematic.materials.clearcoatRoughness = 0.72;
  dimCinematic.materials.opacity = 1;
  dimCinematic.materials.envMapIntensity = 0.08;
  dimCinematic.materials.emissiveIntensity = 0.01;
  dimCinematic.edges.enabled = false;
  dimCinematic.edges.color = "#8fa1b5";
  dimCinematic.edges.opacity = 0.1;
  dimCinematic.edges.thickness = 1;
  dimCinematic.background.solidColor = "#0a0f18";
  dimCinematic.background.linearStart = "#08111c";
  dimCinematic.background.linearEnd = "#1f2c3d";
  dimCinematic.background.linearAngle = 90;
  dimCinematic.background.radialInner = "#182337";
  dimCinematic.background.radialOuter = "#08111c";
  dimCinematic.floor.color = "#121a24";
  dimCinematic.floor.roughness = 0.86;
  dimCinematic.floor.reflectivity = 0.06;
  dimCinematic.floor.shadowOpacity = 0.24;
  dimCinematic.floor.horizonBlend = 0.28;
  dimCinematic.environment.enabled = false;
  dimCinematic.environment.intensity = 0;
  dimCinematic.environment.rotationY = -0.35;
  dimCinematic.lighting.toneMappingExposure = 1.03;
  dimCinematic.lighting.directional.color = "#f1f6fb";
  dimCinematic.lighting.directional.intensity = 1.28;
  dimCinematic.lighting.directional.position = { x: -190, y: 300, z: 210 };
  dimCinematic.lighting.spot.color = "#dbeafe";
  dimCinematic.lighting.spot.intensity = 0.18;
  dimCinematic.lighting.spot.angle = 0.72;
  dimCinematic.lighting.spot.position = { x: 160, y: 245, z: 126 };
  dimCinematic.lighting.point.color = "#8fb6d8";
  dimCinematic.lighting.point.intensity = 0.08;
  dimCinematic.lighting.point.position = { x: -260, y: 95, z: -220 };
  dimCinematic.lighting.ambient.color = "#1e293b";
  dimCinematic.lighting.ambient.intensity = 0.42;
  dimCinematic.lighting.hemisphere.skyColor = "#dbe7f3";
  dimCinematic.lighting.hemisphere.groundColor = "#070a14";
  dimCinematic.lighting.hemisphere.intensity = 0.92;

  assert.deepEqual(normalizeThemeSettings(dimCinematic), cloneThemePresetSettings("workbench"));
});

test("normalizeThemeSettings preserves non-cinematic legacy material defaults", () => {
  const legacyWorkbench = cloneThemePresetSettings("workbench");
  delete legacyWorkbench.materials.tintMode;
  delete legacyWorkbench.materials.emissiveIntensity;
  const normalized = normalizeThemeSettings(legacyWorkbench);

  assert.equal(normalized.materials.tintMode, "multiply");
  assert.equal(normalized.materials.emissiveIntensity, 0);
  assert.notDeepEqual(normalized, cloneThemePresetSettings("workbench"));
});

test("only workbench and terminal render CAD edges by default", () => {
  assert.equal(THEME_PRESETS.find((preset) => preset.id === "clay-sunrise")?.label, "Clay");

  for (const preset of THEME_PRESETS) {
    assert.equal(
      preset.settings.edges.enabled,
      preset.id === "workbench" || preset.id === "terminal",
      `${preset.id} edge default`
    );
    assert.equal(
      preset.settings.edges.color,
      preset.id === "terminal" ? "#66ff99" : "#132232",
      `${preset.id} edge color`
    );
  }
});

test("built-in theme presets preserve source colors by default", () => {
  for (const preset of THEME_PRESETS) {
    assert.equal(
      preset.settings.materials.overrideSourceColors,
      false,
      `${preset.id} source color override default`
    );
  }
});
