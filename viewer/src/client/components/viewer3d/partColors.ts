import { type BufferGeometry, Color, SRGBColorSpace } from "three";
import { getMeshShells } from "./meshShells";

/**
 * Per-part color buffer for a colorless model — copied from meshStep (CNCKitchen/meshStep,
 * web/src/main.ts): each shell gets a distinct golden-ratio hue (`(0.08 + i * φ⁻¹) mod 1`, sat
 * 0.55, light 0.55) so adjacent parts read apart at a glance. setHSL with SRGBColorSpace stores
 * the color in the linear working space, which is exactly what a vertex-color buffer feeds the
 * shader.
 *
 * The rendered geometry is a NON-INDEXED soup (each triangle owns its 3 vertices), so — unlike
 * upstream's `splitByTriColor`, which duplicates shared welded vertices on color borders — the
 * color attribute can be written straight from the per-vertex shell ids with no bleed.
 *
 * @returns a per-vertex linear-RGB Float32Array, or null when the model is a single part (nothing
 *          to distinguish — mirrors meshStep only offering this above 1 part).
 */
export function buildPartColors(geometry: BufferGeometry): Float32Array | null {
  const { shellOfVertex, leafCount } = getMeshShells(geometry);
  if (leafCount < 2) return null;

  const c = new Color();
  const palette: [number, number, number][] = [];
  for (let i = 0; i < leafCount; i++) {
    c.setHSL((0.08 + i * 0.61803398875) % 1, 0.55, 0.55, SRGBColorSpace);
    palette.push([c.r, c.g, c.b]);
  }

  const colors = new Float32Array(shellOfVertex.length * 3);
  for (let v = 0; v < shellOfVertex.length; v++) {
    const rgb = palette[shellOfVertex[v]!]!;
    colors[v * 3] = rgb[0];
    colors[v * 3 + 1] = rgb[1];
    colors[v * 3 + 2] = rgb[2];
  }
  return colors;
}
