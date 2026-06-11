// Feature-based measurement for the OrcaSlicer-style ruler (STEP only).
//
// A topology "reference" (face/edge) is reduced to a normalized geometric
// feature, then a pair of features is measured by inferring the relevant value
// (angle / distance / length / diameter). All geometry is in the model-local
// frame that pickData uses; because the viewer's model offset is translation
// only, angles and distances computed here are frame-invariant — the caller
// only needs to shift the returned anchor points by the model offset to render
// them in world space.

const PARALLEL_SIN_EPSILON = Math.sin((1.5 * Math.PI) / 180); // ~1.5°

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function vec(value) {
  return [num(value?.[0]), num(value?.[1]), num(value?.[2])];
}

function isVec(value) {
  return Array.isArray(value) && value.length >= 3 && value.every((entry) => Number.isFinite(Number(entry)));
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

function length(a) {
  return Math.sqrt(dot(a, a));
}

function normalize(a) {
  const len = length(a);
  return len < 1e-9 ? [0, 0, 0] : [a[0] / len, a[1] / len, a[2] / len];
}

function midpoint(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

// Acute angle (0–90°) between two directions, ignoring orientation.
function acuteAngleDeg(u, v) {
  const nu = normalize(u);
  const nv = normalize(v);
  if (length(nu) < 0.5 || length(nv) < 0.5) {
    return 0;
  }
  const c = Math.min(Math.max(Math.abs(dot(nu, nv)), 0), 1);
  return (Math.acos(c) * 180) / Math.PI;
}

// Any unit vector perpendicular to `axis` — used to lay out a diameter segment.
function perpendicular(axis) {
  const n = normalize(axis);
  const reference = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return normalize(cross(n, reference));
}

function deltas(a, b) {
  return [Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2])];
}

// First and last vertex of a flat [x,y,z,x,y,z,...] segment-pair polyline.
function polylineEnds(positions) {
  if (!(Array.isArray(positions) || ArrayBuffer.isView(positions)) || positions.length < 6) {
    return null;
  }
  const last = positions.length - 3;
  return {
    a: [num(positions[0]), num(positions[1]), num(positions[2])],
    b: [num(positions[last]), num(positions[last + 1]), num(positions[last + 2])]
  };
}

function extractFace(reference) {
  const pickData = reference?.pickData || {};
  const params = pickData.params || {};
  const surfaceType = String(pickData.surfaceType || "").toLowerCase();
  if (surfaceType === "cylinder" && Number.isFinite(Number(params.radius)) && isVec(params.axis)) {
    return {
      kind: "cylinder",
      origin: vec(params.origin || pickData.center),
      axis: normalize(vec(params.axis)),
      radius: Number(params.radius)
    };
  }
  const normalSource = isVec(params.axis) ? params.axis : pickData.normal;
  const pointSource = isVec(params.origin) ? params.origin : pickData.center;
  if ((surfaceType === "plane" || isVec(pickData.normal)) && isVec(normalSource) && isVec(pointSource)) {
    return { kind: "plane", point: vec(pointSource), normal: normalize(vec(normalSource)) };
  }
  if (isVec(pickData.center)) {
    return { kind: "point", p: vec(pickData.center) };
  }
  return null;
}

function extractEdge(reference, edgePolyline) {
  const params = reference?.pickData?.params || {};
  if (Number.isFinite(Number(params.radius)) && isVec(params.center) && isVec(params.axis)) {
    return {
      kind: "circle",
      center: vec(params.center),
      axis: normalize(vec(params.axis)),
      radius: Number(params.radius)
    };
  }
  const ends = polylineEnds(edgePolyline);
  if (ends && length(sub(ends.b, ends.a)) > 1e-7) {
    return { kind: "line", a: ends.a, b: ends.b, dir: normalize(sub(ends.b, ends.a)), length: length(sub(ends.b, ends.a)) };
  }
  if (isVec(params.origin) && isVec(params.direction)) {
    const a = vec(params.origin);
    return { kind: "line", a, b: a, dir: normalize(vec(params.direction)), length: 0 };
  }
  return null;
}

// Normalize a topology reference + (optional) edge polyline into a feature.
export function extractFeature(reference, edgePolyline = null) {
  const selectorType = String(reference?.selectorType || reference?.pickData?.selectorType || "").toLowerCase();
  if (selectorType === "face") {
    return extractFace(reference);
  }
  if (selectorType === "edge") {
    return extractEdge(reference, edgePolyline);
  }
  return null;
}

