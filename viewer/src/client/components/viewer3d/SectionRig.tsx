import { useFrame, useThree } from "@react-three/fiber";
import { type RefObject, useEffect, useRef } from "react";
import { Box3, type Mesh, type Plane, Sphere, Vector3 } from "three";
import { updateSectionPlanes } from "./sectionPlane";
import type { SectionBounds } from "./section";
import { useCrossSectionStore } from "./crossSection.store";

interface SectionRigProps {
  /** The visible mesh whose world bounds anchor the plane sweep. */
  meshRef: RefObject<Mesh | null>;
  /** Stable world-space clip plane, mutated in place each frame. */
  clipPlane: Plane;
  /** Stable world-space plane for the ghosted hidden half. */
  hiddenPlane: Plane;
  /** Reports the model's bounding-sphere radius once measured, so the canvas can size
   *  the cut cap to always overshoot the section. */
  onRadius: (radius: number) => void;
}

/**
 * Headless in-canvas controller for the cross-section. Measures the model's world
 * bounds once (after <Center> has settled the transform), then — while the tool is
 * enabled — rewrites the two stable clip planes every frame from the live store
 * params. Mutating the plane objects in place (rather than through React state) is
 * what makes slider dragging update the GPU clip in real time without re-rendering
 * the scene. Must live inside <Suspense> so it only runs once the geometry exists.
 */
export function SectionRig({ meshRef, clipPlane, hiddenPlane, onRadius }: SectionRigProps) {
  const enabled = useCrossSectionStore((s) => s.enabled);
  const invalidate = useThree((s) => s.invalidate);
  const bounds = useRef<SectionBounds | null>(null);
  const box = useRef(new Box3());
  const sphere = useRef(new Sphere());

  // Re-measure when the tool is switched on (and on mount) — cheap, and guarantees
  // fresh bounds even if the model settled before the first enable.
  useEffect(() => {
    bounds.current = null;
  }, [enabled]);

  // On-demand loop: a slider drag mutates the store but doesn't re-render this rig (it reads
  // params via getState in useFrame), so request a frame on every section change — that frame
  // reruns useFrame and rewrites the clip planes. Cheap: only fires on user interaction.
  useEffect(() => useCrossSectionStore.subscribe(() => invalidate()), [invalidate]);

  useFrame(() => {
    if (!enabled) return;
    const mesh = meshRef.current;
    if (!mesh) return;

    if (!bounds.current) {
      box.current.setFromObject(mesh);
      if (box.current.isEmpty()) return;
      const center = box.current.getCenter(new Vector3());
      const size = box.current.getSize(new Vector3());
      const radius = box.current.getBoundingSphere(sphere.current).radius;
      bounds.current = { center, half: size.multiplyScalar(0.5), radius };
      onRadius(radius);
    }

    const { axis, rotation, flip, position } = useCrossSectionStore.getState();
    updateSectionPlanes(clipPlane, hiddenPlane, { axis, rotation, flip, position }, bounds.current);
  });

  return null;
}
