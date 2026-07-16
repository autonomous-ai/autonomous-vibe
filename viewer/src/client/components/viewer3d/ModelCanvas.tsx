import {
  Bounds,
  Center,
  GizmoHelper,
  GizmoViewcube,
  OrbitControls,
  TrackballControls,
  useBounds,
} from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  type MutableRefObject,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type DirectionalLight, type Mesh, Plane, Vector3, type WebGLRenderer } from "three";
import type {
  OrbitControls as OrbitControlsImpl,
  TrackballControls as TrackballControlsImpl,
} from "three-stdlib";
import { BloomEffects } from "./BloomEffects";
import { ExplodeRig } from "./ExplodeRig";
import { GRID_SIZE, GroundGrid } from "./GroundGrid";
import { MeasureLayer } from "./MeasureLayer";
import { ReflectiveFloor } from "./ReflectiveFloor";
import { ScaleBox } from "./ScaleBox";
import { SectionRig } from "./SectionRig";
import {
  type FeatureOverlay,
  type RenderMode,
  type SectionSettings,
  StlModel,
} from "./StlModel";
import { useAppearanceStore } from "./appearance.store";
import {
  DEFAULT_MATERIAL_PRESET,
  MATERIAL_PRESETS,
  type MaterialPreset,
} from "./materialPresets";
import { useCrossSectionStore } from "./crossSection.store";
import { useMediaQuery } from "./useMediaQuery";

/** Imperative handle the overlay calls to re-frame the model on its default view. */
export type ResetViewerRef = MutableRefObject<(() => void) | null>;

/** Camera navigation style the viewer offers: OrbitControls (turntable — a fixed
 *  up axis, so the model can't roll) or TrackballControls (free tumble on any axis). */
export type ControlMode = "orbit" | "trackball";

/** Either drei control instance. BoundsFramer drives both through the object/target/
 *  update API they share; only the trackball-specific `handleResize` is guarded. */
type SceneControls = OrbitControlsImpl | TrackballControlsImpl;

/** Imperative screenshot handle exposed to the surrounding chrome (toolbar). */
export interface ViewerCaptureHandle {
  getCanvas: () => HTMLCanvasElement | null;
  captureScreenshot: (opts: {
    mode: "blob" | "download" | "clipboard";
    filename?: string;
  }) => Promise<Blob | void>;
}

/** Default camera framing — kept in one place so the reset restores exactly what
 *  the Canvas mounts with. */
const DEFAULT_CAMERA_POSITION: [number, number, number] = [80, 60, 80];
/** Unit view direction of the default camera; the reset places the camera along
 *  this ray at whatever distance fits the model. */
const DEFAULT_DIRECTION = new Vector3(...DEFAULT_CAMERA_POSITION).normalize();
const DEFAULT_UP = new Vector3(0, 1, 0);
/** Framing padding around the model — the fit distance from `bounds.getSize()`
 *  already bakes in the <Bounds margin>, so the initial frame and the reset use
 *  the exact same distance. */
const FIT_MARGIN = 1.3;
/** Reset animation length, in seconds. */
const RESET_DURATION = 0.6;

/** Cut-surface cap color — FORGE molten-orange, a strong contrast against the
 *  neutral model materials so the exposed section reads instantly. */
const SECTION_HIGHLIGHT_COLOR = "#FF6A2B";

/** easeInOutCubic — soft start/stop for the camera glide. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** In-flight reset animation: interpolate camera pose from start → goal over `t`. */
interface ResetAnimation {
  t: number;
  startPos: Vector3;
  goalPos: Vector3;
  startTarget: Vector3;
  goalTarget: Vector3;
  startUp: Vector3;
  goalUp: Vector3;
}

/** WebGL viewport for one design. Reads its appearance (shading/material/controls)
 *  from the persisted appearance store so the surrounding chrome stays thin. */
