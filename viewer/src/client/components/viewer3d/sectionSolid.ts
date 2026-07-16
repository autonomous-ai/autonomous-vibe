import {
  BoxGeometry,
  type BufferAttribute,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  type InterleavedBufferAttribute,
  type Plane,
  Vector3,
} from "three";
import { Brush, Evaluator, INTERSECTION } from "three-bvh-csg";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { getMeshShells } from "./meshShells";

type Attr = BufferAttribute | InterleavedBufferAttribute;

/** Local +Z of a BoxGeometry — rotated onto the plane normal so one box face lands on the
 *  cut plane. */
const UNIT_Z = new Vector3(0, 0, 1);

/** A fresh RGB vertex-color buffer (`count` vertices) filled with a single linear color. */
function solidColorBuffer(count: number, r: number, g: number, b: number): Float32BufferAttribute {
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    arr[i * 3] = r;
    arr[i * 3 + 1] = g;
    arr[i * 3 + 2] = b;
  }
  return new Float32BufferAttribute(arr, 3);
}

/** A cube far larger than the model, oriented so its near (−Z → −normal) face lies on the plane
 *  and its body fills the kept (+normal) half — intersecting a solid with it slices + caps that
 *  half. Returned as a Brush ready to reuse across several booleans (same plane). */
function makeHalfSpaceBoxBrush(size: number, localPlane: Plane): Brush {
  const boxGeo = new BoxGeometry(size, size, size).toNonIndexed();
  boxGeo.deleteAttribute("uv");
  const brush = new Brush(boxGeo);
  const n = localPlane.normal;
  brush.quaternion.setFromUnitVectors(UNIT_Z, n);
  // Near face on the plane, body on the kept (+normal) side.
  brush.position.copy(localPlane.coplanarPoint(new Vector3())).addScaledVector(n, size / 2);
  brush.updateMatrixWorld();
  return brush;
}

/** A non-indexed position+normal geometry holding just the given triangles of the soup. */
function subsetGeometry(pos: Attr, norm: Attr, tris: number[]): BufferGeometry {
  const n = tris.length;
  const p = new Float32Array(n * 9);
  const nm = new Float32Array(n * 9);
  for (let k = 0; k < n; k++) {
    const t = tris[k]!;
    for (let j = 0; j < 3; j++) {
      const s = t * 3 + j;
      const d = k * 3 + j;
      p[d * 3] = pos.getX(s);
      p[d * 3 + 1] = pos.getY(s);
      p[d * 3 + 2] = pos.getZ(s);
      nm[d * 3] = norm.getX(s);
      nm[d * 3 + 1] = norm.getY(s);
      nm[d * 3 + 2] = norm.getZ(s);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(p, 3));
  g.setAttribute("normal", new Float32BufferAttribute(nm, 3));
  return g;
}

/**
 * Per-part cross-section: cut each part (connected shell) separately against the half-space and
 * merge the results, tinting each part-solid — surface AND its new cut face — with that part's
 * own color. Because each part is cut on its own, every cap is that part's true cross-section, so
 * the slice colors are exactly right even where parts sit close together (no nearest-wall or
 * containment guessing). Assumes each part is a watertight shell (the CSG requires it anyway).
 */
function buildPerPartSolid(src: BufferGeometry, localPlane: Plane): BufferGeometry {
  const srcColor = src.getAttribute("color");
  const pos = src.getAttribute("position");
  const norm = src.getAttribute("normal");
  const { solidOfTri, leafCount } = getMeshShells(src);
  const nTri = solidOfTri.length;

  src.computeBoundingSphere();
  const size = (src.boundingSphere?.radius ?? 1) * 4;

  // Group triangles by part, and grab each part's (uniform) color from its first triangle.
  const trisByShell: number[][] = Array.from({ length: leafCount }, () => []);
  const shellRGB: ([number, number, number] | undefined)[] = new Array(leafCount);
  for (let t = 0; t < nTri; t++) {
    const s = solidOfTri[t]!;
    trisByShell[s]!.push(t);
    if (!shellRGB[s])
      shellRGB[s] = [srcColor.getX(t * 3), srcColor.getY(t * 3), srcColor.getZ(t * 3)];
  }

  const evaluator = new Evaluator();
  evaluator.attributes = ["position", "normal"];
  evaluator.useGroups = false;
  const boxBrush = makeHalfSpaceBoxBrush(size, localPlane);

  const parts: BufferGeometry[] = [];
  for (let s = 0; s < leafCount; s++) {
    const tris = trisByShell[s]!;
    if (!tris.length) continue;
    const shellGeo = subsetGeometry(pos, norm, tris);
    const shellBrush = new Brush(shellGeo);
    shellBrush.updateMatrixWorld();
    const g = evaluator.evaluate(shellBrush, boxBrush, INTERSECTION).geometry;
    const count = g.getAttribute("position")?.count ?? 0;
    if (count > 0) {
      const [r, gg, b] = shellRGB[s]!;
      g.setAttribute("color", solidColorBuffer(count, r, gg, b));
      parts.push(g);
    }
    shellGeo.dispose();
  }
  boxBrush.geometry.dispose();

  const merged = parts.length ? mergeGeometries(parts, false) : null;
  for (const p of parts) p.dispose();
  return merged ?? new BufferGeometry();
}

/** Whole-model cross-section for a single-color model: one boolean, the cut face flat-filled with
 *  the object color. */
function buildFlatSolid(src: BufferGeometry, localPlane: Plane, base: Color): BufferGeometry {
  const model = new BufferGeometry();
  model.setAttribute("position", src.getAttribute("position"));
  model.setAttribute("normal", src.getAttribute("normal"));
  model.computeBoundingSphere();
  const size = (model.boundingSphere?.radius ?? 1) * 4;

  const boxBrush = makeHalfSpaceBoxBrush(size, localPlane);
  const evaluator = new Evaluator();
  evaluator.attributes = ["position", "normal"];
  evaluator.useGroups = false;

  const modelBrush = new Brush(model);
  modelBrush.updateMatrixWorld();
  const out = evaluator.evaluate(modelBrush, boxBrush, INTERSECTION).geometry;

  model.dispose();
  boxBrush.geometry.dispose();
  return out;
}

/**
 * Generate a genuinely-solid cross-section as a brand-new mesh: the boolean INTERSECTION of the
 * model with the half-space kept by `localPlane` (in the geometry's local space). Unlike GPU
 * clipping — which just hides fragments of the original hollow shell — the result is fresh
 * watertight geometry whose cut face is capped, so it renders as a newly generated solid model.
 *
 * With per-part colors it cuts each part on its own and merges, so every part (and its cut face)
 * keeps its own color; otherwise it's a single boolean and the caller paints it the object color.
 * Pure: returns a new BufferGeometry; the caller owns disposal.
 */
export function buildSectionSolid(
  geometry: BufferGeometry,
  localPlane: Plane,
  baseColorHex: string,
): BufferGeometry {
  const src = geometry.index ? geometry.toNonIndexed() : geometry;
  return src.getAttribute("color")
    ? buildPerPartSolid(src, localPlane)
    : buildFlatSolid(src, localPlane, new Color(baseColorHex));
}
