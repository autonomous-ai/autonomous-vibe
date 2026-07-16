import { BufferGeometry } from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { labelShells } from "./labelShells";

/** Connected-component (shell/part) labeling of a rendered mesh, keyed to the geometry it came
 *  from. Shared by the exploded view (moves parts apart) and the random part colors (tints them),
 *  so the expensive weld + union-find runs at most once per model. */
export interface MeshShells {
  /** Shell id per rendered vertex (aligned with the geometry's position attribute). */
  shellOfVertex: Uint32Array;
  /** Shell id per triangle (non-indexed soup: triangle t owns vertices 3t..3t+2). */
  solidOfTri: Uint32Array;
  /** Distinct shells found (>= 1). Below 2 there is nothing to separate or distinguish. */
  leafCount: number;
}

// Cache by geometry object so both features reuse one labeling; entries drop when the geometry is
// garbage-collected (a model switch releases the old geometry).
const cache = new WeakMap<BufferGeometry, MeshShells>();

/**
 * Label the connected shells of a rendered (non-indexed STL soup) geometry. Welds a POSITION-ONLY
 * copy to recover the shared-edge topology the soup lost — mergeVertices merges only when ALL
 * attributes match, so the creased normals would otherwise shatter each shell at every hard edge —
 * then runs meshStep's manifold-edge union-find. Triangle order is preserved, so welded triangle t
 * still maps to soup triangle t. Result is cached per geometry.
 */
export function getMeshShells(geometry: BufferGeometry): MeshShells {
  const cached = cache.get(geometry);
  if (cached) return cached;

  const posAttr = geometry.getAttribute("position");
  const nVerts = posAttr.count;
  const nTri = Math.floor(nVerts / 3);

  const posOnly = new BufferGeometry();
  posOnly.setAttribute("position", posAttr.clone());
  const welded = mergeVertices(posOnly);
  const weldedIndex = welded.getIndex();
  const solidOfTri = new Uint32Array(nTri);
  const leafCount = weldedIndex
    ? labelShells(Uint32Array.from(weldedIndex.array as ArrayLike<number>), solidOfTri)
    : 1;
  welded.dispose();
  posOnly.dispose();

  const shellOfVertex = new Uint32Array(nVerts);
  for (let v = 0; v < nVerts; v++) shellOfVertex[v] = solidOfTri[Math.floor(v / 3)]!;

  const result: MeshShells = { shellOfVertex, solidOfTri, leafCount };
  cache.set(geometry, result);
  return result;
}
