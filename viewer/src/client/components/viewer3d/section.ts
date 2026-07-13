import type { Vector3 } from "three";

/** Which way the cross-section plane faces. X/Y/Z are the world axes; `custom` lets
 *  the user rotate the plane freely via the panel's rotation sliders. */
export type SectionAxis = "x" | "y" | "z" | "custom";

/** World-space bounds of the sectioned model, measured once per model. Drives the
 *  position slider mapping (normalized −1…1 → world offset) and the cap quad size.
 *  Not React state — held in a ref and read inside useFrame. */
export interface SectionBounds {
  center: Vector3;
  /** Half-extent on each world axis (box half-size). */
  half: Vector3;
  /** Bounding-sphere radius — sizes the cap quad so it always covers the cut. */
  radius: number;
}
