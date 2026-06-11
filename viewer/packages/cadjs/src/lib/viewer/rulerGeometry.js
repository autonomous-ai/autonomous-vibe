// Pure measurement math for the viewer ruler tool. Framework-agnostic: every
// function operates on plain [x, y, z] arrays (world/model space) so it can be
// unit-tested without THREE. The viewer hook feeds it raycast hit points and
// topology surface descriptors; rulerScene.js turns the results into geometry.

const MM_PER_INCH = 25.4;

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toVec3(point) {
  return [num(point?.[0]), num(point?.[1]), num(point?.[2])];
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function length(vector) {
  return Math.sqrt(dot(vector, vector));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// Straight-line distance between two points plus the absolute axis extents,
// matching the ΔX / ΔY / ΔZ readout in the ruler spec.
export function distanceWithDeltas(a, b) {
  const start = toVec3(a);
  const end = toVec3(b);
  return {
    distance: length(subtract(end, start)),
    dx: Math.abs(end[0] - start[0]),
    dy: Math.abs(end[1] - start[1]),
    dz: Math.abs(end[2] - start[2])
  };
}

// Angle (degrees) at vertex `b` formed by the rays b→a and b→c.
export function angleAtVertex(a, b, c) {
  const vertex = toVec3(b);
  const ba = subtract(toVec3(a), vertex);
  const bc = subtract(toVec3(c), vertex);
  const denom = length(ba) * length(bc);
  if (denom < 1e-9) {
    return 0;
  }
  return (Math.acos(clamp(dot(ba, bc) / denom, -1, 1)) * 180) / Math.PI;
}

// Radius/diameter from a cylindrical face's pick surface descriptor (STEP only).
// Returns null when the surface is not a finite-radius cylinder.
export function diameterFromSurface(surface) {
  if (surface?.type && surface.type !== "CYLINDRICAL_SURFACE") {
    return null;
  }
  const radius = Number(surface?.radius);
  if (!Number.isFinite(radius) || radius <= 0) {
    return null;
  }
  return { radius, diameter: radius * 2 };
}

// Wall thickness is just the entry→exit span of the inward ray cast.
export function wallThickness(entry, exit) {
  return length(subtract(toVec3(exit), toVec3(entry)));
}

// Width (X), depth (Y), height (Z), center and the 8 corner points of an
// axis-aligned bounding box. `bounds` is {min:[x,y,z], max:[x,y,z]} in model
// space; `offset` (default origin) shifts corners/center into world space —
// pass runtime.modelGroup.position because modelBounds is model-local.
export function boundingBoxDims(bounds, offset = [0, 0, 0]) {
  const min = toVec3(bounds?.min);
  const max = toVec3(bounds?.max);
  const shift = toVec3(offset);
  const corners = [];
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) {
      for (const z of [min[2], max[2]]) {
        corners.push([x + shift[0], y + shift[1], z + shift[2]]);
      }
    }
  }
  return {
    width: Math.abs(max[0] - min[0]),
    depth: Math.abs(max[1] - min[1]),
    height: Math.abs(max[2] - min[2]),
    center: [
      (min[0] + max[0]) / 2 + shift[0],
      (min[1] + max[1]) / 2 + shift[1],
      (min[2] + max[2]) / 2 + shift[2]
    ],
    corners
  };
}

// Nearest candidate point to `point` within `maxDistance`, or null. Used for the
// cheap "snap to the hit triangle's vertex" behaviour that works on raw meshes.
export function nearestVertex(point, candidates, maxDistance = Infinity) {
  const target = toVec3(point);
  let best = null;
  let bestDistance = maxDistance;
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const distance = length(subtract(toVec3(candidate), target));
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = toVec3(candidate);
    }
  }
  return best;
}

export function convertUnit(valueMm, unit) {
  switch (unit) {
    case "cm":
      return num(valueMm) / 10;
    case "inch":
      return num(valueMm) / MM_PER_INCH;
    default:
      return num(valueMm);
  }
}

export function unitLabel(unit) {
  switch (unit) {
    case "cm":
      return "cm";
    case "inch":
      return "in";
    default:
      return "mm";
  }
}

export function formatLength(valueMm, unit, precision = 2) {
  return `${convertUnit(valueMm, unit).toFixed(precision)} ${unitLabel(unit)}`;
}

export function formatAngle(degrees, precision = 1) {
  return `${num(degrees).toFixed(precision)}°`;
}
