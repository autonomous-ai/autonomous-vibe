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
  setMode: (mode: RenderMode) => void;
  setMaterialId: (id: string) => void;
  setControls: (controls: ControlMode) => void;
}

export const useAppearanceStore = create<AppearanceState>()(
  persist(
    (set) => ({
      mode: "solid",
      materialId: DEFAULT_MATERIAL_PRESET.id,
      controls: "trackball",
      setMode: (mode) => set({ mode }),
      setMaterialId: (materialId) => set({ materialId }),
      setControls: (controls) => set({ controls }),
    }),
    {
      name: "panda-viewer-appearance",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ mode: s.mode, materialId: s.materialId, controls: s.controls }),
    },
  ),
);