export function ModelCanvas({
  url,
  resetRef,
  captureRef,
  showBed = false,
}: {
  url: string;
  resetRef?: ResetViewerRef;
  /** Populated with an imperative screenshot handle for the toolbar. */
  captureRef?: MutableRefObject<ViewerCaptureHandle | null>;
  /** Draw the bounding cage, print bed, and mm dimensions around the model. */
  showBed?: boolean;
}) {
  const mode = useAppearanceStore((s) => s.mode) as RenderMode;
  const materialId = useAppearanceStore((s) => s.materialId);
  const controls = useAppearanceStore((s) => s.controls) as ControlMode;
  const partColors = useAppearanceStore((s) => s.partColors);
  const featureEdges = useAppearanceStore((s) => s.featureEdges);
  const featureAngle = useAppearanceStore((s) => s.featureAngle);
  const reflectiveFloor = useAppearanceStore((s) => s.reflectiveFloor);
  const bloom = useAppearanceStore((s) => s.bloom);
  const material: MaterialPreset =
    MATERIAL_PRESETS.find((m) => m.id === materialId) ?? DEFAULT_MATERIAL_PRESET;

  const controlsRef = useRef<SceneControls | null>(null);
  // Visible mesh handle — the section rig measures its world bounds and the cut cap
  // maps the world clip plane into its local space.
  const meshRef = useRef<Mesh | null>(null);
  // Feature-edge overlay handle — published by <StlModel> when the outline is on, consumed by
  // <ExplodeRig> so the creases explode with their parts instead of staying at the assembled pose.
  const featureRef = useRef<FeatureOverlay | null>(null);
  // Live renderer handle for screenshots (populated by CaptureBridge inside <Canvas>).
  const glRef = useRef<WebGLRenderer | null>(null);
  // Cross-section tool state. The two clip planes are stable instances the rig mutates
  // in place each frame (real-time slider with no React churn); the booleans/opacity
  // change materials, so they come straight from the store and re-render on change.
  const sectionEnabled = useCrossSectionStore((s) => s.enabled);
  const showHiddenHalf = useCrossSectionStore((s) => s.showHiddenHalf);
  const hiddenOpacity = useCrossSectionStore((s) => s.hiddenOpacity);
  const highlightCut = useCrossSectionStore((s) => s.highlightCut);
  const clipPlane = useMemo(() => new Plane(), []);
  const hiddenPlane = useMemo(() => new Plane(), []);
  // Measured model diameter → cap quad size (updated once bounds are known).
  const [capSize, setCapSize] = useState(GRID_SIZE);
  const handleRadius = useCallback((radius: number) => setCapSize(radius * 2.5), []);
  const section: SectionSettings | null = sectionEnabled
    ? {
        clipPlane,
        hiddenPlane,
        showHiddenHalf,
        hiddenOpacity,
        highlightCut,
        highlightColor: SECTION_HIGHLIGHT_COLOR,
        capSize,
      }
    : null;

  // Download progress for the current STL: pct is null until a byte-total is known
  // (indeterminate); ready flips true once the geometry resolves and dismisses the
  // overlay. When the selected design (url) changes we reset both in render — the
  // React-recommended alternative to an effect for prop-derived state.
  const [pct, setPct] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const [loadedUrl, setLoadedUrl] = useState(url);
  if (url !== loadedUrl) {
    setLoadedUrl(url);
    setPct(null);
    setReady(false);
  }
  const handleProgress = useCallback((next: number | null) => setPct(next), []);
  const handleReady = useCallback(() => setReady(true), []);
  // Orientation gizmo is a desktop-only affordance.
  const isDesktop = useMediaQuery("(min-width: 1024px)");

  // Switching to orbit re-frames the view: trackball may have left the camera rolled,
  // which orbit's fixed up-vector can't represent, so restore the upright default.
  const prevControls = useRef(controls);
  useEffect(() => {
    if (controls === prevControls.current) return;
    prevControls.current = controls;
    if (controls === "orbit") resetRef?.current?.();
  }, [controls, resetRef]);

  // Publish an imperative screenshot handle for the surrounding chrome. Reads the
  // WebGL canvas directly (preserveDrawingBuffer keeps the last frame readable).
  useEffect(() => {
    if (!captureRef) return undefined;
    captureRef.current = {
      // Exposes the live WebGL canvas so the surrounding pane can composite the 2D
      // annotation overlay on top before exporting.
      getCanvas() {
        return (glRef.current?.domElement as HTMLCanvasElement) || null;
      },
      async captureScreenshot({ mode: capMode, filename }) {
        const gl = glRef.current;
        if (!gl) return undefined;
        const canvas = gl.domElement as HTMLCanvasElement;
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob((b) => resolve(b), "image/png"),
        );
        if (!blob) return undefined;
        if (capMode === "download") {
          triggerBlobDownload(blob, filename || "model.png");
          return undefined;
        }
        if (capMode === "clipboard") {
          await copyBlobToClipboard(blob);
          return undefined;
        }
        return blob;
      },
    };
    return () => {
      if (captureRef) captureRef.current = null;
    };
  }, [captureRef]);

  return (
    <div className="absolute inset-0 h-full w-full">
      <Canvas
        dpr={[1, 2]}
        camera={{ position: DEFAULT_CAMERA_POSITION, fov: 45, near: 0.1, far: 5000 }}
        // preserveDrawingBuffer so the toolbar's screenshot can read the canvas.
        gl={{ antialias: true, preserveDrawingBuffer: true }}
        // Enable per-material clipping planes so the cross-section tool can slice the
        // mesh on the GPU (no geometry rebuilds).
        onCreated={({ gl }) => {
          gl.localClippingEnabled = true;
          glRef.current = gl;
        }}
      >
        {/* Scene bg mirrors the FORGE --color-background token (#0E0F13). */}
        <color attach="background" args={["#0E0F13"]} />
        <ambientLight intensity={0.75} />
        <hemisphereLight intensity={0.4} groundColor="#0E0F13" />
        {/* Key light ~55° off vertical (≈35° elevation). */}
        <directionalLight position={[60, 55, 50]} intensity={1.2} />
        <directionalLight position={[-50, 20, -40]} intensity={0.45} />
        {/* Headlight pinned to the camera so the model stays lit from the viewer's
            angle no matter how it's tumbled. */}
        <Headlight intensity={0.9} />

        <Suspense fallback={null}>
          {/* key={url} → re-suspend + re-frame when the selected design changes. */}
          <Bounds key={url} margin={FIT_MARGIN}>
            <BoundsFramer resetRef={resetRef} controlsRef={controlsRef} controlMode={controls} />
            {/* `top`: rest the model's base on y=0 so it stands ON the ground grid. */}
            <Center top>
              {/* CAD STL is Z-up; rotate into three.js Y-up so models stand upright. */}
              <group rotation={[-Math.PI / 2, 0, 0]}>
                <StlModel
                  url={url}
                  mode={mode}
                  material={material}
                  partColors={partColors}
                  featureEdges={featureEdges}
                  featureAngle={featureAngle}
                  section={section}
                  meshRef={meshRef}
                  featureRef={featureRef}
                  onProgress={handleProgress}
                  onReady={handleReady}
                />
              </group>
            </Center>
            {/* Headless cross-section controller. */}
            <SectionRig
              key={url}
              meshRef={meshRef}
              clipPlane={clipPlane}
              hiddenPlane={hiddenPlane}
              onRadius={handleRadius}
            />
            {/* Headless exploded-view controller: displaces the mesh's shared position buffer per
                part on the CPU. Keyed by url so its shell labeling rebuilds when the model changes. */}
            <ExplodeRig key={`explode-${url}`} meshRef={meshRef} featureRef={featureRef} />
            {/* Invisible flat box matching the ground grid's footprint, so <Bounds>
                frames the default view to the whole grid. */}
            <mesh visible={false}>
              <boxGeometry args={[GRID_SIZE, 0.001, GRID_SIZE]} />
            </mesh>
            {showBed && <ScaleBox url={url} />}
          </Bounds>
          {/* Dark glossy reflection floor beneath the grid (opt-in). OUTSIDE <Bounds>
              for the same reason as the grid — its plane would otherwise inflate the fit.
              Sits just below y=0 so the grid lines read on top of the reflection. */}
          {reflectiveFloor && <ReflectiveFloor />}
          {/* Fixed-size ground grid the part rests on, always shown. Deliberately
              OUTSIDE <Bounds> so its phantom vertical extent can't wreck the fit. */}
          <GroundGrid />
          {/* Point-to-point measurement overlay. At the Canvas root (outside <Bounds>/
              <Center>) so its markers render at raw world coordinates — the frame the
              raycaster returns — rather than inheriting the model's centring/rotation.
              Reads the measure store for its enabled/points state; no-op until on. */}
          <MeasureLayer meshRef={meshRef} />
        </Suspense>

        <CaptureBridge glRef={glRef} />

        {controls === "orbit" ? (
          <OrbitControls
            ref={controlsRef as MutableRefObject<OrbitControlsImpl | null>}
            makeDefault
            enableDamping
            dampingFactor={0.12}
            rotateSpeed={0.9}
          />
        ) : (
          <TrackballControls
            ref={controlsRef as MutableRefObject<TrackballControlsImpl | null>}
            makeDefault
            rotateSpeed={3}
            dynamicDampingFactor={0.12}
          />
        )}

        {isDesktop && (
          <GizmoHelper alignment="bottom-right" margin={[60, 120]}>
            <GizmoViewcube
              color="#9AA0AC"
              hoverColor="#FF6A2B"
              textColor="#0E0F13"
              strokeColor="#2C2F39"
            />
          </GizmoHelper>
        )}

        {/* Bloom post-process (opt-in). Mounted last so the EffectComposer wraps the
            fully-rendered scene; unmounted when off so the default single-pass render
            path (and the renderer's own tone mapping) is used with no post overhead. */}
        {bloom && <BloomEffects />}
      </Canvas>

      {!ready && <DownloadOverlay pct={pct} />}
    </div>
  );
}

