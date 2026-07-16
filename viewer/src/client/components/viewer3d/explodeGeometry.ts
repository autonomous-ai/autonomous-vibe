import type { BufferGeometry } from "three";
import { type ExplodeAxis, type ExplodeStyle, buildExplode } from "./explode";
import { getMeshShells } from "./meshShells";

/** Everything the ExplodeRig needs to displace the rendered mesh into an exploded view. */
export interface ExplodeData {
  /** Distinct shells (parts) found — below 2 there is nothing to explode. */
  leafCount: number;
  /** Shell/instance id per rendered vertex (aligned with the geometry's position attribute). */
  shellOfVertex: Uint32Array;
  /** Pristine copy of the rendered positions — factor 0 restores this exactly. */
  base: Float32Array;
  /** Per-instance world offsets at factor f, 3 floats per instance. */
  offsetsAt: (f: number, style: ExplodeStyle, axis: ExplodeAxis) => Float64Array;
}

/**
 * Bridge between three.js geometry and meshStep's ported explode algorithm. Reuses the shared
 * shell labeling (getMeshShells) — the rendered geometry is a NON-INDEXED triangle soup, so
 * triangle t owns vertices 3t..3t+2 — then feeds the soup positions + per-triangle shell ids to
 * buildExplode. Heavy weld/labeling happens once per model (cached); call lazily on first explode.
 */
export function buildExplodeData(geometry: BufferGeometry): ExplodeData {
  const posAttr = geometry.getAttribute("position");
  const base = Float32Array.from(posAttr.array as ArrayLike<number>);
  const { shellOfVertex, solidOfTri, leafCount } = getMeshShells(geometry);

  // A single flat body per shell; the algorithm groups them radially about the centroid.
  const structure = {
    bodies: Array.from({ length: leafCount }, (_, i) => ({ id: i })),
    children: [],
  };
  const info = buildExplode({ positions: base, indices: null, solidOfTri, structure });

  return { leafCount: info.leafCount, shellOfVertex, base, offsetsAt: info.offsetsAt };
}
