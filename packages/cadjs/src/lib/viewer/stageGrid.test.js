import assert from "node:assert/strict";
import test from "node:test";

import { THEME_FLOOR_MODES } from "../themeSettings.js";
import { VIEWER_SCENE_SCALE, getSceneScaleSettings } from "./sceneScale.js";
import {
  buildGridConfig,
  DEFAULT_GRID_DIVISIONS,
  niceGridStep,
  updateGridHelper
} from "./stageGrid.js";

class FakeGridHelper {
  constructor(size, divisions, centerColor, cellColor) {
    this.size = size;
    this.divisions = divisions;
    this.centerColor = centerColor;
    this.cellColor = cellColor;
    this.material = {};
    this.rotation = { x: 0 };
    this.position = {
      value: null,
      set: (...value) => {
        this.position.value = value;
      }
    };
  }
}

function createRuntime() {
  return {
    THREE: { GridHelper: FakeGridHelper },
    scene: {
      children: [],
      add(object) {
        this.children.push(object);
        object.parent = this;
      }
    }
  };
}

test("stage grid sizing uses nice CAD-scale steps and even divisions", () => {
  assert.equal(niceGridStep(0), getSceneScaleSettings(VIEWER_SCENE_SCALE.CAD).minGridSize / DEFAULT_GRID_DIVISIONS);
  assert.equal(niceGridStep(0.06), 0.1);
  assert.equal(niceGridStep(6), 10);

  const config = buildGridConfig(12, VIEWER_SCENE_SCALE.CAD);
  assert.ok(config.size > 0);
  assert.ok(config.divisions >= DEFAULT_GRID_DIVISIONS);
  assert.equal(config.divisions % 2, 0);
});

test("updateGridHelper creates, reuses, and disposes runtime grid helpers", () => {
  const runtime = createRuntime();
  const disposed = [];
  const disposeSceneObject = (object) => {
    if (object) {
      disposed.push(object);
    }
  };

  updateGridHelper(
    runtime,
    { gridCenter: "#111111", gridCell: "#222222", gridOpacity: 0.42 },
    10,
    -2,
    VIEWER_SCENE_SCALE.CAD,
    THEME_FLOOR_MODES.GRID,
    { disposeSceneObject }
  );

  const firstGrid = runtime.gridHelper;
  assert.ok(firstGrid instanceof FakeGridHelper);
  assert.equal(firstGrid.centerColor, "#111111");
  assert.equal(firstGrid.cellColor, "#222222");
  assert.equal(firstGrid.material.opacity, 0.42);
  assert.deepEqual(firstGrid.position.value, [0, 0, -2]);
  assert.equal(runtime.scene.children[0], firstGrid);

  updateGridHelper(
    runtime,
    { gridCenter: "#111111", gridCell: "#222222", gridOpacity: 0.42 },
    10,
    3,
    VIEWER_SCENE_SCALE.CAD,
    THEME_FLOOR_MODES.GRID,
    { disposeSceneObject }
  );

  assert.equal(runtime.gridHelper, firstGrid);
  assert.deepEqual(firstGrid.position.value, [0, 0, 3]);
  assert.deepEqual(disposed, []);

  updateGridHelper(
    runtime,
    { gridCenter: "#111111", gridCell: "#222222", gridOpacity: 0.42 },
    10,
    4,
    VIEWER_SCENE_SCALE.CAD,
    THEME_FLOOR_MODES.GRID,
    {
      disposeSceneObject,
      floorSettings: {
        gridCenterColor: "#333333",
        gridCellColor: "#444444",
        gridOpacity: 0.5,
        gridDensity: 1.5
      }
    }
  );

  const themedGrid = runtime.gridHelper;
  assert.ok(themedGrid instanceof FakeGridHelper);
  assert.notEqual(themedGrid, firstGrid);
  assert.equal(themedGrid.centerColor, "#333333");
  assert.equal(themedGrid.cellColor, "#444444");
  assert.equal(themedGrid.material.opacity, 0.5);
  assert.ok(themedGrid.divisions > firstGrid.divisions);
  assert.deepEqual(disposed, [firstGrid]);

  updateGridHelper(
    runtime,
    {},
    10,
    0,
    VIEWER_SCENE_SCALE.CAD,
    THEME_FLOOR_MODES.STAGE,
    { disposeSceneObject }
  );

  assert.equal(runtime.gridHelper, null);
  assert.equal(runtime.gridConfig, null);
  assert.deepEqual(disposed, [firstGrid, themedGrid]);
});
