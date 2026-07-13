import { useLoader } from "@react-three/fiber";
import { type RefObject, useEffect, useMemo } from "react";
import { AdditiveBlending, Color, DoubleSide, FrontSide, type Mesh, type Plane } from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { SectionCap } from "./SectionCap";
import { DEFAULT_MATERIAL_PRESET, type MaterialPreset } from "./materialPresets";

/** Shading style for the mesh: opaque lit surface, a see-through x-ray glow, or a
 *  bare triangle-edge wireframe. */
export type RenderMode = "solid" | "xray" | "wireframe";

/** X-ray tint — a cool cyan reads as a scan/hologram against the charcoal bg. */
const XRAY_COLOR = "#7dd3fc";

/** Wireframe line tint — the same cyan as x-ray, unlit, so the mesh edges read as
 *  a clean CAD schematic against the charcoal bg. */
const WIREFRAME_COLOR = "#7dd3fc";

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
  /** Live cross-section clipping; null/undefined renders the model whole. */
  section?: SectionSettings | null;
  /** Forwarded to the visible mesh so the canvas can measure world bounds and the
   *  cap can map the world plane into local space. */
  meshRef?: RefObject<Mesh | null>;
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
  section,
  meshRef,
  onProgress,
  onReady,
}: StlModelProps) {
  // 4th arg is the loader's XHR onProgress — real byte counts, unlike drei's
  // useProgress which only tracks item count (0→100 with nothing between).
  const geometry = useLoader(STLLoader, url, undefined, (event) => {
    onProgress?.(event.lengthComputable ? (event.loaded / event.total) * 100 : null);
  });
  const shaded = useMemo(() => toCreasedNormals(geometry, Math.PI / 6), [geometry]);

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
          <meshStandardMaterial
            color={material.color}
            metalness={material.metalness}
            roughness={material.roughness}
            side={section ? DoubleSide : FrontSide}
            clippingPlanes={clip}
          />
        )}
      </mesh>

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
