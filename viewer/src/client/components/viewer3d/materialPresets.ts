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
}

/** Neutral gray — a true, unbiased read of the surface. The default look. */
export const DEFAULT_MATERIAL_PRESET: MaterialPreset = {
  id: "gray",
  name: "Neutral gray",
  color: "#cfd3da",
  metalness: 0.1,
  roughness: 0.65,
};

/** Presets tuned to reveal different surface features: neutral for a true read,
 *  steel to pop machined facets, graphite for high-contrast crevices, resin for a
 *  soft print-like look, and the brand accent. */
export const MATERIAL_PRESETS: MaterialPreset[] = [
  DEFAULT_MATERIAL_PRESET,
  { id: "steel", name: "Steel", color: "#b8bec7", metalness: 0.9, roughness: 0.35 },
  { id: "graphite", name: "Graphite", color: "#3b404b", metalness: 0.05, roughness: 0.9 },
  { id: "resin", name: "Resin white", color: "#f2f0ec", metalness: 0.0, roughness: 0.8 },
  { id: "brand", name: "Molten orange", color: "#FF6A2B", metalness: 0.15, roughness: 0.55 },
];
