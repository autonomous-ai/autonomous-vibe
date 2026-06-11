// THREE object builders for the viewer ruler tool. These turn a stored
// measurement (tool + world-space points) into scene geometry placed in
// runtime.rulerGroup. `runtime` doubles as the line-builder context: it carries
// THREE, the Line2/LineSegments2/LineMaterial classes and the screen-space line
// material registry (see useViewerRuntime.js / renderEdges.js).

import {
  createScreenSpaceLineSegments,
  createScreenSpaceLineStrip
} from "../../common/renderEdges.js";

const DEFAULT_LINE_COLOR = "#38bdf8";
const DEFAULT_MARKER_COLOR = "#f8fafc";
const RULER_RENDER_ORDER = 30;

// 12 edges of an axis-aligned box, indexing into the 8 corners produced by
// rulerGeometry.boundingBoxDims (order: x outer, y middle, z inner).
const BBOX_EDGE_PAIRS = [
  [0, 1], [2, 3], [4, 5], [6, 7], // z edges
  [0, 2], [1, 3], [4, 6], [5, 7], // y edges
  [0, 4], [1, 5], [2, 6], [3, 7]  // x edges
];

function flattenPoints(points) {
  const flat = [];
  for (const point of points) {
    flat.push(Number(point?.[0]) || 0, Number(point?.[1]) || 0, Number(point?.[2]) || 0);
  }
  return flat;
}

function buildMarker(runtime, THREE, point, { color, opacity, renderOrder }) {
  const radius = Math.max(Number(runtime?.modelRadius || 1) * 0.006, 0.25);
  const geometry = new THREE.SphereGeometry(radius, 16, 16);
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
    toneMapped: false
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(Number(point?.[0]) || 0, Number(point?.[1]) || 0, Number(point?.[2]) || 0);
  mesh.renderOrder = renderOrder;
  mesh.userData.disposeGeometry = true;
  mesh.userData.disposeMaterial = true;
  return mesh;
}

