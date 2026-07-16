import { BufferGeometry } from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { EdgeTable } from "./edgeTable";
import { getMeshShells } from "./meshShells";

/**
 * Feature edges (by angle) — ported from meshStep (CNCKitchen/meshStep,
 * web/src/mesh-utils.ts `creaseEdges`, AGPL-3.0-only). An STL has no B-rep, so its
 * "CAD face borders" are recovered from the mesh itself: an interior edge is a feature
 * (crease) edge when its two adjacent triangles' normals differ by more than `angleDeg`.
 * Boundary edges (used by one triangle) and non-manifold junctions (3+ triangles) always
 * count. Degenerate (zero-area) triangles never register a crease.
 *
 * Returns a flat LineSegments-ready position buffer (6 floats per segment) in the same
 * local space as the input geometry, plus a parallel per-line-vertex shell id (2 per
 * segment) so the exploded view can displace each edge with the part it belongs to.
 */

/** Feature-edge geometry plus the shell (connected part) each line vertex belongs to. */
export interface FeatureEdges {
  /** Flat LineSegments positions: 6 floats per segment (start xyz, end xyz). */
  positions: Float32Array;
  /** Shell id per line vertex (aligned with `positions`, one per 3 floats). Matches the
   *  shell numbering from `getMeshShells`, so the explode offsets index straight in. */
  shells: Uint32Array;
}

// geometry -> (rounded angleDeg -> feature edges). Cached because a soup weld + full edge
// scan is O(triangles); the angle slider re-reads the same geometry repeatedly, and a model
// switch releases the old geometry (WeakMap entry drops with it).
const cache = new WeakMap<BufferGeometry, Map<number, FeatureEdges>>();

const EMPTY: FeatureEdges = { positions: new Float32Array(0), shells: new Uint32Array(0) };

export function buildFeatureEdges(geometry: BufferGeometry, angleDeg: number): FeatureEdges {
  const key = Math.round(Math.min(179, Math.max(1, angleDeg)));
  let byAngle = cache.get(geometry);
  if (byAngle) {
    const hit = byAngle.get(key);
    if (hit) return hit;
  } else {
    byAngle = new Map();
    cache.set(geometry, byAngle);
  }

  // The rendered STL is a non-indexed triangle soup — each triangle owns its 3 vertices, so
  // shared edges are lost. Weld a POSITION-ONLY copy (mergeVertices merges only when every
  // attribute matches, so the creased normals would otherwise re-split every hard edge) to
  // recover the shared-edge topology the crease scan needs.
  const posAttr = geometry.getAttribute("position");
  const posOnly = new BufferGeometry();
  posOnly.setAttribute("position", posAttr.clone());
  const welded = mergeVertices(posOnly);
  const weldedIndex = welded.getIndex();
  // Per-triangle shell ids: getMeshShells welds the same soup and preserves triangle order,
  // so welded triangle t maps to solidOfTri[t] — the part every edge of that triangle sits on.
  const { solidOfTri } = getMeshShells(geometry);
  const result = weldedIndex
    ? creaseEdgePositions(
        welded.getAttribute("position").array as ArrayLike<number>,
        Uint32Array.from(weldedIndex.array as ArrayLike<number>),
        key,
        solidOfTri,
      )
    : EMPTY;
  welded.dispose();
  posOnly.dispose();

  byAngle.set(key, result);
  return result;
}

/** Core crease-edge extraction over an indexed mesh (positions + triangle index). */
function creaseEdgePositions(
  pos: ArrayLike<number>,
  idx: Uint32Array,
  angleDeg: number,
  solidOfTri: Uint32Array,
): FeatureEdges {
  const tris = idx.length / 3;

  // Per-triangle unit normals; a zero-length (degenerate) normal stays [0,0,0] and is flagged
  // so it can never pass the angle test against a real normal.
  const nrm = new Float32Array(tris * 3);
  const degenerate = new Uint8Array(tris);
  for (let t = 0; t < tris; t++) {
    const a = idx[t * 3]! * 3;
    const b = idx[t * 3 + 1]! * 3;
    const c = idx[t * 3 + 2]! * 3;
    const abx = pos[b]! - pos[a]!;
    const aby = pos[b + 1]! - pos[a + 1]!;
    const abz = pos[b + 2]! - pos[a + 2]!;
    const acx = pos[c]! - pos[a]!;
    const acy = pos[c + 1]! - pos[a + 1]!;
    const acz = pos[c + 2]! - pos[a + 2]!;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l < 1e-30) {
      degenerate[t] = 1;
      continue;
    }
    nrm[t * 3] = nx / l;
    nrm[t * 3 + 1] = ny / l;
    nrm[t * 3 + 2] = nz / l;
  }

  const cosThresh = Math.cos((angleDeg * Math.PI) / 180);

  // EdgeTable (no 2^24 Map cap): cnt = use-count, v0 = first incident triangle, v1 = flag bits.
  const CREASE = 1;
  const SEEN = 2;
  const et = new EdgeTable(idx.length / 2, 2);
  const consider = (a: number, b: number, t: number): void => {
    const s = et.bump(a, b);
    const n = et.cnt[s]!;
    if (n === 1) {
      et.v0[s] = t;
      et.v1[s] = 0; // v1 lane initialises to -1, not 0
      return;
    }
    if (n > 2) {
      et.v1[s] = et.v1[s]! | CREASE; // non-manifold junction
      return;
    }
    const o = et.v0[s]!;
    if (degenerate[o] || degenerate[t]) return;
    const dot =
      nrm[o * 3]! * nrm[t * 3]! +
      nrm[o * 3 + 1]! * nrm[t * 3 + 1]! +
      nrm[o * 3 + 2]! * nrm[t * 3 + 2]!;
    if (dot < cosThresh) et.v1[s] = et.v1[s]! | CREASE;
  };
  for (let t = 0; t < tris; t++) {
    const a = idx[t * 3]!;
    const b = idx[t * 3 + 1]!;
    const c = idx[t * 3 + 2]!;
    consider(a, b, t);
    consider(b, c, t);
    consider(c, a, t);
  }

  const out: number[] = [];
  // Shell id per emitted line vertex — the edge is emitted while walking triangle t, which is
  // incident to it, so solidOfTri[t] is the part both endpoints sit on (a shell is connected).
  const outShells: number[] = [];
  const emit = (u: number, v: number, t: number): void => {
    const k = et.find(u, v);
    if (et.v1[k]! & SEEN) return;
    if (et.cnt[k]! !== 1 && !(et.v1[k]! & CREASE)) return; // smooth interior edge: skip
    et.v1[k] = et.v1[k]! | SEEN;
    out.push(pos[u * 3]!, pos[u * 3 + 1]!, pos[u * 3 + 2]!);
    out.push(pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!);
    const shell = solidOfTri[t]!;
    outShells.push(shell, shell);
  };
  for (let t = 0; t < tris; t++) {
    const a = idx[t * 3]!;
    const b = idx[t * 3 + 1]!;
    const c = idx[t * 3 + 2]!;
    emit(a, b, t);
    emit(b, c, t);
    emit(c, a, t);
  }
  return { positions: new Float32Array(out), shells: Uint32Array.from(outShells) };
}
