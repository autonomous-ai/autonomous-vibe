// Ported from meshStep (CNCKitchen/meshStep, web/src/explode.ts, AGPL-3.0-only). The offset math
// (the five arrangement styles) is copied verbatim; only the inputs are adapted to this viewer's
// STL pipeline. Upstream also infers pin-in-hole MATE AXES from analytic CAD (STEP) face data so
// fasteners back straight out of their holes — the STL loader carries no B-rep faces, so that
// inference can never run here and upstream documents the result: "Flat trees (STL / 3MF /
// single-part STEP) degrade to a plain radial explosion naturally." `mateAxis` therefore stays a
// zero vector for every part, which keeps the offset functions byte-identical to upstream while
// the mate branch simply never fires.
//
// All geometry statistics come from the placed mesh, so a part used ×N explodes as N occurrences.

/** How the parts move apart:
 *  - hierarchical — assembly-tree grouped (the smart default; flat for a single STL).
 *  - radial — classic scale-about-COG, ignores hierarchy.
 *  - axis — stack-up along one direction, like a layered drawing.
 *  - peel — outermost parts fly away first; the slider is "how deep have I disassembled".
 *  - layout — parts travel to a flat grid in front of the assembly (workbench inventory). */
export type ExplodeStyle = "hierarchical" | "radial" | "axis" | "peel" | "layout";
export type ExplodeAxis = "auto" | "x" | "y" | "z";

/** Flat part tree: each body is one shell of the STL. Upstream's PartNode carries nested
 *  sub-assemblies from STEP; an STL only ever produces this one-level form. */
export interface PartNode {
  bodies: { id: number }[];
  children: PartNode[];
}

export interface ExplodeInfo {
  /** Placed occurrences that actually carry geometry — below 2 there is nothing to explode. */
  leafCount: number;
  /** World offset per instance at explode factor f in [0,1], 3 floats per instance. */
  offsetsAt(f: number, style?: ExplodeStyle, axis?: ExplodeAxis): Float64Array;
}

/** Overall explosion strength: at factor 1 a group's distance from its parent centroid grows
 * by this multiple (classic scale-about-centroid explode, so concentric nesting stays nested). */
const K = 1.75;

interface XNode {
  /** Instance index for a leaf (one placed body occurrence); -1 for a group. */
  inst: number;
  children: XNode[];
  /** Area-weighted surface centroid (x, y, z) and total area weight. */
  c: [number, number, number];
  w: number;
  /** Bounding box (union of children) and its half diagonal. */
  bb: [number, number, number, number, number, number];
  r: number;
}

const EMPTY_BB: XNode["bb"] = [
  Number.POSITIVE_INFINITY,
  Number.POSITIVE_INFINITY,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

function groupOf(children: XNode[]): XNode {
  const bb: XNode["bb"] = [...EMPTY_BB];
  let w = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const k of children) {
    w += k.w;
    cx += k.c[0] * k.w;
    cy += k.c[1] * k.w;
    cz += k.c[2] * k.w;
    for (let i = 0; i < 3; i++) {
      if (k.bb[i]! < bb[i]!) bb[i] = k.bb[i]!;
      if (k.bb[i + 3]! > bb[i + 3]!) bb[i + 3] = k.bb[i + 3]!;
    }
  }
  const c: XNode["c"] =
    w > 0
      ? [cx / w, cy / w, cz / w]
      : [(bb[0] + bb[3]) / 2, (bb[1] + bb[4]) / 2, (bb[2] + bb[5]) / 2];
  const r = Math.hypot(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]) / 2 || 0;
  return { inst: -1, children, c, w, bb, r };
}

/** Deterministic well-spread unit direction for the k-th concentric sibling (golden spiral). */
function spreadDir(k: number): [number, number, number] {
  const z = 1 - (2 * ((k % 16) + 0.5)) / 16;
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = k * 2.399963229728653; // golden angle
  return [s * Math.cos(phi), s * Math.sin(phi), z];
}

/**
 * Precompute per-shell explosion offsets for a (non-indexed or indexed) triangle mesh.
 *
 * @param positions  Vertex positions, 3 floats per vertex.
 * @param indices    Triangle index buffer (3 per triangle), or null for a non-indexed soup where
 *                   triangle t owns vertices 3t, 3t+1, 3t+2.
 * @param solidOfTri Shell id per triangle (from labelShells). Doubles as the instance mapping.
 * @param structure  Flat part tree whose body ids key into `solidOfTri`.
 */
