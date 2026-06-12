import assert from "node:assert/strict";
import test from "node:test";

import {
  materializeRecordEffect,
  MATERIALIZE_SKIN_START,
  MATERIALIZE_GHOST_OPACITY,
} from "../materializeEffect.js";

test("start of animation: invisible surface, no glow yet", () => {
  const r = materializeRecordEffect(0, 1);
  assert.equal(r.phase, "sketch");
  assert.equal(r.surfaceOpacity, 0);
  assert.equal(r.glow, 0);
  assert.equal(r.edgeOpacity, 0);
});

test("sketch phase: surface stays a faint ghost while edges/glow ramp up", () => {
  // Just before the skin-over handoff, still in the sketch phase.
  const r = materializeRecordEffect(MATERIALIZE_SKIN_START - 0.001, 1);
  assert.equal(r.phase, "sketch");
  // Surface never exceeds the ghost opacity during the sketch phase.
  assert.ok(r.surfaceOpacity <= MATERIALIZE_GHOST_OPACITY + 1e-6);
  // Edges and glow are near their peak as we approach the handoff.
  assert.ok(r.edgeOpacity > 0.95);
  assert.ok(r.glow > 0.95);
});

test("skin phase: surface fills toward base opacity while glow decays", () => {
  const mid = materializeRecordEffect((MATERIALIZE_SKIN_START + 1) / 2, 1);
  assert.equal(mid.phase, "skin");
  // Surface has risen above the ghost level on its way to base.
  assert.ok(mid.surfaceOpacity > MATERIALIZE_GHOST_OPACITY);
  assert.ok(mid.surfaceOpacity < 1);
  // Glow and edges are fading out.
  assert.ok(mid.glow < 1);
  assert.ok(mid.edgeOpacity < 1);
});

test("end of animation: surface at base opacity, glow and edges gone", () => {
  const r = materializeRecordEffect(1, 1);
  assert.equal(r.phase, "skin");
  assert.equal(r.surfaceOpacity, 1);
  assert.equal(r.glow, 0);
  assert.equal(r.edgeOpacity, 0);
});

test("respects a non-1 base opacity (translucent parts settle there, not at 1)", () => {
  const r = materializeRecordEffect(1, 0.5);
  assert.ok(Math.abs(r.surfaceOpacity - 0.5) < 1e-9);
});

test("progress is clamped outside 0..1", () => {
  assert.deepEqual(materializeRecordEffect(-5, 1), materializeRecordEffect(0, 1));
  assert.deepEqual(materializeRecordEffect(5, 1), materializeRecordEffect(1, 1));
});
