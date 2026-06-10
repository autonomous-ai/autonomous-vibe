// Tests for the highlight-context note builder: bounding box over normalized
// stroke points, the coarse 3x3 region label, and the composed model-facing
// note (per-region enumeration + notes, with a bbox fallback for non-region
// scribbles). Pure helpers, runs under node:test (no DOM).

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDrawingSuggestionText,
  buildHighlightContextNote,
  isRegionStroke,
  regionLabel,
  strokesBoundingBox,
} from "../highlightContext.js";

test("buildDrawingSuggestionText names the drawn shape", () => {
  assert.equal(
    buildDrawingSuggestionText([{ tool: "circle", points: [{ x: 0.5, y: 0.5 }] }]),
    "Improve the circle.",
  );
  assert.equal(
    buildDrawingSuggestionText([{ tool: "rectangle", points: [] }]),
    "Improve the rectangle.",
  );
  // Multiple of the same shape pluralize; mixed shapes generalize.
  assert.equal(
    buildDrawingSuggestionText([{ tool: "circle" }, { tool: "circle" }]),
    "Improve the circles.",
  );
  assert.equal(
    buildDrawingSuggestionText([{ tool: "circle" }, { tool: "rectangle" }]),
    "Improve the highlighted areas.",
  );
  // Only freehand marks → generic "highlighted area"; nothing drawn → "".
  assert.equal(
    buildDrawingSuggestionText([{ tool: "freehand" }]),
    "Improve the highlighted area.",
  );
  assert.equal(buildDrawingSuggestionText([]), "");
});

test("strokesBoundingBox bounds every point across strokes", () => {
  const box = strokesBoundingBox([
    { points: [{ x: 0.2, y: 0.1 }, { x: 0.4, y: 0.5 }] },
    { points: [{ x: 0.1, y: 0.3 }, { x: 0.6, y: 0.2 }] },
  ]);
  assert.equal(box.minX, 0.1);
  assert.equal(box.maxX, 0.6);
  assert.equal(box.minY, 0.1);
  assert.equal(box.maxY, 0.5);
  assert.equal(box.cx, 0.35);
  assert.equal(box.cy, 0.3);
});

test("strokesBoundingBox returns null for empty / non-finite input", () => {
  assert.equal(strokesBoundingBox([]), null);
  assert.equal(strokesBoundingBox(null), null);
  assert.equal(strokesBoundingBox([{ points: [{ x: NaN, y: 1 }] }]), null);
});

test("regionLabel maps the 3x3 grid", () => {
  assert.equal(regionLabel(0.5, 0.5), "center");
  assert.equal(regionLabel(0.1, 0.1), "top-left");
  assert.equal(regionLabel(0.9, 0.9), "bottom-right");
  assert.equal(regionLabel(0.5, 0.1), "top");
  assert.equal(regionLabel(0.9, 0.5), "right");
});

test("isRegionStroke is true only for closed-shape tools", () => {
  assert.equal(isRegionStroke({ tool: "circle" }), true);
  assert.equal(isRegionStroke({ tool: "rectangle" }), true);
  assert.equal(isRegionStroke({ tool: "freehand" }), false);
  assert.equal(isRegionStroke({ tool: "arrow" }), false);
  assert.equal(isRegionStroke(null), false);
});

test("buildHighlightContextNote enumerates a region with its note + camera", () => {
  const note = buildHighlightContextNote({
    strokes: [
      { tool: "circle", note: "add vents", points: [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.5 }] },
    ],
    perspective: { position: [180, -180, 120], target: [0, 0, 0] },
  });
  assert.match(note, /^\[Highlighted-view context: /);
  assert.match(note, /1 highlighted region on the attached view/);
  assert.match(note, /region 1 \(circle, center\): "add vents"/);
  assert.match(note, /Camera eye \[180\.0, -180\.0, 120\.0\] looking at \[0\.0, 0\.0, 0\.0\]/);
});

test("buildHighlightContextNote numbers multiple regions and respects shape + position", () => {
  const note = buildHighlightContextNote({
    strokes: [
      { tool: "circle", note: "thicker", points: [{ x: 0.1, y: 0.1 }, { x: 0.15, y: 0.1 }] },
      { tool: "rectangle", points: [{ x: 0.8, y: 0.8 }, { x: 0.95, y: 0.95 }] },
    ],
  });
  assert.match(note, /2 highlighted regions/);
  assert.match(note, /region 1 \(circle, top-left\): "thicker"/);
  // Second region has no note → no quoted text, and it's a rectangle bottom-right.
  assert.match(note, /region 2 \(rectangle, bottom-right\)(?!:)/);
});

test("buildHighlightContextNote falls back to a bbox summary for non-region scribbles", () => {
  const note = buildHighlightContextNote({
    strokes: [{ tool: "freehand", points: [{ x: 0.4, y: 0.1 }, { x: 0.6, y: 0.3 }] }],
  });
  assert.match(note, /Highlighted area on the attached view/);
  assert.match(note, /normalized bounds x 40–60%, y 10–30%/);
  assert.doesNotMatch(note, /region 1/);
});

test("buildHighlightContextNote returns '' when there's nothing to say", () => {
  assert.equal(buildHighlightContextNote({}), "");
  assert.equal(buildHighlightContextNote({ strokes: [], perspective: null }), "");
});

test("buildHighlightContextNote omits camera when perspective is incomplete", () => {
  const note = buildHighlightContextNote({
    strokes: [{ tool: "circle", points: [{ x: 0.5, y: 0.5 }] }],
    perspective: { position: [1, 2, 3] }, // no target
  });
  assert.doesNotMatch(note, /Camera eye/);
  assert.match(note, /region 1/);
});
