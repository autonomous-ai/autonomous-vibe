import assert from "node:assert/strict";
import test from "node:test";

import { buildDxfPreviewMeshData } from "./buildPreviewMesh.js";

function line(start, end) {
  return {
    kind: "cut",
    start,
    end
  };
}

function rectangle(minX, minY, maxX, maxY) {
  return [
    line([minX, minY], [maxX, minY]),
    line([maxX, minY], [maxX, maxY]),
    line([maxX, maxY], [minX, maxY]),
    line([minX, maxY], [minX, minY])
  ];
}

test("DXF preview extrudes multiple disconnected no-bend flat contours", () => {
  const dxfData = {
    geometry: {
      lines: [
        ...rectangle(0, 0, 10, 10),
        ...rectangle(5, 20, 15, 30)
      ],
      arcs: [],
      circles: []
    },
    defaultThicknessMm: 2
  };

  const meshData = buildDxfPreviewMeshData(dxfData, 2);

  assert.equal(meshData.triangle_count > 0, true);
  assert.equal(meshData.guide_line_segments.length, 0);
  assert.deepEqual(meshData.bounds.min, [0, -1, 0]);
  assert.deepEqual(meshData.bounds.max, [15, 1, 30]);
});