function buildSegmentLine(runtime, positions, { color, opacity, lineWidth, renderOrder }) {
  return createScreenSpaceLineSegments(runtime, positions, {
    color,
    opacity,
    lineWidth,
    renderOrder,
    depthTest: false,
    depthWrite: false
  });
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function normalize(vector) {
  const len = Math.hypot(vector[0], vector[1], vector[2]);
  return len < 1e-9 ? [0, 0, 0] : [vector[0] / len, vector[1] / len, vector[2] / len];
}

// A short arc at the angle vertex, sampled between the two arms.
function buildAngleArc(runtime, points, options) {
  const [a, b, c] = points;
  const arm1 = subtract(a, b);
  const arm2 = subtract(c, b);
  const len1 = Math.hypot(arm1[0], arm1[1], arm1[2]);
  const len2 = Math.hypot(arm2[0], arm2[1], arm2[2]);
  if (len1 < 1e-6 || len2 < 1e-6) {
    return null;
  }
  const radius = Math.min(len1, len2) * 0.25;
  const dir1 = normalize(arm1);
  const dir2 = normalize(arm2);
  const segments = 24;
  const positions = [];
  for (let index = 0; index <= segments; index += 1) {
    const t = index / segments;
    // Spherical-ish interpolation between the two arm directions.
    const blended = normalize([
      dir1[0] + (dir2[0] - dir1[0]) * t,
      dir1[1] + (dir2[1] - dir1[1]) * t,
      dir1[2] + (dir2[2] - dir1[2]) * t
    ]);
    positions.push(b[0] + blended[0] * radius, b[1] + blended[1] * radius, b[2] + blended[2] * radius);
  }
  return createScreenSpaceLineStrip(runtime, positions, {
    color: options.color,
    opacity: options.opacity,
    lineWidth: Math.max(options.lineWidth - 0.5, 1),
    renderOrder: options.renderOrder,
    depthTest: false,
    depthWrite: false
  });
}

// Build the scene objects for one measurement. Returns an array of
// THREE.Object3D to add to runtime.rulerGroup (caller owns disposal via
// clearOverlayGroup). Tools sharing a 2-point line: distance, diameter,
// wall-thickness.
export function buildMeasurementObjects(runtime, measurement, {
  color = DEFAULT_LINE_COLOR,
  markerColor = DEFAULT_MARKER_COLOR,
  lineWidth = 2,
  opacity = 1
} = {}) {
  const THREE = runtime?.THREE;
  if (!THREE || !measurement) {
    return [];
  }
  const points = Array.isArray(measurement.points)
    ? measurement.points.filter((point) => Array.isArray(point) && point.length >= 3)
    : [];
  const lineOptions = { color, opacity, lineWidth, renderOrder: RULER_RENDER_ORDER };
  const markerOptions = { color: markerColor, opacity, renderOrder: RULER_RENDER_ORDER + 1 };
  const objects = [];

  if (measurement.tool === "bounding-box") {
    if (points.length >= 8) {
      const positions = [];
      for (const [from, to] of BBOX_EDGE_PAIRS) {
        positions.push(...points[from], ...points[to]);
      }
      const wireframe = buildSegmentLine(runtime, positions, lineOptions);
      if (wireframe) {
        objects.push(wireframe);
      }
    }
    return objects;
  }

  // 3-point angle (free-point tool): arms + arc + markers. A feature-mode angle
  // carries only 2 anchor points and falls through to the 2-point segment below.
  if (measurement.tool === "angle" && points.length >= 3) {
    const [a, b, c] = points;
    const arms = buildSegmentLine(runtime, [...b, ...a, ...b, ...c], lineOptions);
    if (arms) {
      objects.push(arms);
    }
    const arc = buildAngleArc(runtime, points, lineOptions);
    if (arc) {
      objects.push(arc);
    }
    for (const point of points) {
      objects.push(buildMarker(runtime, THREE, point, markerOptions));
    }
    return objects;
  }

  // Default: a 2-point segment with endpoint markers.
  if (points.length >= 2) {
    const line = buildSegmentLine(runtime, [...points[0], ...points[1]], lineOptions);
    if (line) {
      objects.push(line);
    }
    objects.push(buildMarker(runtime, THREE, points[0], markerOptions));
    objects.push(buildMarker(runtime, THREE, points[1], markerOptions));
  } else if (points.length === 1) {
    objects.push(buildMarker(runtime, THREE, points[0], markerOptions));
  }
  return objects;
}

// Plain endpoint markers for an arbitrary list of points — used to show the
// in-progress draft (points placed so far) before a measurement is complete.
export function buildPointMarkers(runtime, points, {
  color = "#fbbf24",
  opacity = 1
} = {}) {
  const THREE = runtime?.THREE;
  if (!THREE || !Array.isArray(points)) {
    return [];
  }
  return points
    .filter((point) => Array.isArray(point) && point.length >= 3)
    .map((point) => buildMarker(runtime, THREE, point, {
      color,
      opacity,
      renderOrder: RULER_RENDER_ORDER + 1
    }));
}

// The 3D point where a measurement's DOM label should be anchored.
export function measurementLabelAnchor(measurement) {
  const points = Array.isArray(measurement?.points)
    ? measurement.points.filter((point) => Array.isArray(point) && point.length >= 3)
    : [];
  if (!points.length) {
    return null;
  }
  if (measurement.tool === "angle" && points.length >= 3) {
    return points[1];
  }
  if (measurement.tool === "bounding-box") {
    const sum = points.reduce((acc, point) => [acc[0] + point[0], acc[1] + point[1], acc[2] + point[2]], [0, 0, 0]);
    return [sum[0] / points.length, sum[1] / points.length, sum[2] / points.length];
  }
  if (points.length >= 2) {
    return [
      (points[0][0] + points[1][0]) / 2,
      (points[0][1] + points[1][1]) / 2,
      (points[0][2] + points[1][2]) / 2
    ];
  }
  return points[0];
}
