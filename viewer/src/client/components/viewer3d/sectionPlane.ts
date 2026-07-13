import { Euler, type Plane, Vector3 } from "three";
import type { SectionAxis, SectionBounds } from "./section";

/** Unit normal of the cross-section plane for the given orientation. X/Y/Z map to the
 *  world axes; `custom` rotates the X axis by the user's Euler angles. `flip` reverses
 *  it, swapping which half is kept. */
export function sectionNormal(
  axis: SectionAxis,
  rotation: [number, number, number],
  flip: boolean,
): Vector3 {
  const n =
    axis === "y"
      ? new Vector3(0, 1, 0)
      : axis === "z"
        ? new Vector3(0, 0, 1)
        : axis === "custom"
          ? new Vector3(1, 0, 0).applyEuler(new Euler(rotation[0], rotation[1], rotation[2]))
          : new Vector3(1, 0, 0);
  n.normalize();
  return flip ? n.negate() : n;
}

/** Half-extent of an axis-aligned box (given by its half-sizes) along an arbitrary
 *  unit direction — the reach the position slider sweeps across. */
function extentAlong(n: Vector3, half: Vector3): number {
  return Math.abs(n.x) * half.x + Math.abs(n.y) * half.y + Math.abs(n.z) * half.z;
}

interface SectionParams {
  axis: SectionAxis;
  rotation: [number, number, number];
  flip: boolean;
  /** Normalized −1…1 offset of the plane along its normal. */
  position: number;
}

/** Update the two stable clip planes in place (no allocation churn) from the current
 *  tool params and measured bounds. `clip` keeps the half on its normal's side and
 *  exposes the cut; `hidden` keeps the opposite half (for the ghosted clipped-away
 *  side). three.js reads clipping planes every frame, so mutating in place gives
 *  real-time slider dragging with zero React re-renders. Returns the plane normal. */
export function updateSectionPlanes(
  clip: Plane,
  hidden: Plane,
  { axis, rotation, flip, position }: SectionParams,
  bounds: SectionBounds,
): Vector3 {
  const n = sectionNormal(axis, rotation, flip);
  const reach = extentAlong(n, bounds.half) || 1;
  const point = bounds.center.clone().addScaledVector(n, position * reach);
  clip.setFromNormalAndCoplanarPoint(n, point);
  hidden.setFromNormalAndCoplanarPoint(n.clone().negate(), point);
  return n;
}
