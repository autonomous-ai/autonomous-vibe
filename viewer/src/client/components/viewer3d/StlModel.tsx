import { useLoader } from "@react-three/fiber";
import { type RefObject, useEffect, useMemo } from "react";
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  FrontSide,
  type Mesh,
  type Plane,
} from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { SectionCap } from "./SectionCap";
import { buildFeatureEdges } from "./featureEdges";
import { DEFAULT_MATERIAL_PRESET, type MaterialPreset } from "./materialPresets";
import { buildPartColors } from "./partColors";

/** Shading style for the mesh: opaque lit surface, a see-through x-ray glow, or a
 *  bare triangle-edge wireframe. */
export type RenderMode = "solid" | "xray" | "wireframe";

/** X-ray tint — a cool cyan reads as a scan/hologram against the charcoal bg. */
const XRAY_COLOR = "#7dd3fc";

/** Wireframe line tint — the same cyan as x-ray, unlit, so the mesh edges read as
 *  a clean CAD schematic against the charcoal bg. */
const WIREFRAME_COLOR = "#7dd3fc";

/** Feature-edge line tint. Near-black (matches meshStep's FEATURE_COLOR 0x0b0e12, and
 *  FORGE's --color-background #0E0F13) so the crease outline reads as a crisp CAD
 *  blueprint drawn onto the lit surface. */
const FEATURE_EDGE_COLOR = "#0E0F13";

/** Live cross-section state handed to the mesh. The two planes are stable instances
 *  mutated every frame by the section rig (so slider drags update with no re-render);
 *  the booleans/opacity are React-driven since they change materials. */
export interface SectionSettings {
  /** World-space plane keeping the exposed half. */
  clipPlane: Plane;
  /** World-space plane keeping the clipped-away half (for the ghost). */
  hiddenPlane: Plane;
  /** Render the clipped-away half as a translucent ghost instead of hiding it. */
  showHiddenHalf: boolean;
  /** Ghost opacity 0…1 when `showHiddenHalf` is on. */
  hiddenOpacity: number;
  /** Cap the exposed cut with a contrasting solid fill. */
  highlightCut: boolean;
  /** Cap fill color (contrasting orange/red). */
  highlightColor: string;
  /** Cap quad size in mm (≈ model diameter). */
  capSize: number;
}

/** Feature-edge overlay published to the explode rig so it can displace each crease line with
 *  the part it belongs to. Without this the edges would stay welded to the assembled positions
 *  while the mesh explodes, leaving the outline orphaned. */
export interface FeatureOverlay {
  /** The rendered LineSegments geometry — the rig mutates its position buffer in place. */
  geometry: BufferGeometry;
  /** Pristine (assembled) line positions; factor 0 restores this exactly. */
  base: Float32Array;
  /** Shell id per line vertex, aligned with the position buffer (same numbering as the mesh). */
  shellOfVertex: Uint32Array;
}

/** Fresnel x-ray shader: a solid-ish translucent fill across the faces (uBase) with a
 *  brighter rim boost along the silhouette where the surface turns edge-on (uPower), so
 *  faces read with body and edges stay crisp while you still see through to the far
 *  side. World-space normals/positions so it tracks the parent rotation. */
const XRAY_VERTEX_SHADER = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vPositionW;
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vPositionW = worldPosition.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const XRAY_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uPower;
  uniform float uOpacity;
  uniform float uBase;
  varying vec3 vNormalW;
  varying vec3 vPositionW;
  void main() {
    vec3 viewDir = normalize(cameraPosition - vPositionW);
    // abs() so back faces contribute too; higher power tightens the rim to the silhouette.
    float rim = pow(1.0 - abs(dot(viewDir, normalize(vNormalW))), uPower);
    // uBase gives the faces solid body; the rim boosts the edges/silhouette on top.
    float f = uBase + (1.0 - uBase) * rim;
    gl_FragColor = vec4(uColor * f, f * uOpacity);
  }
