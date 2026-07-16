import { Line } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import {
  type Camera,
  Matrix3,
  type Mesh,
  Quaternion,
  type Raycaster,
  Vector2,
  Vector3,
} from "three";
import { useMeasureStore } from "./measure.store";

// Measurement behaviour ported from Online3DViewer's measure tool
// (MIT © 2023 Viktor Kovacs, source/website/measuretool.js), adapted to
// react-three-fiber: https://github.com/kovacsv/Online3DViewer

/** Marker/line color. O3DV uses 0x263238 (dark), which is invisible on our dark FORGE
 *  canvas (#0E0F13), so we draw in brand orange instead. */
const ACCENT = "#FF6A2B";

/** Pixels the pointer may drift between down and up and still count as a click, not a
 *  drag. Above this the gesture was an orbit/pan and must not drop a measure point. */
const CLICK_SLOP = 6;

/** Local axis the crosshair is built around; oriented to the surface normal per marker. */
const FORWARD = new Vector3(0, 0, 1);

/** One raycast hit on the model: the world-space point plus the world-space flat
 *  triangle normal of the face that was hit (O3DV's GetFaceWorldNormal). */
interface SurfaceHit {
  position: [number, number, number];
  normal: [number, number, number];
}

/** Raycast the pointer against the mesh; null when it misses (MeshOnly, like O3DV). */
function pickSurface(
  e: PointerEvent,
  el: HTMLElement,
  mesh: Mesh,
  raycaster: Raycaster,
  camera: Camera,
): SurfaceHit | null {
  const rect = el.getBoundingClientRect();
  const ndc = new Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(mesh, false)[0];
  if (!hit || !hit.face) return null;
  // Flat triangle face normal → world space (rotation only), exactly like O3DV.
  const normal = new Vector3()
    .copy(hit.face.normal)
    .applyMatrix3(new Matrix3().getNormalMatrix(mesh.matrixWorld))
    .normalize();
  return {
    position: [hit.point.x, hit.point.y, hit.point.z],
    normal: [normal.x, normal.y, normal.z],
  };
}

/**
 * Interactive measurement ported from Online3DViewer. While enabled: hovering the mesh
 * shows a temporary marker, clicking a surface places a crosshair marker, two markers
 * are joined by a line, and clicking empty space clears the measurement. A third click
 * restarts. The numeric readout (distance / parallel-faces distance / angle) lives in
 * <MeasurePanel>. Markers capture the flat face normal so the panel can report the
 * angle between the two clicked faces.
 *
 * Mounted at the Canvas root (outside <Bounds>/<Center>) so its markers sit at raw
 * world coordinates — the frame the raycaster returns — instead of inheriting the
 * model's centring/rotation. Picking is a manual raycast against the visible mesh so
 * the tool stays self-contained and never reaches into <StlModel>.
 */
