// Ported from meshStep (CNCKitchen/meshStep, web/src/worker.ts, AGPL-3.0-only) — the STL shell
// splitter that turns one mesh into the per-part instances the exploded view moves apart.
import { EdgeTable } from "./edgeTable";

/**
 * Label each triangle with its connected component (shell) so a multi-shell STL gets per-shell
 * part ids. Triangles connect only across MANIFOLD edges (exactly 2 incident triangles): welding
 * coincident vertices makes touching solids share whole edges at their contact faces, and those
 * carry 4 triangles — treating them as boundaries splits the shells the same way slicers
 * (admesh / BambuStudio) do. Vertex- or plain edge-connectivity would fuse them.
 *
 * @param indices  Welded triangle index buffer (3 per triangle), in triangle order.
 * @param solidOfTri  Output buffer (length = triangle count) filled with the shell id per triangle.
 * @returns the number of distinct shells (>= 1).
 */
export function labelShells(indices: Uint32Array, solidOfTri: Uint32Array): number {
  const nT = solidOfTri.length;
  // Pass 1: incident-triangle count per undirected edge (EdgeTable — a Map caps at 2^24 edges).
  const et = new EdgeTable(nT * 1.6, 1);
  for (let t = 0; t < nT; t++) {
    for (let e = 0; e < 3; e++) {
      et.bump(indices[t * 3 + e]!, indices[t * 3 + ((e + 1) % 3)]!);
    }
  }
  // Pass 2: union the two triangles of every manifold edge (v0 = the edge's first triangle).
  const parent = new Uint32Array(nT);
  for (let i = 0; i < nT; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) {
      parent[r] = parent[parent[r]!]!; // path-halving
      r = parent[r]!;
    }
    return r;
  };
  for (let t = 0; t < nT; t++) {
    for (let e = 0; e < 3; e++) {
      const s = et.find(indices[t * 3 + e]!, indices[t * 3 + ((e + 1) % 3)]!);
      if (et.cnt[s]! !== 2) continue;
      if (et.v0[s] === -1) et.v0[s] = t;
      else if (et.v0[s] !== t) parent[find(t)] = find(et.v0[s]!);
    }
  }
  const shellOfRoot = new Map<number, number>();
  for (let t = 0; t < nT; t++) {
    const r = find(t);
    let s = shellOfRoot.get(r);
    if (s === undefined) {
      s = shellOfRoot.size;
      shellOfRoot.set(r, s);
    }
    solidOfTri[t] = s;
  }
  return Math.max(1, shellOfRoot.size);
}
