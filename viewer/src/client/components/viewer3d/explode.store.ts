import { create } from "zustand";
import type { ExplodeAxis, ExplodeStyle } from "./explode";

/** Exploded-view tool state: separates the model's parts along the slider factor. Ephemeral (not
 *  persisted) like the cross-section tool — the offsets are model-relative, so the tool resets per
 *  session. `style`/`axis` are session preferences that survive model switches within a session. */
interface ExplodeState {
  /** Master toggle — when false the model renders assembled. */
  enabled: boolean;
  /** Explosion amount 0 (assembled) … 1 (fully apart). */
  factor: number;
  /** Arrangement style for the offsets. */
  style: ExplodeStyle;
  /** Stack direction for the `axis` style (ignored otherwise). */
  axis: ExplodeAxis;
  /** Distinct parts detected in the loaded model (< 2 = nothing to explode). Written by the rig
   *  once it has built the explode data, read by the panel to show the single-part note. */
  leafCount: number;

  setEnabled: (enabled: boolean) => void;
  setFactor: (factor: number) => void;
  setStyle: (style: ExplodeStyle) => void;
  setAxis: (axis: ExplodeAxis) => void;
  setLeafCount: (leafCount: number) => void;
}

export const useExplodeStore = create<ExplodeState>()((set) => ({
  enabled: false,
  factor: 0.6,
  style: "hierarchical",
  axis: "auto",
  leafCount: 0,

  setEnabled: (enabled) => set({ enabled }),
  setFactor: (factor) => set({ factor }),
  setStyle: (style) => set({ style }),
  setAxis: (axis) => set({ axis }),
  setLeafCount: (leafCount) => set({ leafCount }),
}));
