import assert from "node:assert/strict";
import test from "node:test";

import {
  angleAtVertex,
  boundingBoxDims,
  convertUnit,
  diameterFromSurface,
  distanceWithDeltas,
  formatAngle,
  formatLength,
  nearestVertex,
  unitLabel,
  wallThickness
} from "./rulerGeometry.js";

test("distanceWithDeltas returns span and absolute axis extents", () => {
  const result = distanceWithDeltas([1, 2, 3], [4, 6, 3]);
  assert.equal(result.distance, 5);
  assert.equal(result.dx, 3);
  assert.equal(result.dy, 4);
  assert.equal(result.dz, 0);
});

test("distanceWithDeltas tolerates malformed input", () => {
  const result = distanceWithDeltas(null, [3, 0, 0]);
  assert.equal(result.distance, 3);
  assert.equal(result.dx, 3);
});

test("angleAtVertex measures the angle at the middle point", () => {
  assert.equal(angleAtVertex([1, 0, 0], [0, 0, 0], [0, 1, 0]), 90);
  assert.ok(Math.abs(angleAtVertex([1, 0, 0], [0, 0, 0], [-1, 0, 0]) - 180) < 1e-9);
  assert.equal(angleAtVertex([1, 0, 0], [0, 0, 0], [1, 0, 0]), 0);
});

test("angleAtVertex returns 0 for degenerate input", () => {
  assert.equal(angleAtVertex([0, 0, 0], [0, 0, 0], [1, 0, 0]), 0);
});

test("diameterFromSurface reads cylindrical radius", () => {
  assert.deepEqual(diameterFromSurface({ type: "CYLINDRICAL_SURFACE", radius: 4 }), {
    radius: 4,
    diameter: 8
  });
  assert.equal(diameterFromSurface({ type: "PLANE", radius: 4 }), null);
  assert.equal(diameterFromSurface({ type: "CYLINDRICAL_SURFACE", radius: 0 }), null);
  assert.equal(diameterFromSurface(null), null);
});

test("wallThickness is the entry-to-exit span", () => {
  assert.equal(wallThickness([0, 0, 0], [0, 0, 2.5]), 2.5);
});

test("boundingBoxDims computes dims, center and 8 offset corners", () => {
  const box = boundingBoxDims({ min: [0, 0, 0], max: [10, 20, 30] }, [100, 0, 0]);
  assert.equal(box.width, 10);
  assert.equal(box.depth, 20);
  assert.equal(box.height, 30);
  assert.deepEqual(box.center, [105, 10, 15]);
  assert.equal(box.corners.length, 8);
  assert.deepEqual(box.corners[0], [100, 0, 0]);
  assert.deepEqual(box.corners[7], [110, 20, 30]);
});

test("nearestVertex snaps within the threshold only", () => {
  const candidates = [
    [0, 0, 0],
    [10, 0, 0]
  ];
  assert.deepEqual(nearestVertex([0.4, 0, 0], candidates, 1), [0, 0, 0]);
  assert.equal(nearestVertex([5, 0, 0], candidates, 1), null);
});

test("unit conversion and formatting", () => {
  assert.equal(convertUnit(25.4, "inch"), 1);
  assert.equal(convertUnit(50, "cm"), 5);
  assert.equal(convertUnit(7, "mm"), 7);
  assert.equal(unitLabel("inch"), "in");
  assert.equal(formatLength(25.4, "inch", 2), "1.00 in");
  assert.equal(formatLength(35.421, "mm", 2), "35.42 mm");
  assert.equal(formatAngle(89.95, 1), "90.0°");
});
