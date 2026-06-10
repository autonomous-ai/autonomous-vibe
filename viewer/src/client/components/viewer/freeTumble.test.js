import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { applyFreeTumbleRotation } from "./freeTumble.js";

function makeCamera(position, up) {
  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 1000);
  camera.up.set(...up);
  camera.position.set(...position);
  return camera;
}

test("returns false and leaves the camera untouched for a zero drag", () => {
  const camera = makeCamera([0, -10, 0], [0, 0, 1]);
  const before = camera.position.clone();
  const moved = applyFreeTumbleRotation({
    THREE,
    camera,
    target: new THREE.Vector3(0, 0, 0),
    deltaX: 0,
    deltaY: 0,
    viewportHeight: 100
  });
  assert.equal(moved, false);
  assert.ok(camera.position.distanceTo(before) < 1e-9);
});

test("preserves the distance to the target while rotating", () => {
  const target = new THREE.Vector3(3, 3, 3);
  const camera = makeCamera([3, -7, 5], [0, 0, 1]);
  const radiusBefore = camera.position.distanceTo(target);
  applyFreeTumbleRotation({ THREE, camera, target, deltaX: 23, deltaY: -11, viewportHeight: 140 });
  const radiusAfter = camera.position.distanceTo(target);
  assert.ok(Math.abs(radiusAfter - radiusBefore) < 1e-9, `radius drifted: ${radiusBefore} -> ${radiusAfter}`);
});

test("rotates straight over the pole — something OrbitControls cannot do", () => {
  // Camera on the equator looking along +y, world up = +z.
  const target = new THREE.Vector3(0, 0, 0);
  const camera = makeCamera([0, -10, 0], [0, 0, 1]);
  // A vertical drag of half the viewport height = a π (180°) pitch, which sweeps
  // the camera up through the north pole (0,0,10) and on to the far side (0,10,0).
  // OrbitControls would clamp at the pole; the free tumble passes through it.
  const moved = applyFreeTumbleRotation({
    THREE,
    camera,
    target,
    deltaX: 0,
    deltaY: 50, // (2π * 50 / 100) = π
    viewportHeight: 100,
    rotateSpeed: 1
  });
  assert.equal(moved, true);
  assert.ok(Math.abs(camera.position.x - 0) < 1e-6, `x: ${camera.position.x}`);
  assert.ok(Math.abs(camera.position.y - 10) < 1e-6, `y: ${camera.position.y}`);
  assert.ok(Math.abs(camera.position.z - 0) < 1e-6, `z: ${camera.position.z}`);
  // up has tumbled to point the other way (camera is now "upside down"),
  // which is precisely the freedom OrbitControls withholds.
  assert.ok(camera.up.z < -0.99, `up.z: ${camera.up.z}`);
});

test("a quarter-height vertical drag reaches the pole without stopping short", () => {
  const target = new THREE.Vector3(0, 0, 0);
  const camera = makeCamera([0, -10, 0], [0, 0, 1]);
  applyFreeTumbleRotation({
    THREE,
    camera,
    target,
    deltaX: 0,
    deltaY: 25, // (2π * 25 / 100) = π/2 -> straight over the top
    viewportHeight: 100
  });
  // Now looking straight down the +z axis from the north pole.
  assert.ok(Math.abs(camera.position.x) < 1e-6, `x: ${camera.position.x}`);
  assert.ok(Math.abs(camera.position.y) < 1e-6, `y: ${camera.position.y}`);
  assert.ok(Math.abs(camera.position.z - 10) < 1e-6, `z: ${camera.position.z}`);
});

test("horizontal drag orbits around the up axis and keeps elevation", () => {
  const target = new THREE.Vector3(0, 0, 0);
  const camera = makeCamera([0, -10, 0], [0, 0, 1]);
  const elevationBefore = camera.position.z;
  applyFreeTumbleRotation({
    THREE,
    camera,
    target,
    deltaX: 25, // π/2 azimuth
    deltaY: 0,
    viewportHeight: 100
  });
  // Pure azimuth: z (elevation about the up axis) is unchanged, camera swings in xy.
  assert.ok(Math.abs(camera.position.z - elevationBefore) < 1e-6, `z: ${camera.position.z}`);
  assert.ok(Math.hypot(camera.position.x, camera.position.y) - 10 < 1e-6);
});
