import { MeshReflectorMaterial } from "@react-three/drei";
import { GRID_SIZE } from "./GroundGrid";

// Dark floor tint (not a pure-white mirror): a near-black charcoal a touch below the
// scene background so the surface reads as a glossy studio cyclorama, and the mirrored
// model/reflections stay the visual focus. Literal hex — FORGE tokens can't cross into
// WebGL, and this sits just under --color-background (#0E0F13).
const FLOOR_COLOR = "#08090c";

// Sit fractionally below the grid (y=0) so the grid lines still draw crisply on top of
// the reflective surface instead of z-fighting it.
const FLOOR_Y = -0.05;

/** A dark, softly-blurred planar-reflection floor the model rests on — the studio
 *  "wet floor" look. Uses drei's <MeshReflectorMaterial> (a real-time planar reflector
 *  with built-in blur), so it captures the model + environment each frame; the blur and
 *  dark tint trade a hard mirror for a subtler, cheaper reflection. Opt-in (toggled from
 *  the viewer overlay) because the extra render pass costs frame time.
 *
 *  Rendered OUTSIDE <Bounds> (like <GroundGrid>) so its plane geometry never inflates
 *  the camera fit. Sized to the grid footprint so the two line up. The tint is
 *  theme-aware (passed from ModelCanvas) and defaults to the dark-theme charcoal. */
export function ReflectiveFloor({ color = FLOOR_COLOR }: { color?: string } = {}) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, FLOOR_Y, 0]}>
      <planeGeometry args={[GRID_SIZE, GRID_SIZE]} />
      <MeshReflectorMaterial
        // Reflection buffer resolution — 1024 is sharp enough without a big VRAM/perf hit.
        resolution={1024}
        // Two-pass blur (x, y) softens the reflection into a sheen rather than a mirror.
        blur={[400, 100]}
        mixBlur={1}
        // Reflection strength blended over the base color; kept moderate so the dark
        // tint dominates and the mirror stays subtle.
        mixStrength={2.2}
        // Depth-based blur: distant reflections blur more, so the floor recedes naturally.
        depthScale={1.2}
        minDepthThreshold={0.4}
        maxDepthThreshold={1.4}
        color={color}
        metalness={0.6}
        roughness={0.9}
      />
    </mesh>
  );
}