export function buildExplode(args: {
  positions: Float32Array | Float64Array;
  indices: Uint32Array | null;
  solidOfTri: Uint32Array;
  structure: PartNode;
}): ExplodeInfo {
  const { positions: pos, indices: idx, solidOfTri, structure } = args;
  const instanceOfTri = solidOfTri; // STL: every body is one dense occurrence.
  let maxS = -1;
  for (let t = 0; t < solidOfTri.length; t++) if (solidOfTri[t]! > maxS) maxS = solidOfTri[t]!;
  const nI = maxS + 1;

  // ---- per-instance statistics: area-weighted centroid + bbox (one pass over the mesh) ----
  const accW = new Float64Array(nI);
  const accC = new Float64Array(nI * 3);
  const bb = new Float64Array(nI * 6);
  for (let i = 0; i < nI; i++) {
    bb[i * 6] = bb[i * 6 + 1] = bb[i * 6 + 2] = Number.POSITIVE_INFINITY;
    bb[i * 6 + 3] = bb[i * 6 + 4] = bb[i * 6 + 5] = Number.NEGATIVE_INFINITY;
  }
  const nT = instanceOfTri.length;
  for (let t = 0; t < nT; t++) {
    const i = instanceOfTri[t]!;
    const a = (idx ? idx[t * 3]! : t * 3) * 3;
    const b = (idx ? idx[t * 3 + 1]! : t * 3 + 1) * 3;
    const c = (idx ? idx[t * 3 + 2]! : t * 3 + 2) * 3;
    const ax = pos[a]!;
    const ay = pos[a + 1]!;
    const az = pos[a + 2]!;
    const bx = pos[b]!;
    const by = pos[b + 1]!;
    const bz = pos[b + 2]!;
    const cx = pos[c]!;
    const cy = pos[c + 1]!;
    const cz = pos[c + 2]!;
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const w = Math.sqrt(nx * nx + ny * ny + nz * nz); // 2 × area — only relative weight matters
    accW[i]! += w;
    accC[i * 3]! += (w * (ax + bx + cx)) / 3;
    accC[i * 3 + 1]! += (w * (ay + by + cy)) / 3;
    accC[i * 3 + 2]! += (w * (az + bz + cz)) / 3;
    const o = i * 6;
    if (ax < bb[o]!) bb[o] = ax;
    if (ax > bb[o + 3]!) bb[o + 3] = ax;
    if (ay < bb[o + 1]!) bb[o + 1] = ay;
    if (ay > bb[o + 4]!) bb[o + 4] = ay;
    if (az < bb[o + 2]!) bb[o + 2] = az;
    if (az > bb[o + 5]!) bb[o + 5] = az;
    if (bx < bb[o]!) bb[o] = bx;
    if (bx > bb[o + 3]!) bb[o + 3] = bx;
    if (by < bb[o + 1]!) bb[o + 1] = by;
    if (by > bb[o + 4]!) bb[o + 4] = by;
    if (bz < bb[o + 2]!) bb[o + 2] = bz;
    if (bz > bb[o + 5]!) bb[o + 5] = bz;
    if (cx < bb[o]!) bb[o] = cx;
    if (cx > bb[o + 3]!) bb[o + 3] = cx;
    if (cy < bb[o + 1]!) bb[o + 1] = cy;
    if (cy > bb[o + 4]!) bb[o + 4] = cy;
    if (cz < bb[o + 2]!) bb[o + 2] = cz;
    if (cz > bb[o + 5]!) bb[o + 5] = cz;
  }

  const leafOf = (i: number): XNode | null => {
    if (accW[i]! <= 0 && bb[i * 6]! === Number.POSITIVE_INFINITY) return null; // no triangles (skipped solid)
    const o = i * 6;
    const box: XNode["bb"] = [bb[o]!, bb[o + 1]!, bb[o + 2]!, bb[o + 3]!, bb[o + 4]!, bb[o + 5]!];
    const w = accW[i]!;
    const c: XNode["c"] =
      w > 0
        ? [accC[i * 3]! / w, accC[i * 3 + 1]! / w, accC[i * 3 + 2]! / w]
        : [(box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2];
    const r = Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]) / 2 || 0;
    return { inst: i, children: [], c, w, bb: box, r };
  };

  // ---- explosion tree mirroring the part tree; bodies expand to their placed instances ----
  const covered = new Set<number>();
  const bodyNode = (solidId: number): XNode | null => {
    // STL instances are dense (solidId === instance index), so a body maps to exactly one leaf.
    const leaf = solidId < nI ? leafOf(solidId) : null;
    if (!leaf) return null;
    covered.add(solidId);
    return leaf;
  };
  // Single-child chains collapse (wrapper products carry no geometry of their own), so tree
  // depth below counts only BRANCHING levels — the level-gain staggering isn't wasted on them.
  const partToX = (n: PartNode): XNode | null => {
    const kids: XNode[] = [];
    for (const child of n.children) {
      const x = partToX(child);
      if (x) kids.push(x);
    }
    for (const b of n.bodies) {
      const x = bodyNode(b.id);
      if (x) kids.push(x);
    }
    if (kids.length === 0) return null;
    return kids.length === 1 ? kids[0]! : groupOf(kids);
  };
  let root = partToX(structure);
  // Bodies present in the mesh but absent from the part tree still deserve to move.
  const strays: XNode[] = [];
  for (let i = 0; i < nI; i++) {
    if (covered.has(i)) continue;
    const leaf = leafOf(i);
    if (leaf) strays.push(leaf);
  }
  if (strays.length > 0) root = groupOf(root ? [root, ...strays] : strays);
  const leaves: XNode[] = [];
  const gather = (n: XNode): void => {
    if (n.inst >= 0) {
      leaves.push(n);
      return;
    }
    for (const k of n.children) gather(k);
  };
  if (root) gather(root);
  const leafCount = leaves.length;

  // Global frame shared by the flat styles: area-weighted centroid, bbox, half diagonal.
  const C: [number, number, number] = root ? root.c : [0, 0, 0];
  const GB = root ? root.bb : EMPTY_BB;
  const R = root ? Math.max(root.r, 1e-9) : 1;

  // Mate-axis inference (STEP-only) can never run on an STL — see the file header. Kept as a
  // zero vector per instance so the offset functions stay identical to upstream.
  const mateAxis = new Float64Array(nI * 3);

  const hierarchicalAt = (f: number): Float64Array => {
    const out = new Float64Array(nI * 3);
    if (!root || f <= 0) return out;
    const fac = Math.min(1, f);
    const walk = (
      node: XNode,
      parent: XNode | null,
      siblingIdx: number,
      depth: number,
      ix: number,
      iy: number,
      iz: number,
    ): void => {
      let ox = ix;
      let oy = iy;
      let oz = iz;
      if (parent) {
        const gain = K * fac ** depth;
        const dx = node.c[0] - parent.c[0];
        const dy = node.c[1] - parent.c[1];
        const dz = node.c[2] - parent.c[2];
        const ax3 = node.inst * 3;
        if (
          node.inst >= 0 &&
          (mateAxis[ax3] !== 0 || mateAxis[ax3 + 1] !== 0 || mateAxis[ax3 + 2] !== 0)
        ) {
          // Pin-in-hole part: slide along its mate axis, signed away from the group centroid.
          const ax = mateAxis[ax3]!;
          const ay = mateAxis[ax3 + 1]!;
          const az = mateAxis[ax3 + 2]!;
          const along = dx * ax + dy * ay + dz * az;
          const sign = along >= 0 ? 1 : -1;
          const mag = gain * Math.max(Math.abs(along), node.r);
          ox += ax * sign * mag;
          oy += ay * sign * mag;
          oz += az * sign * mag;
        } else {
          const len = Math.hypot(dx, dy, dz);
          if (len < 1e-6 * Math.max(parent.r, 1e-9)) {
            // Concentric sibling — the centroid delta carries no direction; spread deterministically.
            const [sx, sy, sz] = spreadDir(siblingIdx);
            const mag = gain * Math.max(node.r, parent.r * 0.4);
            ox += sx * mag;
            oy += sy * mag;
            oz += sz * mag;
          } else {
            ox += dx * gain;
            oy += dy * gain;
            oz += dz * gain;
          }
        }
      }
      if (node.inst >= 0) {
        out[node.inst * 3] = ox;
        out[node.inst * 3 + 1] = oy;
        out[node.inst * 3 + 2] = oz;
        return;
      }
      const childDepth = node.children.length > 1 ? depth + 1 : depth;
      node.children.forEach((k, j) => walk(k, node, j, parent ? childDepth : depth, ox, oy, oz));
    };
    walk(root, null, 0, 1, 0, 0, 0);
    return out;
  };

  // ---- radial: classic scale-about-COG (every part's distance to the centroid grows) ----
  const radialAt = (f: number): Float64Array => {
    const out = new Float64Array(nI * 3);
    if (f <= 0) return out;
    leaves.forEach((n, k) => {
      const dx = n.c[0] - C[0];
      const dy = n.c[1] - C[1];
      const dz = n.c[2] - C[2];
      const g = K * Math.min(1, f);
      const o = n.inst * 3;
      if (Math.hypot(dx, dy, dz) < 1e-6 * R) {
        const [sx, sy, sz] = spreadDir(k);
        const mag = g * 0.3 * R;
        out[o] = sx * mag;
        out[o + 1] = sy * mag;
        out[o + 2] = sz * mag;
      } else {
        out[o] = dx * g;
        out[o + 1] = dy * g;
        out[o + 2] = dz * g;
      }
    });
    return out;
  };

  // ---- axis: stack-up along one direction, proportional to each part's station along it ----
  const resolveAxis = (axis: ExplodeAxis): [number, number, number] => {
    if (axis === "x") return [1, 0, 0];
    if (axis === "y") return [0, 1, 0];
    if (axis === "z") return [0, 0, 1];
    // auto: the coordinate axis the mate axes agree on most (screws point along the assembly
    // direction); with no mates, the axis the part centroids spread along most.
    const score = [0, 0, 0];
    let anyMate = false;
    for (let i = 0; i < nI; i++) {
      const ax = mateAxis[i * 3]!;
      const ay = mateAxis[i * 3 + 1]!;
      const az = mateAxis[i * 3 + 2]!;
      if (ax === 0 && ay === 0 && az === 0) continue;
      anyMate = true;
      score[0]! += Math.abs(ax);
      score[1]! += Math.abs(ay);
      score[2]! += Math.abs(az);
    }
    if (!anyMate) {
      const mean = [0, 0, 0];
      for (const n of leaves) {
        mean[0]! += n.c[0];
        mean[1]! += n.c[1];
        mean[2]! += n.c[2];
      }
      for (let d = 0; d < 3; d++) mean[d] = mean[d]! / Math.max(1, leaves.length);
      for (const n of leaves) for (let d = 0; d < 3; d++) score[d]! += (n.c[d]! - mean[d]!) ** 2;
    }
    const best =
      score[0]! >= score[1]! && score[0]! >= score[2]! ? 0 : score[1]! >= score[2]! ? 1 : 2;
    return best === 0 ? [1, 0, 0] : best === 1 ? [0, 1, 0] : [0, 0, 1];
  };
  const axisAt = (f: number, axis: ExplodeAxis): Float64Array => {
    if (f <= 0) return new Float64Array(nI * 3);
    const a = resolveAxis(axis);
    let pMin = Number.POSITIVE_INFINITY;
    let pMax = Number.NEGATIVE_INFINITY;
    for (const n of leaves) {
      const p = n.c[0] * a[0] + n.c[1] * a[1] + n.c[2] * a[2];
      if (p < pMin) pMin = p;
      if (p > pMax) pMax = p;
    }
    const span = pMax - pMin;
    if (span < 1e-6) return radialAt(f); // everything at one station — nothing to stack
    const mid = (pMin + pMax) / 2;
    const out = new Float64Array(nI * 3);
    // Endpoints travel ~2.2 half-diagonals at f=1 — clears even a flat pancake assembly whose
    // stacking span (a few mm) is tiny next to its width.
    const g = Math.min(1, f) * 2.2 * R;
    for (const n of leaves) {
      const p = n.c[0] * a[0] + n.c[1] * a[1] + n.c[2] * a[2];
      const mag = ((p - mid) / (span / 2)) * g;
      const o = n.inst * 3;
      out[o] = a[0] * mag;
      out[o + 1] = a[1] * mag;
      out[o + 2] = a[2] * mag;
    }
    return out;
  };

  // ---- peel: outer parts leave first, the slider walks inward layer by layer ----
  let peelRank: Float64Array | null = null; // per-leaf rank in [0,1]: 0 = outermost
  const peelAt = (f: number): Float64Array => {
    const out = new Float64Array(nI * 3);
    if (f <= 0 || leaves.length < 2) return out;
    if (!peelRank) {
      // Enclosure-depth proxy: distance of the centroid to the nearest global bbox wall —
      // shallow = outer shell, deep = core. Rank-based so odd shapes can't skew the pacing.
      const depth = leaves.map((n, k) => ({
        k,
        d: Math.min(
          n.c[0] - GB[0],
          GB[3] - n.c[0],
          n.c[1] - GB[1],
          GB[4] - n.c[1],
          n.c[2] - GB[2],
          GB[5] - n.c[2],
        ),
      }));
      depth.sort((a, b) => a.d - b.d);
      peelRank = new Float64Array(leaves.length);
      depth.forEach((e, order) => {
        peelRank![e.k] = order / (depth.length - 1);
      });
    }
    const fac = Math.min(1, f);
    leaves.forEach((n, k) => {
      const rank = peelRank![k]!;
      const start = 0.7 * rank; // outermost moves immediately; the core waits until f ~ 0.7
      const local = Math.min(1, Math.max(0, (fac - start) / (1 - start)));
      if (local <= 0) return;
      const ease = local * local * (3 - 2 * local);
      const mag = (1.2 + 1.6 * (1 - rank)) * R * ease; // outer parts also end up farther out
      let dx = n.c[0] - C[0];
      let dy = n.c[1] - C[1];
      let dz = n.c[2] - C[2];
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-6 * R) [dx, dy, dz] = spreadDir(k);
      else {
        dx /= len;
        dy /= len;
        dz /= len;
      }
      const o = n.inst * 3;
      out[o] = dx * mag;
      out[o + 1] = dy * mag;
      out[o + 2] = dz * mag;
    });
    return out;
  };

  // ---- layout: shelf-pack every part onto a flat grid in front of the assembly (-Y side) ----
  let layoutTarget: Float64Array | null = null; // per-leaf target centroid (x, y, z)
  const layoutAt = (f: number): Float64Array => {
    const out = new Float64Array(nI * 3);
    if (f <= 0 || leaves.length === 0) return out;
    if (!layoutTarget) {
      layoutTarget = new Float64Array(leaves.length * 3);
      const pad = 0.06 * R;
      // Big parts first, rows capped near the assembly's width (or the grid's own square).
      const order = leaves.map((n, k) => ({
        k,
        w: n.bb[3] - n.bb[0] + pad,
        d: n.bb[4] - n.bb[1] + pad,
      }));
      let cellArea = 0;
      for (const it of order) cellArea += it.w * it.d;
      const W = Math.max(GB[3] - GB[0], Math.sqrt(cellArea) * 1.25);
      order.sort((a, b) => Math.max(b.w, b.d) - Math.max(a.w, a.d));
      const x0 = GB[0];
      let cx = x0;
      let rowY = GB[1] - pad * 3;
      let rowDepth = 0;
      for (const it of order) {
        if (cx > x0 && cx + it.w > x0 + W) {
          cx = x0;
          rowY -= rowDepth;
          rowDepth = 0;
        }
        const n = leaves[it.k]!;
        // Cell places the part's bbox; the centroid target keeps its offset inside that bbox,
        // and the part drops onto the assembly's ground plane (z = global min).
        layoutTarget[it.k * 3] = cx + (n.c[0] - n.bb[0]);
        layoutTarget[it.k * 3 + 1] = rowY - it.d + (n.c[1] - n.bb[1]);
        layoutTarget[it.k * 3 + 2] = GB[2] + (n.c[2] - n.bb[2]);
        cx += it.w;
        if (it.d > rowDepth) rowDepth = it.d;
      }
    }
    const fac = Math.min(1, f);
    leaves.forEach((n, k) => {
      const o = n.inst * 3;
      out[o] = (layoutTarget![k * 3]! - n.c[0]) * fac;
      out[o + 1] = (layoutTarget![k * 3 + 1]! - n.c[1]) * fac;
      out[o + 2] = (layoutTarget![k * 3 + 2]! - n.c[2]) * fac;
    });
    return out;
  };

  const offsetsAt = (
    f: number,
    style: ExplodeStyle = "hierarchical",
    axis: ExplodeAxis = "auto",
  ): Float64Array => {
    switch (style) {
      case "radial":
        return radialAt(f);
      case "axis":
        return axisAt(f, axis);
      case "peel":
        return peelAt(f);
      case "layout":
        return layoutAt(f);
      default:
        return hierarchicalAt(f);
    }
  };

  return { leafCount, offsetsAt };
}
