import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGcodePreviewMeshData,
  GCODE_PREVIEW_DETAIL_MAX
} from "./buildPreviewMesh.js";
import { parseGcode } from "./parseGcode.js";

test("parseGcode extracts extrusion, travel, layers, and basic print stats", () => {
  const data = parseGcode(`
; perimeter preview
G21
G90
M82
G92 E0
G0 X0 Y0 Z0.2 F6000
G1 X10 Y0 E0.4 F1200
G1 X10 Y10 E0.8
G0 X0 Y10 F6000
G92 E0
G1 X0 Y0 E0.4
G1 Z0.4 F600
G1 X5 Y0 E0.8
M104 S210
`, { sourceUrl: "/models/test.gcode", fileRef: "test.gcode" });

  assert.equal(data.schemaVersion, 1);
  assert.equal(data.sourceUrl, "/models/test.gcode");
  assert.equal(data.fileRef, "test.gcode");
  assert.equal(data.units, "mm");
  assert.deepEqual(data.bounds, {
    min: [0, 0, 0],
    max: [10, 10, 0.4]
  });
  assert.equal(data.layers.length, 2);
  assert.deepEqual(data.layers.map((layer) => layer.z), [0.2, 0.4]);
  assert.equal(data.stats.movementCommands, 7);
  assert.equal(data.stats.extrusionMoves, 4);
  assert.equal(data.stats.travelMoves, 3);
  assert.equal(data.stats.temperatureCommands, 1);
  assert.equal(Math.round(data.stats.extrusionMm * 1000) / 1000, 1.6);
  assert.equal(data.segments.filter((segment) => segment.kind === "extrusion").length, 4);
  assert.equal(data.segments[1].layerIndex, 0);
  assert.equal(data.segments.at(-1).layerIndex, 1);
});

test("parseGcode follows relative moves, samples IJ arcs, and reports ignored commands", () => {
  const data = parseGcode(`
G91
M83
G1 X2 E0.05
G2 X2 Y0 E0.05 I1 J0
G4 P200
`);

  assert.ok(data.stats.movementCommands > 2);
  assert.equal(data.stats.extrusionMoves, data.stats.movementCommands);
  assert.ok(data.segments.some((segment) => segment.arc));
  assert.ok(data.warnings.some((warning) => warning.includes("Relative XYZ positioning")));
  assert.ok(data.warnings.some((warning) => /G4 line \d+/.test(warning)));
});

test("parseGcode summarizes slicer feature annotations including supports", () => {
  const data = parseGcode(`
G21
G90
M82
G0 X0 Y0 Z0.2
;TYPE:WALL-OUTER
G1 X10 Y0 E0.4
; FEATURE: Support interface
G1 X10 Y10 E0.8
;TYPE:SUPPORT
G1 X0 Y10 E1.2
; FEATURE: Sparse infill
G1 X0 Y0 E1.6
`);
  const featuresById = new Map(data.features.map((feature) => [feature.id, feature]));

  assert.equal(featuresById.get("outer-wall")?.label, "Outer wall");
  assert.equal(featuresById.get("support-interface")?.category, "support");
  assert.equal(featuresById.get("support-interface")?.extrusionMoves, 1);
  assert.deepEqual(featuresById.get("support-interface")?.rawLabels, ["Support interface"]);
  assert.equal(featuresById.get("support")?.extrusionMoves, 1);
  assert.equal(featuresById.get("sparse-infill")?.category, "infill");
  assert.deepEqual(
    data.segments.filter((segment) => segment.kind === "extrusion").map((segment) => segment.featureId),
    ["outer-wall", "support-interface", "support", "sparse-infill"]
  );
});

