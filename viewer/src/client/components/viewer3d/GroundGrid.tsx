import { Grid } from "@react-three/drei";

// <Grid> renders through its own UNLIT shader — scene lights don't touch it, so its
// visibility is purely these colors vs. the #0E0F13 background. Kept bright enough to
// read clearly while staying subordinate to the model. (Literals because FORGE tokens
// can't cross into WebGL; these sit a few steps up the neutral ramp from --color-border.)
const CELL_COLOR = "#4B5563"; // minor grid lines
const SECTION_COLOR = "#8A93A2"; // major grid lines — clearly brighter

// Fixed grid dimensions in CAD units (mm) — a stable floor reference that does NOT
// scale with the model, so cell spacing reads consistently from part to part.
// GRID_SIZE is exported so the canvas can frame the default view to the whole grid.
export const GRID_SIZE = 400; // total extent
const CELL_SIZE = 10; // minor line every 10mm
const SECTION_SIZE = 50; // major line every 50mm

// <Grid> fades by distance from the camera. The camera sits well outside the plane,
// so the far edge is ~2× GRID_SIZE away — with a short fade the whole back half of
// the grid dissolves before its edge. Push the fade far past the grid (and soften its
// falloff) so the entire floor stays visible edge to edge.
const FADE_DISTANCE = GRID_SIZE * 8;
const FADE_STRENGTH = 0.5;

/** A fixed-size ground grid at y=0 for the model to rest on. Always shown in 3D view.
 *  Constant dimensions (not derived from the model) so the floor stays a consistent
 *  reference and the cell spacing doesn't change between designs. Line colors are
 *  theme-aware (passed from ModelCanvas); they default to the dark-theme values. */
export function GroundGrid({
  cellColor = CELL_COLOR,
  sectionColor = SECTION_COLOR,
}: {
  cellColor?: string;
  sectionColor?: string;
} = {}) {
  return (
    <Grid
      position={[0, 0, 0]}
      args={[GRID_SIZE, GRID_SIZE]}
      cellSize={CELL_SIZE}
      cellThickness={0.5}
      cellColor={cellColor}
      sectionSize={SECTION_SIZE}
      sectionThickness={0.5}
      sectionColor={sectionColor}
      fadeDistance={FADE_DISTANCE}
      fadeStrength={FADE_STRENGTH}
      infiniteGrid={false}
    />
  );
}
