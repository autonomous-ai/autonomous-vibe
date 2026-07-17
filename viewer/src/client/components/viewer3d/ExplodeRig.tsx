import { useFrame, useThree } from "@react-three/fiber";
import { type RefObject, useEffect, useRef } from "react";
import type { BufferGeometry, Mesh } from "three";
import type { FeatureOverlay } from "./StlModel";
import { type ExplodeData, buildExplodeData } from "./explodeGeometry";
import { useExplodeStore } from "./explode.store";

/** How fast the applied factor chases the target each frame (enter/exit glide + slider follow). */
const EASE = 0.22;
/** Below this the applied and target factors are treated as equal (snap + stop reapplying). */
const SNAP = 0.001;

/**
 * Headless in-canvas controller for the exploded view — the ExplodePanel/toolbar's counterpart to
 * <SectionRig>. Mirrors meshStep's viewer: the per-shell world offsets are added on the CPU into
 * the mesh's shared position buffer, so the solid/x-ray/wireframe passes all follow for free and
 * factor 0 restores the pristine copy exactly. Explode data (shell labels + offset provider) is
 * built lazily on the first enable — non-exploding sessions pay nothing. Keyed by url in the
 * canvas so it rebuilds per model.
 */
export function ExplodeRig({
  meshRef,
  featureRef,
}: {
  meshRef: RefObject<Mesh | null>;
  /** The feature-edge overlay published by <StlModel>, displaced alongside the mesh so the
   *  crease outline stays glued to its part while exploded. Null when the overlay is off. */
  featureRef?: RefObject<FeatureOverlay | null>;
}) {
  const setLeafCount = useExplodeStore((s) => s.setLeafCount);
  const invalidate = useThree((s) => s.invalidate);
  const data = useRef<ExplodeData | null>(null);
  const applied = useRef(0); // factor currently baked into the buffer
  const lastKey = useRef(""); // factor|style|axis of the last applied offsets
  const lastFeatureGeom = useRef<BufferGeometry | null>(null); // overlay last displaced (identity)
  // The exact geometry whose position buffer we baked offsets into. Held separately from meshRef
  // because on unmount the mesh ref may already be nulled, yet we still need to un-explode this
  // buffer: STLLoader caches the geometry by url (and toCreasedNormals hands back the same object
  // for a non-indexed soup), so a switch that left it exploded would show garbage on return.
  const bakedGeom = useRef<BufferGeometry | null>(null);

  // On unmount (model switch), restore the pristine positions we mutated, then reset per-model
  // state so the next model re-measures from scratch.
  useEffect(() => {
    return () => {
      const d = data.current;
      const geom = bakedGeom.current;
      if (d && geom && applied.current > 0) {
        const attr = geom.getAttribute("position");
        if (attr) {
          (attr.array as Float32Array).set(d.base);
          attr.needsUpdate = true;
          geom.computeBoundingSphere();
        }
      }
      data.current = null;
      bakedGeom.current = null;
      applied.current = 0;
      lastKey.current = "";
      lastFeatureGeom.current = null;
      setLeafCount(0);
    };
  }, [setLeafCount]);

  // On-demand loop: the toggle/slider mutate the store without re-rendering this rig (all params —
  // enabled included — are read via getState in useFrame), so request a frame on every explode-store
  // change to kick the ease. `enabled` is read live rather than from a hook closure on purpose: the
  // subscribe→invalidate frame can run before React commits the re-render, so a closure-gated
  // `enabled` would still read false on that first frame, skip the ease, and leave the demand loop
  // idle until an unrelated click — the "needs a click to explode" bug. getState always sees the
  // committed toggle.
  useEffect(() => useExplodeStore.subscribe(() => invalidate()), [invalidate]);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const { enabled, factor, style, axis } = useExplodeStore.getState();

    // Build once, on the first frame the tool is on (heavy: weld + connected-component labeling).
    if (enabled && !data.current) {
      data.current = buildExplodeData(mesh.geometry);
      bakedGeom.current = mesh.geometry;
      setLeafCount(data.current.leafCount);
    }
    const d = data.current;
    if (!d) return;

    // A single-shell model has nothing to separate — keep it assembled (matches meshStep, which
    // disables the tool below 2 parts). The panel shows the single-part note instead.
    const targetFactor = enabled && d.leafCount >= 2 ? factor : 0;

    // Ease the applied factor toward the target; snap when close so it comes to rest.
    let next = applied.current + (targetFactor - applied.current) * EASE;
    if (Math.abs(targetFactor - next) < SNAP) next = targetFactor;
    applied.current = next;
    // Still gliding → request the next frame (demand loop won't tick on its own).
    if (next !== targetFactor) invalidate();

    // Re-apply the mesh only when the baked result would differ (factor moving, or a style/axis
    // switch). The feature overlay must also refresh when IT changed (angle slider rebuilt it, or
    // it just appeared) even if the factor held steady, so track its identity separately.
    const key = `${next.toFixed(4)}|${style}|${axis}`;
    const feature = featureRef?.current ?? null;
    const meshDirty = key !== lastKey.current;
    const featureDirty = (feature?.geometry ?? null) !== lastFeatureGeom.current;
    if (!meshDirty && !featureDirty) return;
    lastKey.current = key;
    lastFeatureGeom.current = feature?.geometry ?? null;

    // Per-shell offsets at the current factor — shared by the mesh and the overlay so they move
    // as one. Null below factor 0 (both restore their pristine copy exactly).
    const off = next > 0 ? d.offsetsAt(next, style, axis) : null;

    if (meshDirty) {
      displace(mesh.geometry, d.base, d.shellOfVertex, off);
    }
    // The overlay follows whenever the mesh moved OR the overlay itself changed.
    if (feature && (meshDirty || featureDirty)) {
      displace(feature.geometry, feature.base, feature.shellOfVertex, off);
    }
  });

  return null;
}

/** Bake per-shell offsets into a geometry's position buffer (or restore `base` when `off` is
 *  null), then flag the attribute and refresh bounds so frustum culling doesn't cull moved parts. */
function displace(
  geometry: BufferGeometry,
  base: Float32Array,
  shellOfVertex: Uint32Array,
  off: Float64Array | null,
): void {
  const attr = geometry.getAttribute("position");
  const arr = attr.array as Float32Array;
  if (!off) {
    arr.set(base); // exact restore
  } else {
    for (let v = 0; v < shellOfVertex.length; v++) {
      const o = shellOfVertex[v]! * 3;
      const p = v * 3;
      arr[p] = base[p]! + off[o]!;
      arr[p + 1] = base[p + 1]! + off[o + 1]!;
      arr[p + 2] = base[p + 2]! + off[o + 2]!;
    }
  }
  attr.needsUpdate = true;
  geometry.computeBoundingSphere();
}
