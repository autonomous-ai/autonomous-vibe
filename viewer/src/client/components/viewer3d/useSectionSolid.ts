import { type RefObject, useEffect, useRef, useState } from "react";
import { type BufferGeometry, Matrix3, Matrix4, type Mesh, Plane } from "three";
import { buildSectionSolid } from "./sectionSolid";
import { useCrossSectionStore } from "./crossSection.store";

/** Delay after the last section change before the (expensive) CSG solid is regenerated — the
 *  fast GPU-clip preview covers the drag, then the real solid builds once the user settles. */
const SETTLE_MS = 220;

interface Params {
  /** Model geometry (local space) to cut. */
  geometry: BufferGeometry;
  /** Visible mesh — its world matrix maps the world clip plane into local geometry space. */
  meshRef: RefObject<Mesh | null>;
  /** Stable world-space clip plane (mutated each frame by the rig); null when the tool is off. */
  clipPlane: Plane | null;
  /** Gate — only generate in solid view while sectioning. */
  active: boolean;
  /** Whether per-part vertex colors are on. Only a regeneration trigger — the geometry
   *  reference is stable across the toggle, so without this the solid wouldn't pick up (or
   *  drop) the color attribute until the next plane move. */
  colorsOn: boolean;
  /** The object's own color (hex) — painted onto the generated slice face, and used as the flat
   *  surface fill when there are no per-part colors. */
  baseColor: string;
}

/**
 * Builds a brand-new solid mesh for the current cut — the CSG intersection of the model with
 * the kept half-space — and returns its geometry, or null while dragging / off (so the caller
 * falls back to the GPU-clip preview). Regeneration is debounced to fire on slider release:
 * the store is watched through a transient subscription (not a selector) so a drag doesn't
 * re-render the mesh tree every frame — only the two transitions (→preview, →solid) do.
 */
export function useSectionSolid({
  geometry,
  meshRef,
  clipPlane,
  active,
  colorsOn,
  baseColor,
}: Params): BufferGeometry | null {
  const [solid, setSolid] = useState<BufferGeometry | null>(null);
  // Latest generated geometry, tracked outside state so we can dispose the previous one.
  const latest = useRef<BufferGeometry | null>(null);

  useEffect(() => {
    if (!active || !clipPlane) {
      setSolid((cur) => (cur === null ? cur : null));
      return;
    }

    let timer: ReturnType<typeof setTimeout>;

    const build = () => {
      const mesh = meshRef.current;
      if (!mesh) return;
      try {
        // World clip plane → local geometry space (same mapping the cut cap uses).
        const inv = new Matrix4().copy(mesh.matrixWorld).invert();
        const local = new Plane()
          .copy(clipPlane)
          .applyMatrix4(inv, new Matrix3().getNormalMatrix(inv));
        const next = buildSectionSolid(geometry, local, baseColor);
        latest.current?.dispose();
        latest.current = next;
        setSolid(next);
      } catch (err) {
        // Non-watertight / degenerate meshes can make the boolean fail — keep the live
        // preview rather than blanking the model.
        console.warn("[cross-section] solid generation failed, keeping clip preview", err);
      }
    };

    // Drop to the preview immediately (bails the re-render if already null), then rebuild once
    // movement settles.
    const schedule = () => {
      setSolid((cur) => (cur === null ? cur : null));
      clearTimeout(timer);
      timer = setTimeout(build, SETTLE_MS);
    };

    schedule();
    const unsub = useCrossSectionStore.subscribe((s, prev) => {
      if (
        s.position !== prev.position ||
        s.axis !== prev.axis ||
        s.flip !== prev.flip ||
        s.rotation !== prev.rotation
      ) {
        schedule();
      }
    });

    return () => {
      unsub();
      clearTimeout(timer);
    };
  }, [active, clipPlane, geometry, meshRef, colorsOn, baseColor]);

  // Dispose the last generated solid on unmount.
  useEffect(() => () => latest.current?.dispose(), []);

  return solid;
}