test("buildGcodePreviewMeshData turns visible G-code paths into layer-colored mesh data", () => {
  const data = parseGcode(`
G21
G90
M82
G0 X0 Y0 Z0.2
;TYPE:WALL-OUTER
G1 X4 Y0 E0.2
G0 X4 Y4
G1 X0 Y4 E0.4
G1 Z0.4
G1 X0 Y0 E0.6
`);

  const extrusionOnly = buildGcodePreviewMeshData(data, {
    showTravel: false,
    maxLayer: 0
  });

  assert.equal(extrusionOnly.sourceFormat, "gcode");
  assert.deepEqual(extrusionOnly.metadata.options.layerRange, [0, 0]);
  assert.equal(extrusionOnly.metadata.options.showTravel, false);
  assert.equal(extrusionOnly.metadata.previewGeometry, "ribbon");
  assert.equal(extrusionOnly.metadata.features.some((feature) => feature.id === "outer-wall"), true);
  assert.equal(extrusionOnly.has_source_colors, true);
  assert.ok(extrusionOnly.vertices.length > 0);
  assert.ok(extrusionOnly.indices.length > 0);
  assert.equal(extrusionOnly.colors.length, extrusionOnly.vertices.length);
  assert.equal(extrusionOnly.normals.length, extrusionOnly.vertices.length);
  assert.equal(extrusionOnly.bounds.min[2], 0.2);
  assert.ok(extrusionOnly.vertices[2] > extrusionOnly.bounds.min[2]);
  assert.deepEqual(extrusionOnly.parts.map((part) => part.label), ["Layer 1"]);

  const withTravel = buildGcodePreviewMeshData(data, {
    showTravel: true,
    maxLayer: 1
  });
  assert.ok(withTravel.parts.some((part) => part.label === "Travel"));
  assert.ok(withTravel.parts.some((part) => part.label === "Layer 2"));
  assert.equal(withTravel.metadata.stats.extrusionMoves, 3);
});

test("buildGcodePreviewMeshData renders support paths with a neutral color and z bias", () => {
  const data = parseGcode(`
G21
G90
M82
G0 X0 Y0 Z0.2
;TYPE:WALL-OUTER
G1 X4 Y0 E0.2
G1 Z0.4
G1 X4 Y4 E0.4
G1 Z0.6
;TYPE:SUPPORT
G1 X0 Y4 E0.6
`);

  const preview = buildGcodePreviewMeshData(data, { detailMode: "full" });
  const supportVertexOffset = 2 * 4 * 3;
  const supportRgb = Array.from(preview.colors.slice(supportVertexOffset, supportVertexOffset + 3));

  assert.ok(supportRgb[0] < 0.75);
  assert.ok(supportRgb[1] > 0.45);
  assert.ok(supportRgb[2] > 0.55);
  assert.ok(preview.vertices[supportVertexOffset + 2] > 0.6);
  assert.equal(preview.bounds.max[2], 0.6);
});

test("buildGcodePreviewMeshData adaptively samples whole layers unless full detail is requested", () => {
  const moves = Array.from({ length: 8 }, (_, layerIndex) => `
G1 Z${((layerIndex + 1) * 0.2).toFixed(1)}
G1 X${layerIndex * 2 + 1} Y0 E${(layerIndex * 2 + 1) / 10}
G1 X${layerIndex * 2 + 2} Y0 E${(layerIndex * 2 + 2) / 10}
`).join("\n");
  const data = parseGcode(`
G21
G90
M82
G0 X0 Y0 Z0.2
${moves}
`);

  const adaptive = buildGcodePreviewMeshData(data, {
    maxVisibleSegments: 6
  });
  assert.equal(adaptive.metadata.visibleSegments, 16);
  assert.equal(adaptive.metadata.segmentStride, 1);
  assert.equal(adaptive.metadata.layerStride, 4);
  assert.equal(adaptive.metadata.renderedLayers, 3);
  assert.equal(adaptive.metadata.renderedSegments, 6);
  assert.equal(adaptive.metadata.decimationMode, "layers");
  assert.equal(adaptive.metadata.decimated, true);
  assert.deepEqual(adaptive.parts.map((part) => part.label), ["Layer 1", "Layer 5", "Layer 8"]);

  const full = buildGcodePreviewMeshData(data, {
    detailMode: "full",
    maxVisibleSegments: 6
  });
  assert.equal(full.metadata.visibleSegments, 16);
  assert.equal(full.metadata.segmentStride, 1);
  assert.equal(full.metadata.layerStride, 1);
  assert.equal(full.metadata.renderedSegments, 16);
  assert.equal(full.metadata.decimated, false);

  const maxAdaptive = buildGcodePreviewMeshData(data, {
    detailLevel: 99
  });
  assert.equal(maxAdaptive.metadata.options.detailLevel, GCODE_PREVIEW_DETAIL_MAX);
});
