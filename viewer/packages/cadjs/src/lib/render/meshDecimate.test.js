import assert from "node:assert/strict";
import test from "node:test";

import { decimateMesh } from "./meshDecimate.js";

// Build a flat grid of `n`×`n` quads in the XY plane → 2*(n-1)^2 triangles.
function buildGridMesh(n) {
  const vertices = [];
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      vertices.push(x, y, 0);
    }
  }
  const indices = [];
  const idx = (x, y) => y * n + x;
  for (let y = 0; y < n - 1; y += 1) {
    for (let x = 0; x < n - 1; x += 1) {
      indices.push(idx(x, y), idx(x + 1, y), idx(x + 1, y + 1));
      indices.push(idx(x, y), idx(x + 1, y + 1), idx(x, y + 1));
    }
  }
  return {
    vertices: new Float32Array(vertices),
    indices: new Uint32Array(indices)
  };
}

test("decimateMesh reduces triangle count for a dense mesh", () => {
  const { vertices, indices } = buildGridMesh(64); // 7938 triangles
  const lod = decimateMesh(vertices, indices, { targetRatio: 0.1 });
  assert.ok(lod.outputTriangles > 0, "produces some triangles");
  assert.ok(
    lod.outputTriangles < lod.inputTriangles,
    `expected fewer triangles, got ${lod.outputTriangles} >= ${lod.inputTriangles}`
  );
  assert.equal(lod.vertices.length % 3, 0);
  assert.equal(lod.indices.length % 3, 0);
  assert.equal(lod.normals.length, lod.vertices.length);
});

test("decimateMesh keeps the proxy within the original bounding box", () => {
  const { vertices, indices } = buildGridMesh(32);
  const lod = decimateMesh(vertices, indices, { targetRatio: 0.2 });
  for (let i = 0; i < lod.vertices.length; i += 3) {
    assert.ok(lod.vertices[i] >= -1e-3 && lod.vertices[i] <= 31 + 1e-3);
    assert.ok(lod.vertices[i + 1] >= -1e-3 && lod.vertices[i + 1] <= 31 + 1e-3);
    assert.ok(Math.abs(lod.vertices[i + 2]) <= 1e-3);
  }
});

test("decimateMesh emits unit-length normals", () => {
  const { vertices, indices } = buildGridMesh(16);
  const lod = decimateMesh(vertices, indices, { targetRatio: 0.3 });
  for (let i = 0; i < lod.normals.length; i += 3) {
    const len = Math.hypot(lod.normals[i], lod.normals[i + 1], lod.normals[i + 2]);
    assert.ok(Math.abs(len - 1) < 1e-3, `normal not unit length: ${len}`);
  }
});

test("decimateMesh handles empty input", () => {
  const lod = decimateMesh(new Float32Array(0), new Uint32Array(0));
  assert.equal(lod.outputTriangles, 0);
  assert.equal(lod.vertices.length, 0);
  assert.equal(lod.indices.length, 0);
});

test("decimateMesh drops degenerate triangles when vertices share a cell", () => {
  // Two triangles whose vertices all fall within one coarse cell collapse away.
  const vertices = new Float32Array([
    0, 0, 0, 0.01, 0, 0, 0, 0.01, 0,
    10, 10, 0, 10.01, 10, 0, 10, 10.01, 0
  ]);
  const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
  const lod = decimateMesh(vertices, indices, { gridResolution: 4 });
  assert.equal(lod.outputTriangles, 0, "tightly-clustered triangles collapse");
});
