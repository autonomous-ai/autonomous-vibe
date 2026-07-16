import { create } from "zustand";

/** A picked surface point: its world-space position plus the world-space normal of the
 *  face that was hit. The normal lets two picks report the angle between the surfaces
 *  (3dviewer.net-style) without needing a third point. */
export interface MeasurePick {
  position: [number, number, number];
  normal: [number, number, number];
}

/** Measure tool state: the user clicks two points on the model and the viewer reports
 *  the straight-line distance between them and the angle between the two surfaces.
 *  Ephemeral (not persisted) — picks are model-relative, so they reset per session and
 *  are wiped when the tool is turned off. Mirrors the cross-section store. */
interface MeasureState {
  /** Master toggle — when false the layer ignores clicks and hides its markers. */
  enabled: boolean;
  /** World-space picks. Holds at most two; a third pick starts a fresh measurement. */
  picks: MeasurePick[];

  /** Toggle the tool. Turning it off clears any in-progress measurement. */
  setEnabled: (enabled: boolean) => void;
  /** Record a surface pick. A third pick starts a new measurement from that point. */
  addPick: (pick: MeasurePick) => void;
  /** Drop all picks but keep the tool on. */
  clear: () => void;
}

export const useMeasureStore = create<MeasureState>()((set) => ({
  enabled: false,
  picks: [],

  setEnabled: (enabled) => set(enabled ? { enabled } : { enabled, picks: [] }),
  addPick: (pick) => set((s) => ({ picks: s.picks.length >= 2 ? [pick] : [...s.picks, pick] })),
  clear: () => set({ picks: [] }),
}));
