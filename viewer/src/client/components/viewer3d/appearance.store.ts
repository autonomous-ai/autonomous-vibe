import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ControlMode } from "./ModelCanvas";
import { DEFAULT_MATERIAL_PRESET } from "./materialPresets";
import type { RenderMode } from "./StlModel";

/** Viewer preferences the user last chose — the shading mode (solid/x-ray), the
 *  solid material preset, and the camera control style. Persisted so the picks
 *  survive reloads and carry across models. Material is stored by id (not the whole
 *  preset) so preset tweaks don't leave stale color/finish in localStorage. */
interface AppearanceState {
  mode: RenderMode;
  materialId: string;
  controls: ControlMode;
  /** Swap the matte grid floor for a dark glossy planar-reflection floor — a studio
   *  look that mirrors the model. Extra render pass, so off by default and toggled
   *  from the overlay. */
  reflectiveFloor: boolean;
  /** Add a subtle screen-space bloom post-process pass so bright highlights and
   *  reflections bleed a soft glow (studio-render finish). Extra full-frame pass, so
   *  off by default and toggled from the appearance menu. */
  bloom: boolean;
  /** Tint each connected part of the model a distinct golden-ratio hue so an assembly's
   *  pieces are easy to tell apart (pairs well with the exploded view). Only affects the
   *  solid view; no-op on a single-part model. */
  partColors: boolean;
  /** Overlay the model's feature edges — mesh edges whose adjacent faces meet at more than
   *  `featureAngle` degrees (plus open/non-manifold edges), the STL stand-in for CAD face
   *  borders. A crisp blueprint-style outline over the shaded surface. */
  featureEdges: boolean;
  /** Dihedral threshold (degrees, 1–179) above which an edge counts as a feature edge.
   *  Lower = more edges (finer detail), higher = only the sharpest creases. */
  featureAngle: number;
  setMode: (mode: RenderMode) => void;
  setMaterialId: (id: string) => void;
  setControls: (controls: ControlMode) => void;
  setReflectiveFloor: (on: boolean) => void;
  setBloom: (on: boolean) => void;
  setPartColors: (on: boolean) => void;
  setFeatureEdges: (on: boolean) => void;
  setFeatureAngle: (deg: number) => void;
}

export const useAppearanceStore = create<AppearanceState>()(
  persist(
    (set) => ({
      mode: "solid",
      materialId: DEFAULT_MATERIAL_PRESET.id,
      controls: "trackball",
      reflectiveFloor: false,
      bloom: false,
      partColors: true,
      featureEdges: true,
      featureAngle: 20,
      setMode: (mode) => set({ mode }),
      setMaterialId: (materialId) => set({ materialId }),
      setControls: (controls) => set({ controls }),
      setReflectiveFloor: (reflectiveFloor) => set({ reflectiveFloor }),
      setBloom: (bloom) => set({ bloom }),
      setPartColors: (partColors) => set({ partColors }),
      setFeatureEdges: (featureEdges) => set({ featureEdges }),
      setFeatureAngle: (featureAngle) =>
        set({ featureAngle: Math.min(179, Math.max(1, Math.round(featureAngle))) }),
    }),
    {
      name: "panda-viewer-appearance",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        mode: s.mode,
        materialId: s.materialId,
        controls: s.controls,
        reflectiveFloor: s.reflectiveFloor,
        bloom: s.bloom,
        partColors: s.partColors,
        featureEdges: s.featureEdges,
        featureAngle: s.featureAngle,
      }),
    },
  ),
);