/** Bridges the live WebGL renderer out of the Canvas so the screenshot handle can
 *  read the canvas from React land. */
function CaptureBridge({ glRef }: { glRef: MutableRefObject<WebGLRenderer | null> }) {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    glRef.current = gl;
    return () => {
      if (glRef.current === gl) glRef.current = null;
    };
  }, [gl, glRef]);
  return null;
}

/** A directional light that tracks the camera each frame, so its beam always comes
 *  from the viewer's direction and points at the model (parked at the origin by
 *  <Center>). */
function Headlight({ intensity = 0.9 }: { intensity?: number }) {
  const lightRef = useRef<DirectionalLight>(null);
  useFrame((state) => {
    lightRef.current?.position.copy(state.camera.position);
  });
  return <directionalLight ref={lightRef} intensity={intensity} />;
}

/** Spinner + live byte-progress shown over the canvas while the STL downloads. */
function DownloadOverlay({ pct }: { pct: number | null }) {
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center bg-background/60 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3">
        <div className="size-8 animate-spin rounded-full border-2 border-white/25 border-t-white/80" />
        <span className="text-xs text-muted-foreground">
          {pct === null ? "Loading model…" : `Loading model… ${Math.round(pct)}%`}
        </span>
      </div>
    </div>
  );
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function copyBlobToClipboard(blob: Blob): Promise<void> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    throw new Error("Clipboard image copy is not supported in this environment.");
  }
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}

