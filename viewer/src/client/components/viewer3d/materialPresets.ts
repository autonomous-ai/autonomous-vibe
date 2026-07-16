/** A solid-view material look the user can switch between to inspect the part —
 *  color plus the PBR knobs that give each preset a distinct read (a metallic vs.
 *  matte surface catches the light very differently). Colors are literal hex: these
 *  feed three.js materials, which have no design-token system. */
export interface MaterialPreset {
  id: string;
  name: string;
  color: string;
  metalness: number;
  roughness: number;
  /** Clearcoat layer strength (0–1) — a thin glossy top coat over the base paint,
   *  the studio-render "2-layer" look. 0 disables it (raw metal/matte). */
  clearcoat: number;
  /** Clearcoat micro-roughness (0 = mirror gloss, 1 = satin). */
  clearcoatRoughness: number;
  /** How strongly the surface samples the scene environment for reflections.
   *  Higher makes metals pop; keep low on matte/resin so they stay soft. */
  envMapIntensity: number;
}

/** Molten orange — the brand accent. A glossy clearcoat over the pigment reads as
 *  automotive/injection-molded plastic. */
export const DEFAULT_MATERIAL_PRESET: MaterialPreset = {
  id: "brand",
  name: "Molten orange",
  color: "#FF6A2B",
  metalness: 0.15,
  roughness: 0.55,
  clearcoat: 0.6,
  clearcoatRoughness: 0.2,
  envMapIntensity: 0.6,
};

/** Presets tuned to reveal different surface features: the brand accent, neutral for
 *  a true read, steel to pop machined facets, graphite for high-contrast crevices, and
 *  resin for a soft print-like look. */
export const MATERIAL_PRESETS: MaterialPreset[] = [
  DEFAULT_MATERIAL_PRESET,
  {
    id: "gray",
    name: "Neutral gray",
    color: "#cfd3da",
    metalness: 0.1,
    roughness: 0.65,
    clearcoat: 0.3,
    clearcoatRoughness: 0.35,
    envMapIntensity: 0.5,
  },
  {
    id: "steel",
    name: "Steel",
    color: "#b8bec7",
    metalness: 0.9,
    roughness: 0.35,
    clearcoat: 0.4,
    clearcoatRoughness: 0.15,
    envMapIntensity: 1.0,
  },
  {
    id: "graphite",
    name: "Graphite",
    color: "#3b404b",
    metalness: 0.05,
    roughness: 0.9,
    clearcoat: 0.2,
    clearcoatRoughness: 0.5,
    envMapIntensity: 0.4,
  },
  {
    id: "resin",
    name: "Resin white",
    color: "#f2f0ec",
    metalness: 0.0,
    roughness: 0.8,
    clearcoat: 0.1,
    clearcoatRoughness: 0.6,
    envMapIntensity: 0.3,
  },
];