export function MeasureLayer({ meshRef }: { meshRef: RefObject<Mesh | null> }) {
  const enabled = useMeasureStore((s) => s.enabled);
  const picks = useMeasureStore((s) => s.picks);
  const addPick = useMeasureStore((s) => s.addPick);
  const clear = useMeasureStore((s) => s.clear);

  const { gl, camera, raycaster } = useThree();

  // Live hover under the cursor — a temporary preview marker, identical to a placed one
  // (O3DV doesn't dim it), cleared when the cursor leaves the mesh or the canvas.
  const [hover, setHover] = useState<SurfaceHit | null>(null);

  // Pick surface points from raw pointer events (not R3F's onClick) so the tool owns
  // its own hit-testing and can tell a click apart from an orbit drag. The controls
  // listen on the same element and still rotate/zoom normally — we only act on a
  // click that didn't move (CLICK_SLOP), so measuring and navigating coexist.
  useEffect(() => {
    if (!enabled) return;
    const el = gl.domElement;
    const down = new Vector2();
    let dragged = false;

    const onPointerDown = (e: PointerEvent) => {
      down.set(e.clientX, e.clientY);
      dragged = false;
    };
    const onPointerMove = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP) dragged = true;
      // Hover preview only while no button is held (a held button = orbit/pan drag).
      if (e.buttons !== 0) return;
      const mesh = meshRef.current;
      setHover(mesh ? pickSurface(e, el, mesh, raycaster, camera) : null);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (dragged) return; // was a navigation gesture, not a pick
      const mesh = meshRef.current;
      if (!mesh) return;
      const hit = pickSurface(e, el, mesh, raycaster, camera);
      // Empty space clears the current measurement; a surface adds a pick (O3DV Click).
      if (hit) addPick(hit);
      else clear();
    };
    const onPointerLeave = () => setHover(null);

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointerleave", onPointerLeave);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointerleave", onPointerLeave);
    };
  }, [enabled, gl, camera, raycaster, meshRef, addPick, clear]);

  // Signal picking mode with a crosshair cursor while the tool is on. Also drop any
  // stale hover marker when the tool is turned off.
  useEffect(() => {
    if (!enabled) {
      setHover(null);
      return;
    }
    const el = gl.domElement;
    const prev = el.style.cursor;
    el.style.cursor = "crosshair";
    return () => {
      el.style.cursor = prev;
    };
  }, [enabled, gl]);

  // Marker radius = model bounding-sphere radius / 20 (world-fixed size), like O3DV's
  // GenerateMarker. Cached on the geometry after the first computeBoundingSphere().
  const radiusRef = useRef(1);
  const geom = meshRef.current?.geometry;
  if (geom) {
    if (!geom.boundingSphere) geom.computeBoundingSphere();
    if (geom.boundingSphere) radiusRef.current = geom.boundingSphere.radius / 20;
  }
  const radius = radiusRef.current;

  if (!enabled) return null;

  const showHover = hover && picks.length < 2;
  const linePoints = picks.length === 2 ? picks.map((p) => new Vector3(...p.position)) : null;

  return (
    <group>
      {picks.map((p) => (
        <Marker
          // Picks are positional, so their coordinates make a stable key.
          key={`${p.position[0]},${p.position[1]},${p.position[2]}`}
          position={p.position}
          normal={p.normal}
          radius={radius}
        />
      ))}
      {showHover && <Marker position={hover.position} normal={hover.normal} radius={radius} />}

      {/* Line joining the two picks, same style as the marker crosshairs (O3DV). Drawn
          on top of the model (depthTest off) so it never hides behind the surface. */}
      {linePoints && (
        <Line points={linePoints} color={ACCENT} lineWidth={1.5} depthTest={false} transparent />
      )}
    </group>
  );
}

/** O3DV's Marker: a line circle plus two perpendicular crosshair diameters, laid flat
 *  in the surface's tangent plane (oriented to the face normal) and sized in world
 *  units. Drawn with depthTest off so it stays visible through the model. */
function Marker({
  position,
  normal,
  radius,
}: {
  position: [number, number, number];
  normal: [number, number, number];
  radius: number;
}) {
  const pos = useMemo(() => new Vector3(...position), [position]);
  const quaternion = useMemo(() => {
    const n = new Vector3(...normal);
    if (n.lengthSq() === 0) return new Quaternion();
    return new Quaternion().setFromUnitVectors(FORWARD, n.normalize());
  }, [normal]);
  // 50-segment circle in the local XY plane (tangent to the surface after orientation).
  const circle = useMemo(() => {
    const pts: Vector3[] = [];
    for (let i = 0; i <= 50; i++) {
      const a = (i / 50) * Math.PI * 2;
      pts.push(new Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
    }
    return pts;
  }, [radius]);
  const horizontal = useMemo(
    () => [new Vector3(-radius, 0, 0), new Vector3(radius, 0, 0)],
    [radius],
  );
  const vertical = useMemo(() => [new Vector3(0, -radius, 0), new Vector3(0, radius, 0)], [radius]);

  return (
    <group position={pos} quaternion={quaternion}>
      <Line points={circle} color={ACCENT} lineWidth={1.5} depthTest={false} transparent />
      <Line points={horizontal} color={ACCENT} lineWidth={1.5} depthTest={false} transparent />
      <Line points={vertical} color={ACCENT} lineWidth={1.5} depthTest={false} transparent />
    </group>
  );
}
