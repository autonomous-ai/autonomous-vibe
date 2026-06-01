import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildStepModuleParamsCopyText,
  parseStepModuleParamsPasteText,
  resolveStepModuleNumberControlStep
} from "./stepModuleParameterControls.js";
import { normalizeStepModuleDefinition } from "cadjs/common/stepModule.js";

const definition = normalizeStepModuleDefinition({
  parameters: {
    frame: { type: "number", min: 0, max: 150, step: 1, default: 0 },
    lift: { type: "number", min: 0, max: 1, step: 0.01, default: 0 },
    enabled: { type: "boolean", default: false },
    color: { type: "color", default: "#336699" }
  }
});

test("resolveStepModuleNumberControlStep makes coarse STEP module sliders finer", () => {
  assert.equal(resolveStepModuleNumberControlStep(definition.parameterMap.frame), 0.1);
  assert.equal(resolveStepModuleNumberControlStep(definition.parameterMap.lift), 0.001);
});

test("buildStepModuleParamsCopyText emits ordered snapshot-ready JSON", () => {
  assert.equal(
    buildStepModuleParamsCopyText(definition, {
      enabled: true,
      frame: 12.5,
      lift: 0.25,
      color: "#ffffff"
    }),
    `{
  "frame": 12.5,
  "lift": 0.25,
  "enabled": true,
  "color": "#ffffff"
}`
  );
});

test("parseStepModuleParamsPasteText accepts direct and snapshot flag JSON", () => {
  assert.deepEqual(
    parseStepModuleParamsPasteText(definition, '{"frame": 12.75, "enabled": true}'),
    {
      values: { frame: 12.75, enabled: true },
      count: 2
    }
  );
  assert.deepEqual(
    parseStepModuleParamsPasteText(definition, `--params '{"values":{"frame":151,"lift":0.333}}'`),
    {
      values: { frame: 150, lift: 0.333 },
      count: 2
    }
  );
});

test("parseStepModuleParamsPasteText rejects unknown ids", () => {
  assert.throws(
    () => parseStepModuleParamsPasteText(definition, '{"missing": 1}'),
    /Unknown STEP parameter: missing/
  );
});
