import assert from "node:assert/strict";
import { test } from "node:test";

import { isPrintableModelEntry } from "./isPrintableModelEntry.js";

test("isPrintableModelEntry keeps printable parts/models", () => {
  for (const kind of ["stl", "3mf", "glb", "assembly"]) {
    assert.equal(isPrintableModelEntry({ kind }), true, `${kind} should be a model`);
  }
});

test("isPrintableModelEntry hides raw STEP files (users pick parts/models, not files)", () => {
  // A part already shows up as its printable mesh (stl/glb/3mf) or assembly.
  // The raw .step/.stp is the archival B-rep, not something a consumer selects —
  // and selecting one drives the STEP-tree viewer path. Keep it off the rail.
  for (const kind of ["step", "stp"]) {
    assert.equal(isPrintableModelEntry({ kind }), false, `${kind} should be hidden`);
  }
});

test("isPrintableModelEntry hides intermediate / non-printable files", () => {
  for (const kind of ["gcode", "dxf", "urdf", "srdf", "sdf"]) {
    assert.equal(isPrintableModelEntry({ kind }), false, `${kind} should be hidden`);
  }
});

test("isPrintableModelEntry hides source/metadata/preview files", () => {
  // These would otherwise fall through entryIconKind's STEP_PART default and
  // show up as bogus "<file>.step" models in the rail.
  for (const kind of ["py", "json", "png"]) {
    assert.equal(isPrintableModelEntry({ kind }), false, `${kind} should be hidden`);
  }
});

test("isPrintableModelEntry tolerates missing/empty entries", () => {
  assert.equal(isPrintableModelEntry(null), false);
  assert.equal(isPrintableModelEntry(undefined), false);
});
