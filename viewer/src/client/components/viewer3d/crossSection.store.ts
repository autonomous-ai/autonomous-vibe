import { create } from "zustand";
import type { SectionAxis } from "./section";

/** Default rotation (radians) for a fresh custom plane — starts axis-aligned to X. */
const DEFAULT_ROTATION: [number, number, number] = [0, 0, 0];

/** Cross-section tool state: the interactive clipping plane that slices the model to
 *  reveal its interior. Ephemeral (not persisted) — the plane is model-relative, so
 *  it resets per session rather than carrying stale geometry across reloads. */
interface CrossSectionState {
  /** Master toggle — when false the model renders whole, no clipping. */
  enabled: boolean;
  /** Plane orientation: a world axis or a freely-rotated custom plane. */
  axis: SectionAxis;
  /** Plane position along its normal, normalized −1…1 across the model's extent. */
  position: number;
  /** Euler rotation (radians) for `custom` axis — ignored for X/Y/Z. */
  rotation: [number, number, number];
  /** Reverse which half is kept (swaps the exposed cut face to the other side). */
  flip: boolean;
  /** Render the clipped-away half (ghosted) instead of hiding it completely. */
  showHiddenHalf: boolean;
  /** Opacity 0…1 of the ghosted hidden half when `showHiddenHalf` is on. */
  hiddenOpacity: number;
  /** Cap the exposed cut with a contrasting solid so the section reads clearly. */
  highlightCut: boolean;

  setEnabled: (enabled: boolean) => void;
  setAxis: (axis: SectionAxis) => void;
  setPosition: (position: number) => void;
  setRotation: (rotation: [number, number, number]) => void;
  toggleFlip: () => void;
  setShowHiddenHalf: (show: boolean) => void;
  setHiddenOpacity: (opacity: number) => void;
  setHighlightCut: (highlight: boolean) => void;
  /** Restore the default section view (centered, axis-aligned, unflipped) — keeps the
   *  tool enabled. */
  reset: () => void;
}

const DEFAULTS = {
  axis: "x" as SectionAxis,
  position: 0,
  rotation: DEFAULT_ROTATION,
  flip: false,
};

export const useCrossSectionStore = create<CrossSectionState>()((set) => ({
  enabled: false,
  ...DEFAULTS,
  showHiddenHalf: true,
  hiddenOpacity: 0.15,
  // Default on: the stencil cap gives an immediate solid-cut read during slider drags and
  // is the fallback whenever the CSG solid can't build (non-watertight meshes). Once the
  // CSG solid settles it takes over and the cap is suppressed (see StlModel).
  highlightCut: true,

  setEnabled: (enabled) => set({ enabled }),
  setAxis: (axis) => set({ axis }),
  setPosition: (position) => set({ position }),
  setRotation: (rotation) => set({ rotation }),
  toggleFlip: () => set((s) => ({ flip: !s.flip })),
  setShowHiddenHalf: (showHiddenHalf) => set({ showHiddenHalf }),
  setHiddenOpacity: (hiddenOpacity) => set({ hiddenOpacity }),
  setHighlightCut: (highlightCut) => set({ highlightCut }),
  reset: () => set({ ...DEFAULTS }),
}));