`;

interface StlModelProps {
  url: string;
  /** Solid-view material look (color + PBR knobs). Ignored in x-ray mode, which
   *  uses its own unlit shader. Defaults to the neutral gray preset. */
  material?: MaterialPreset;
  /** How to shade the mesh — a lit solid surface (default) or a translucent x-ray. */
  mode?: RenderMode;
  /** Tint each connected part a distinct hue (solid view only) so assembly pieces read
   *  apart. No-op on a single-part model. */
  partColors?: boolean;
  /** Overlay the model's feature edges (creases sharper than `featureAngle`, plus
   *  open/non-manifold edges) as a blueprint-style outline over the surface. */
  featureEdges?: boolean;
  /** Dihedral threshold in degrees (1–179) for `featureEdges`. Defaults to 20. */
  featureAngle?: number;
  /** Live cross-section clipping; null/undefined renders the model whole. */
  section?: SectionSettings | null;
  /** Forwarded to the visible mesh so the canvas can measure world bounds and the
   *  cap can map the world plane into local space. */
  meshRef?: RefObject<Mesh | null>;
  /** Published each time the feature-edge overlay (re)builds so the explode rig can displace it
   *  in lockstep with the mesh; set to null when the overlay is off or empty. */
  featureRef?: RefObject<FeatureOverlay | null>;
  /** Live download progress: byte percentage 0–100, or null when the response has
   *  no Content-Length (indeterminate). Fires as the STL streams in. */
  onProgress?: (pct: number | null) => void;
  /** Called once the geometry exists (useLoader has resolved) so the overlay can
   *  dismiss — also covers the cached case where no progress events fire. */
  onReady?: () => void;
}

/**
 * Loads an STL into a smoothly-shaded mesh. Mirrors the desktop viewer's
 * `stlMeshData` step: STLLoader → creased normals (hard edges preserved at
 * angles sharper than 30°). Rendered in CAD-native units (mm); centering and
 * framing are handled by the parent <Center>/<Bounds>.
 */
export function StlModel({
  url,
  material = DEFAULT_MATERIAL_PRESET,
  mode = "solid",
  partColors = false,
  featureEdges = false,
  featureAngle = 20,
  section,
  meshRef,
  featureRef,
  onProgress,
  onReady,
}: StlModelProps) {
  // 4th arg is the loader's XHR onProgress — real byte counts, unlike drei's
  // useProgress which only tracks item count (0→100 with nothing between).
  const geometry = useLoader(STLLoader, url, undefined, (event) => {
    onProgress?.(event.lengthComputable ? (event.loaded / event.total) * 100 : null);
  });
  const shaded = useMemo(() => toCreasedNormals(geometry, Math.PI / 6), [geometry]);

  // Per-part colors: attach a linear-RGB vertex-color attribute keyed to each connected shell.
  // Null on a single-part model (nothing to distinguish). Done in a memo (not an effect) so the
  // attribute is present before the material first compiles with `vertexColors`. Attaching to the
  // shared `shaded` geometry is harmless — the material's `vertexColors` flag gates whether it's
  // read at all.
  const hasPartColors = useMemo(() => {
    if (!partColors) return false;
    const colors = buildPartColors(shaded);
    if (!colors) return false;
    shaded.setAttribute("color", new Float32BufferAttribute(colors, 3));
    return true;
  }, [partColors, shaded]);

  // Feature edges: a crease-outline LineSegments geometry built from the same welded topology
  // (angle-thresholded dihedrals + open/non-manifold edges). Shares the mesh's local space, so
  // it renders as a sibling overlay under the same parent transform. Carries a pristine `base`
  // copy + per-vertex shell ids so the explode rig can displace it with the parts. Null when off
  // or empty.
  const featureOverlay = useMemo<FeatureOverlay | null>(() => {
    if (!featureEdges) return null;
    const { positions, shells } = buildFeatureEdges(shaded, featureAngle);
    if (positions.length === 0) return null;
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(positions, 3));
    g.computeBoundingSphere();
    // `base` is a separate copy — the geometry's own buffer is what the rig mutates in place.
    return { geometry: g, base: Float32Array.from(positions), shellOfVertex: shells };
  }, [featureEdges, featureAngle, shaded]);
  const featureGeometry = featureOverlay?.geometry ?? null;

  // Publish the overlay to the explode rig (and null it out when it goes away) so the rig can
  // pick it up on its next frame. A ref, not state, so it never triggers a re-render.
  useEffect(() => {
    if (!featureRef) return;
    featureRef.current = featureOverlay;
    return () => {
      featureRef.current = null;
    };
  }, [featureRef, featureOverlay]);

  // Free the previous overlay buffer when the angle changes or the model unmounts.
  useEffect(() => () => featureGeometry?.dispose(), [featureGeometry]);

  // Stable uniforms for the x-ray shader — recreating them each render would drop
  // the material's compiled program. Cheap to hold even while in solid mode.
  const xrayUniforms = useMemo(
    () => ({
      uColor: { value: new Color(XRAY_COLOR) },
      // Fresnel exponent: higher = thinner, sharper silhouette rim (crisper edges).
      uPower: { value: 3.2 },
      // Overall strength before additive accumulation.
      uOpacity: { value: 1.0 },
      // Flat face fill added under the rim so faces read solid, not hollow.
      uBase: { value: 0.35 },
    }),
    [],
  );

  // useLoader suspends until the geometry resolves, so reaching render means the
  // download is done — dismiss the overlay (covers cached loads with no progress).
  useEffect(() => {
    onReady?.();
  }, [onReady]);

  // Clip the visible mesh to the exposed half when sectioning. DoubleSide so the cut
  // opening shows lit interior walls even where the cap doesn't fill (holes/cavities).
  const clip = section ? [section.clipPlane] : null;

  return (
    <>
      <mesh ref={meshRef} geometry={shaded}>
        {mode === "xray" ? (
          // Fresnel glow, additive so stacked walls brighten and depthWrite off so the
          // shell never occludes itself — you see straight through to the far side.
          <shaderMaterial
            uniforms={xrayUniforms}
            vertexShader={XRAY_VERTEX_SHADER}
            fragmentShader={XRAY_FRAGMENT_SHADER}
            transparent
            depthWrite={false}
            blending={AdditiveBlending}
            side={DoubleSide}
            clippingPlanes={clip}
          />
        ) : mode === "wireframe" ? (
          // Unlit triangle edges — the mesh's own tessellation drawn as lines, so the
          // model reads as a bare CAD schematic. No lighting so the color stays crisp.
          <meshBasicMaterial color={WIREFRAME_COLOR} wireframe clippingPlanes={clip} />
        ) : (
          // With part colors on, the per-vertex hues drive the color (base white so they
          // show at full strength) while the preset's finish (metalness/roughness) stays.
          // key toggles a fresh material so the `vertexColors` shader define recompiles.
          <meshStandardMaterial
            key={hasPartColors ? "vertex-colors" : "solid"}
            color={hasPartColors ? "#ffffff" : material.color}
            vertexColors={hasPartColors}
            metalness={material.metalness}
            roughness={material.roughness}
            side={section ? DoubleSide : FrontSide}
            clippingPlanes={clip}
            // Push faces slightly back so coplanar feature lines win the depth test
            // (crisp hidden-line look). Only matters while the overlay is on.
            polygonOffset={!!featureGeometry}
            polygonOffsetFactor={1}
            polygonOffsetUnits={1}
          />
        )}
      </mesh>

      {/* Feature-edge overlay — depth-tested so hidden creases stay hidden, drawn under the
          same parent transform as the mesh. Clipped along with the model when sectioning. */}
      {featureGeometry && (
        <lineSegments geometry={featureGeometry}>
          <lineBasicMaterial color={FEATURE_EDGE_COLOR} clippingPlanes={clip} />
        </lineSegments>
      )}

      {/* Ghosted clipped-away half — the opposite side kept translucent so the removed
          material still reads as context. Off by default (the half is fully cut away). */}
      {section?.showHiddenHalf && (
        <mesh geometry={shaded}>
          <meshStandardMaterial
            color={material.color}
            metalness={material.metalness}
            roughness={material.roughness}
            transparent
            opacity={section.hiddenOpacity}
            depthWrite={false}
            side={DoubleSide}
            clippingPlanes={[section.hiddenPlane]}
          />
        </mesh>
      )}

      {/* Solid contrasting cap over the exposed cut (stencil technique). */}
      {section?.highlightCut && meshRef && (
        <SectionCap
          geometry={shaded}
          clipPlane={section.clipPlane}
          meshRef={meshRef}
          color={section.highlightColor}
          size={section.capSize}
        />
      )}
    </>
  );
}