// Representative point of a feature (for center-to-center distance / labels).
export function featureAnchor(feature) {
  switch (feature?.kind) {
    case "plane":
      return vec(feature.point);
    case "cylinder":
      return vec(feature.origin);
    case "circle":
      return vec(feature.center);
    case "line":
      return midpoint(vec(feature.a), vec(feature.b));
    case "point":
      return vec(feature.p);
    default:
      return [0, 0, 0];
  }
}

function planeNormal(feature) {
  return feature.kind === "plane" ? feature.normal : feature.kind === "cylinder" ? feature.axis : null;
}

function lineDir(feature) {
  return feature.kind === "line" ? feature.dir : null;
}

function distanceResult(anchorA, anchorB) {
  const distance = length(sub(anchorB, anchorA));
  return { tool: "distance", value: distance, components: deltas(anchorA, anchorB), anchorA, anchorB };
}

function angleResult(angleDeg, anchorA, anchorB) {
  return { tool: "angle", value: angleDeg, components: [angleDeg], anchorA, anchorB };
}

// Foot of the perpendicular from point `p` onto the infinite line (origin `a`, unit `dir`).
function projectPointOntoLine(p, a, dir) {
  return add(a, scale(dir, dot(sub(p, a), dir)));
}

// Measure the relationship between two features. Returns a measurement-ready
// result (in the local frame) or null when nothing sensible can be derived.
export function measureFeaturePair(a, b) {
  if (!a || !b) {
    return null;
  }
  const anchorA = featureAnchor(a);
  const anchorB = featureAnchor(b);

  // plane/plane (cylinders treated as their axis plane for angle/parallel).
  const normalA = planeNormal(a);
  const normalB = planeNormal(b);
  if (a.kind === "plane" && b.kind === "plane") {
    const angle = acuteAngleDeg(normalA, normalB);
    if (Math.sin((angle * Math.PI) / 180) < PARALLEL_SIN_EPSILON) {
      const signed = dot(sub(b.point, a.point), normalize(normalA));
      const foot = add(a.point, scale(normalize(normalA), signed));
      return distanceResult(vec(a.point), foot);
    }
    return angleResult(angle, anchorA, anchorB);
  }

  // line/line.
  const dirA = lineDir(a);
  const dirB = lineDir(b);
  if (dirA && dirB) {
    const angle = acuteAngleDeg(dirA, dirB);
    if (Math.sin((angle * Math.PI) / 180) < PARALLEL_SIN_EPSILON) {
      const foot = projectPointOntoLine(a.a, b.a, dirB);
      return distanceResult(vec(a.a), foot);
    }
    return angleResult(angle, anchorA, anchorB);
  }

  // line/plane (either order) → angle between the line and the plane.
  const linePlane = (dirA && normalB) ? { dir: dirA, normal: normalB }
    : (dirB && normalA) ? { dir: dirB, normal: normalA } : null;
  if (linePlane) {
    const angle = Math.max(0, 90 - acuteAngleDeg(linePlane.dir, linePlane.normal));
    return angleResult(angle, anchorA, anchorB);
  }

  // Fallback: center-to-center distance.
  return distanceResult(anchorA, anchorB);
}

// Intrinsic measurement of a single feature (edge length / circle·cylinder Ø),
// returned as a measurement-ready record with render points. null if none.
export function measureFeatureIntrinsic(feature) {
  if (!feature) {
    return null;
  }
  if (feature.kind === "line" && feature.length > 1e-7) {
    return {
      tool: "distance",
      value: feature.length,
      components: deltas(vec(feature.a), vec(feature.b)),
      points: [vec(feature.a), vec(feature.b)]
    };
  }
  if (feature.kind === "circle" || feature.kind === "cylinder") {
    const center = feature.kind === "circle" ? vec(feature.center) : vec(feature.origin);
    const radial = perpendicular(feature.axis);
    const radius = Number(feature.radius) || 0;
    if (radius <= 0) {
      return null;
    }
    return {
      tool: "diameter",
      value: radius * 2,
      components: [radius, radius * 2],
      points: [add(center, scale(radial, radius)), add(center, scale(radial, -radius))]
    };
  }
  return null;
}
