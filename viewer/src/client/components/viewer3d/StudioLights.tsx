import { useFrame } from "@react-three/fiber";
import { type RefObject, useEffect, useRef, useState } from "react";
import { Box3, type Mesh, type RectAreaLight } from "three";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";

// RectAreaLight needs its area-light BRDF lookup tables installed once before it will
// render correctly — without this the panels contribute nothing. Idempotent.
RectAreaLightUniformsLib.init();

/** Model height (mm) the fixed rig positions below are tuned for. Taller parts scale
 *  the whole rig up proportionally so the top key/fill lights always clear the object;
 *  shorter parts keep the tuned look (scale floored at 1). */
const REFERENCE_HEIGHT = 130;

/** Studio three-light rig for the solid model (mm world units; model centered at the
 *  origin, base on y=0).
 *
 *  - Two RectAreaLights — a broad KEY panel high on the front-right and a narrower RIM
 *    panel behind-left. Area lights are what paint the long streak highlights across
 *    glossy / metallic surfaces (they can't cast shadows, and only light Standard /
 *    Physical materials — which is exactly our solid preset).
 *  - One DirectionalLight as the fill + the sole SHADOW CASTER, with a soft PCF shadow.
 *
 *  The whole rig scales with the model's measured height so the top lights sit above
 *  even very tall parts (the fixed positions alone would fall inside a >190mm model).
 *
 *  Only the solid view uses these — x-ray / wireframe render with unlit materials.
 *  Intensities are tuned to sit on top of the Environment IBL; adjust to taste. */
export function StudioLights({ meshRef }: { meshRef: RefObject<Mesh | null> }) {
  // Area lights emit along their local -Z; aim all three at the model's mid-height so
  // their glow rakes across the body. The lights are world-fixed (rendered outside the
  // rotated model group), so the aim only changes when the model's height changes.
  const keyRef = useRef<RectAreaLight>(null);
  const rimRef = useRef<RectAreaLight>(null);
  const bottomRef = useRef<RectAreaLight>(null);

  // Measure the model's top once per model — its base rests on y=0, so the world AABB's
  // max.y is its height. The height only changes on a model swap, so measuring every frame
  // (a subtree traversal + AABB compute) is wasted work; gate it on the geometry identity so
  // it runs once when a new model settles and is skipped on every subsequent (orbit) frame.
  const box = useRef(new Box3());
  const measuredFor = useRef<string | null>(null);
  const [modelTop, setModelTop] = useState(REFERENCE_HEIGHT);
  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    if (measuredFor.current === mesh.geometry.uuid) return;
    box.current.setFromObject(mesh);
    if (box.current.isEmpty()) return;
    measuredFor.current = mesh.geometry.uuid;
    const top = box.current.max.y;
    if (Math.abs(top - modelTop) > 0.5) setModelTop(top);
  });

  // Floor at 1 so short/typical parts keep the hand-tuned rig; taller parts push the
  // whole rig out proportionally, keeping the top light above the object.
  const scale = Math.max(1, modelTop / REFERENCE_HEIGHT);
  const aimY = 30 * scale;

  useEffect(() => {
    keyRef.current?.lookAt(0, aimY, 0);
    rimRef.current?.lookAt(0, aimY, 0);
    bottomRef.current?.lookAt(0, aimY, 0);
  }, [aimY]);

  return (
    <>
      {/* KEY — broad softbox raking down the front-right; the main streak highlight. */}
      <rectAreaLight
        ref={keyRef}
        position={[150 * scale, 190 * scale, 130 * scale]}
        width={280 * scale}
        height={150 * scale}
        intensity={5}
        color="#fff4ea"
      />
      {/* RIM — cooler back-left panel skimming the silhouette edge for separation. */}
      <rectAreaLight
        ref={rimRef}
        position={[-140 * scale, 130 * scale, -170 * scale]}
        width={200 * scale}
        height={90 * scale}
        intensity={3.2}
        color="#eaf2ff"
      />
      {/* BOTTOM — soft up-facing fill from below (aimed at the model center) to lift the
          undersides and edges that the top-down key/rim leave in shadow. Area lights can't
          cast shadows, so this only adds glow. */}
      <rectAreaLight
        ref={bottomRef}
        position={[0, -120 * scale, 90 * scale]}
        width={240 * scale}
        height={140 * scale}
        intensity={1.6}
        color="#f2f6ff"
      />
      {/* FILL + SHADOW — the only shadow caster. shadow-bias slightly negative kills
          surface acne; shadow-normalBias offsets along the normal (sized for mm units) so
          the fix doesn't detach the shadow from the base (peter-panning). Ortho frustum
          scales with the rig so a tall part's shadow never gets clipped. */}
      <directionalLight
        position={[90 * scale, 210 * scale, 70 * scale]}
        intensity={1.4}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-bias={-0.0004}
        shadow-normalBias={1}
        shadow-radius={6}
        shadow-camera-near={1}
        shadow-camera-far={900 * scale}
        shadow-camera-left={-260 * scale}
        shadow-camera-right={260 * scale}
        shadow-camera-top={260 * scale}
        shadow-camera-bottom={-260 * scale}
      />
    </>
  );
}
