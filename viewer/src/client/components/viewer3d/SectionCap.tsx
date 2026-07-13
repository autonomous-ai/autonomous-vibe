import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import {
  AlwaysStencilFunc,
  BackSide,
  type BufferGeometry,
  DecrementWrapStencilOp,
  DoubleSide,
  FrontSide,
  IncrementWrapStencilOp,
  Matrix3,
  Matrix4,
  type Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NotEqualStencilFunc,
  Plane,
  ReplaceStencilOp,
  Vector3,
} from "three";

/** Local +Z — the untransformed normal of a PlaneGeometry, rotated onto the cut
 *  plane's normal each frame. */
const UNIT_Z = new Vector3(0, 0, 1);

interface SectionCapProps {
  /** The model geometry, shared with the visible mesh (no duplicate upload). */
  geometry: BufferGeometry;
  /** World-space clip plane (stable instance, mutated each frame by the rig). */
  clipPlane: Plane;
  /** The visible mesh — its world matrix maps the world plane into local cap space. */
  meshRef: React.RefObject<Mesh | null>;
  /** Contrasting cap color (orange/red) so the exposed cut reads at a glance. */
  color: string;
  /** Cap quad size (≈ model diameter) so it always overshoots the cross-section. */
  size: number;
}

/**
 * Caps the exposed cut surface with a solid, contrasting fill using the stencil
 * buffer — the canonical three.js section technique. Two invisible passes of the
 * mesh (back faces increment, front faces decrement the stencil, both clipped by the
 * plane) mark the interior of the solid where it meets the plane; a lit quad on the
 * plane then paints only those stencilled pixels, so holes and cavities stay open
 * while solid regions read as a filled cut face. Renders inside the model group, so
 * it inherits the same transform as the visible mesh.
 */
export function SectionCap({ geometry, clipPlane, meshRef, color, size }: SectionCapProps) {
  const capRef = useRef<Mesh>(null);
  // Scratch objects reused each frame to avoid per-frame allocation.
  const scratch = useMemo(
    () => ({ inv: new Matrix4(), normalMat: new Matrix3(), local: new Plane() }),
    [],
  );

  // Stencil-writing materials: colorless, depth-neutral passes that only tag the
  // stencil buffer. Clipped by the same plane so they mark just the cut interior.
  const [backMat, frontMat] = useMemo(() => {
    const base = {
      depthWrite: false,
      depthTest: false,
      colorWrite: false,
      stencilWrite: true,
      stencilFunc: AlwaysStencilFunc,
      clippingPlanes: [clipPlane],
    };
    const back = new MeshBasicMaterial({ ...base, side: BackSide });
    back.stencilFail = IncrementWrapStencilOp;
    back.stencilZFail = IncrementWrapStencilOp;
    back.stencilZPass = IncrementWrapStencilOp;
    const front = new MeshBasicMaterial({ ...base, side: FrontSide });
    front.stencilFail = DecrementWrapStencilOp;
    front.stencilZFail = DecrementWrapStencilOp;
    front.stencilZPass = DecrementWrapStencilOp;
    return [back, front];
  }, [clipPlane]);

  // The visible cap: a lit surface drawn only where the stencil is non-zero (inside
  // the solid), then resetting the stencil to 0 for the next plane/frame.
  const capMat = useMemo(() => {
    const mat = new MeshStandardMaterial({
      color,
      metalness: 0.1,
      roughness: 0.75,
      side: DoubleSide,
    });
    mat.stencilWrite = true;
    mat.stencilRef = 0;
    mat.stencilFunc = NotEqualStencilFunc;
    mat.stencilFail = ReplaceStencilOp;
    mat.stencilZFail = ReplaceStencilOp;
    mat.stencilZPass = ReplaceStencilOp;
    return mat;
  }, [color]);

  // Reposition/orient the cap onto the (moving) plane each frame, in the mesh's local
  // space — the plane sweeps as the user drags the slider.
  useFrame(() => {
    const cap = capRef.current;
    const mesh = meshRef.current;
    if (!cap || !mesh) return;
    scratch.inv.copy(mesh.matrixWorld).invert();
    scratch.normalMat.getNormalMatrix(scratch.inv);
    scratch.local.copy(clipPlane).applyMatrix4(scratch.inv, scratch.normalMat);
    scratch.local.coplanarPoint(cap.position);
    cap.quaternion.setFromUnitVectors(UNIT_Z, scratch.local.normal);
  });

  return (
    <>
      {/* Stencil passes render before the cap (renderOrder) so its NOTEQUAL test sees
          a populated buffer. Invisible: they only write stencil. */}
      <mesh geometry={geometry} material={backMat} renderOrder={1} />
      <mesh geometry={geometry} material={frontMat} renderOrder={1} />
      <mesh ref={capRef} material={capMat} renderOrder={2}>
        <planeGeometry args={[size, size]} />
      </mesh>
    </>
  );
}