/** Owns all camera framing for the model — the initial fit, resize re-fits, and the
 *  imperative reset published on `resetRef`. */
function BoundsFramer({
  resetRef,
  controlsRef,
  controlMode,
}: {
  resetRef?: ResetViewerRef;
  controlsRef: MutableRefObject<SceneControls | null>;
  controlMode: ControlMode;
}) {
  const bounds = useBounds();
  const size = useThree((s) => s.size);
  const anim = useRef<ResetAnimation | null>(null);
  const userMoved = useRef(false);
  const pending = useRef(true);
  const lastSize = useRef({ w: 0, h: 0 });

  const frame = useCallback(
    (animated: boolean) => {
      const controls = controlsRef.current;
      if (!controls) return;
      const camera = controls.object;

      if (size.height > 0 && "isPerspectiveCamera" in camera && camera.isPerspectiveCamera) {
        camera.aspect = size.width / size.height;
        camera.updateProjectionMatrix();
      }

      const { center, distance } = bounds.getSize();
      const goalTarget = center.clone();
      const goalPos = DEFAULT_DIRECTION.clone().multiplyScalar(distance).add(goalTarget);

      camera.near = Math.max(distance / 100, 0.01);
      camera.far = distance * 100;
      camera.updateProjectionMatrix();

      if (animated) {
        anim.current = {
          t: 0,
          startPos: camera.position.clone(),
          goalPos,
          startTarget: controls.target.clone(),
          goalTarget,
          startUp: camera.up.clone(),
          goalUp: DEFAULT_UP.clone(),
        };
      } else {
        anim.current = null;
        camera.position.copy(goalPos);
        camera.up.copy(DEFAULT_UP);
        controls.target.copy(goalTarget);
        camera.lookAt(goalTarget);
        controls.update();
      }
    },
    [bounds, controlsRef, size],
  );

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!controls) return;

    if (size.width !== lastSize.current.w || size.height !== lastSize.current.h) {
      lastSize.current = { w: size.width, h: size.height };
      if (!userMoved.current) pending.current = true;
    }

    if (pending.current && !userMoved.current) {
      bounds.refresh();
      frame(false);
      pending.current = false;
    }

    const a = anim.current;
    if (!a) return;

    a.t = Math.min(1, a.t + delta / RESET_DURATION);
    const k = easeInOutCubic(a.t);

    const camera = controls.object;
    camera.position.lerpVectors(a.startPos, a.goalPos, k);
    camera.up.copy(a.startUp).lerp(a.goalUp, k);
    controls.target.lerpVectors(a.startTarget, a.goalTarget, k);
    camera.lookAt(controls.target);
    controls.update();

    if (a.t >= 1) anim.current = null;
  });

  // Flag the first user interaction so resize re-fits stop fighting the gesture.
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const onStart = () => {
      userMoved.current = true;
    };
    controls.addEventListener("start", onStart);
    return () => controls.removeEventListener("start", onStart);
  }, [controlsRef, controlMode]);

  // Refresh TrackballControls' cached page rect at the start of every gesture so the
  // trackball center can't drift stale (OrbitControls has no such cache — guarded).
  useEffect(() => {
    const el = controlsRef.current?.domElement;
    if (!el) return;
    const refreshTrackball = () => {
      const c = controlsRef.current;
      if (c && "handleResize" in c) c.handleResize();
    };
    el.addEventListener("pointerdown", refreshTrackball, { capture: true });
    return () => el.removeEventListener("pointerdown", refreshTrackball, { capture: true });
  }, [controlsRef, controlMode]);

  useEffect(() => {
    if (!resetRef) return;
    resetRef.current = () => {
      userMoved.current = false;
      bounds.refresh();
      frame(true);
    };
    return () => {
      resetRef.current = null;
    };
  }, [bounds, frame, resetRef]);

  return null;
}
