import assert from "node:assert/strict";
import test from "node:test";

import {
  extractFeature,
  featureAnchor,
  measureFeatureIntrinsic,
  measureFeaturePair
} from "./rulerFeatures.js";

function planeRef(point, normal) {
  return { selectorType: "face", pickData: { surfaceType: "plane", center: point, normal, params: { origin: point, axis: normal } } };
}

function cylinderRef(origin, axis, radius) {
  return { selectorType: "face", pickData: { surfaceType: "cylinder", center: origin, params: { origin, axis, radius } } };
}

function circleRef(center, axis, radius) {
  return { selectorType: "edge", pickData: { params: { center, axis, radius } } };
}

// flat [x,y,z,x,y,z,...] segment-pair polyline
function linePolyline(a, b) {
  return new Float32Array([...a, ...b]);
}

test("extractFeature reads a plane face", () => {
  const f = extractFeature(planeRef([0, 0, 5], [0, 0, 1]));
  assert.equal(f.kind, "plane");
  assert.deepEqual(f.normal, [0, 0, 1]);
  assert.deepEqual(featureAnchor(f), [0, 0, 5]);
});

test("extractFeature reads a cylinder face", () => {
  const f = extractFeature(cylinderRef([1, 0, 0], [0, 0, 2], 3));
  assert.equal(f.kind, "cylinder");
  assert.deepEqual(f.axis, [0, 0, 1]);
  assert.equal(f.radius, 3);
});

test("extractFeature classifies a circular edge via params.radius", () => {
  const f = extractFeature(circleRef([0, 0, 0], [0, 0, 1], 4), linePolyline([4, 0, 0], [0, 4, 0]));
  assert.equal(f.kind, "circle");
  assert.equal(f.radius, 4);
});

test("extractFeature builds a line edge from the proxy polyline", () => {
  const f = extractFeature({ selectorType: "edge", pickData: { params: {} } }, linePolyline([0, 0, 0], [10, 0, 0]));
  assert.equal(f.kind, "line");
  assert.equal(f.length, 10);
  assert.deepEqual(f.dir, [1, 0, 0]);
});

test("plane/plane perpendicular planes measure 90°", () => {
  const result = measureFeaturePair(
    extractFeature(planeRef([0, 0, 0], [0, 0, 1])),
    extractFeature(planeRef([0, 0, 0], [1, 0, 0]))
  );
  assert.equal(result.tool, "angle");
  assert.ok(Math.abs(result.value - 90) < 1e-6);
});

test("parallel planes measure perpendicular distance", () => {
  const result = measureFeaturePair(
    extractFeature(planeRef([0, 0, 0], [0, 0, 1])),
    extractFeature(planeRef([3, 7, 10], [0, 0, 1]))
  );
  assert.equal(result.tool, "distance");
  assert.ok(Math.abs(result.value - 10) < 1e-6);
});

test("line/line angle", () => {
  const result = measureFeaturePair(
    extractFeature({ selectorType: "edge", pickData: { params: {} } }, linePolyline([0, 0, 0], [1, 0, 0])),
    extractFeature({ selectorType: "edge", pickData: { params: {} } }, linePolyline([0, 0, 0], [0, 1, 0]))
  );
  assert.equal(result.tool, "angle");
  assert.ok(Math.abs(result.value - 90) < 1e-6);
});

test("line/plane angle is measured against the plane", () => {
  const result = measureFeaturePair(
    extractFeature({ selectorType: "edge", pickData: { params: {} } }, linePolyline([0, 0, 0], [0, 0, 1])),
    extractFeature(planeRef([0, 0, 0], [0, 0, 1]))
  );
  assert.equal(result.tool, "angle");
  assert.ok(Math.abs(result.value - 90) < 1e-6); // line along the plane normal → 90° to the plane
});

test("intrinsic: circular edge yields diameter with a diameter segment", () => {
  const result = measureFeatureIntrinsic(extractFeature(circleRef([0, 0, 0], [0, 0, 1], 5)));
  assert.equal(result.tool, "diameter");
  assert.equal(result.value, 10);
  assert.equal(result.points.length, 2);
  assert.ok(Math.abs(result.points[0][2]) < 1e-9); // segment lies in the plane perpendicular to the axis
});

test("intrinsic: line edge yields its length", () => {
  const result = measureFeatureIntrinsic(
    extractFeature({ selectorType: "edge", pickData: { params: {} } }, linePolyline([0, 0, 0], [0, 3, 4]))
  );
  assert.equal(result.tool, "distance");
  assert.equal(result.value, 5);
});
