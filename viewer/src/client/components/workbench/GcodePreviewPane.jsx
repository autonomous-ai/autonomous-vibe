"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ArrowHelper, Euler, Group, Vector3 } from "three";
import { init as initGcodePreview } from "gcode-preview";
import { loadRenderText } from "cadjs/lib/renderAssetClient";
import { copyImageBlobToClipboard } from "@/ui/clipboard";
import { triggerBlobDownload } from "@/ui/download";
import ViewPlaneControl from "../viewer/ViewPlaneControl";

// Bambu Lab is the only supported printer family (v1), so a fixed bed box is a
// reasonable default for the build-volume overlay. Most Bambu G-code lives in
// 0..256 coordinates, so the box lines up with the toolpath.
const DEFAULT_BUILD_VOLUME = { x: 256, y: 256, z: 256 };

// gcode-preview never re-renders ViewPlaneControl's "is there a model?" gate, so a
// stable truthy sentinel keeps the gizmo mounted without leaking real mesh state.
const VIEW_PLANE_PRESENT = Object.freeze({ gcode: true });

const VIEW_PLANE_TRANSITION_MS = 280;
const VIEW_PLANE_ACTIVE_DOT_THRESHOLD = 0.994;
// Printer up-axis (Z). The gizmo and the plate axes both speak printer coordinates
// (X right, Y depth, Z up) so they stay consistent; the camera lives in the
// library's Y-up scene and we convert at the boundary (see sceneVecFromPrinter).
const WORLD_UP = [0, 0, 1];
// Same six faces / colors / convention as the CAD view control (ViewPlaneControl),
// expressed in the printer Z-up frame. getAxisId() colors them by id prefix.
const GCODE_VIEW_PLANE_FACES = [
  { id: "z", title: "Jump to top view", direction: [0, 0, 1], up: [0, 1, 0] },
  { id: "zNeg", title: "Jump to bottom view", direction: [0, 0, -1], up: [0, 1, 0] },
  { id: "yNeg", title: "Jump to front view", direction: [0, -1, 0], up: WORLD_UP },
  { id: "y", title: "Jump to back view", direction: [0, 1, 0], up: WORLD_UP },
  { id: "x", title: "Jump to right view", direction: [1, 0, 0], up: WORLD_UP },
  { id: "xNeg", title: "Jump to left view", direction: [-1, 0, 0], up: WORLD_UP }
];
const GCODE_VIEW_PLANE_FACE_BY_ID = Object.fromEntries(
  GCODE_VIEW_PLANE_FACES.map((face) => [face.id, face])
);
// Default home view (printer space), dialed in via the console-logged camera
// direction: a side view from the +X side at ~28° elevation, with no front/back
// bias (Y≈0). Used for both the initial camera and the gizmo's center reset button.
const DEFAULT_VIEW_DIRECTION = [1.88, 0, 1];

// Plate-axis colors, matched to ViewPlaneControl's default palette so the origin
// triad and the gizmo nodes read as the same X/Y/Z (red / green / blue).
const AXIS_COLOR_X = 0xfa584f;
const AXIS_COLOR_Y = 0x5ce97b;
const AXIS_COLOR_Z = 0x5483ff;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function easeInOutCubic(value) {
  const t = clamp(value, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// gcode-preview renders the toolpath in a Y-up scene whose group is rotated -90°
// about X and offset to center the bed, so printer (X, Y, Z) maps to scene
// (X, Z, -Y). These convert between the printer frame the gizmo/axes speak and the
// scene frame the camera lives in.
function sceneVecFromPrinter(printer) {
  const [px = 0, py = 0, pz = 0] = printer || [];
  return new Vector3(px, pz, -py);
}

function printerVecFromScene(vec) {
  return new Vector3(vec.x, -vec.z, vec.y);
}

// Where each printer world axis points in camera/screen space — drives the gizmo.
function readGcodeViewPlaneOrientation(camera) {
  if (!camera) {
    return null;
  }
  const inverseCameraRotation = camera.quaternion.clone().invert();
  const project = (printer) => {
    const projected = sceneVecFromPrinter(printer).applyQuaternion(inverseCameraRotation);
    return [projected.x, projected.y, projected.z];
  };
  return {
    x: project([1, 0, 0]),
    y: project([0, 1, 0]),
    z: project([0, 0, 1])
  };
}

function getGcodeActiveViewPlaneFaceId(camera, target) {
  if (!camera || !target) {
    return "";
  }
  const offsetScene = camera.position.clone().sub(target);
  if (offsetScene.lengthSq() < 1e-6) {
    return "";
  }
  const offsetPrinter = printerVecFromScene(offsetScene).normalize();
  let bestId = "";
  let bestDot = -Infinity;
  for (const face of GCODE_VIEW_PLANE_FACES) {
    const direction = new Vector3(...face.direction).normalize();
    const dot = direction.dot(offsetPrinter);
    if (dot > bestDot) {
      bestDot = dot;
      bestId = face.id;
    }
  }
  return bestDot >= VIEW_PLANE_ACTIVE_DOT_THRESHOLD ? bestId : "";
}

function viewPlaneOrientationClose(a, b, epsilon = 1e-4) {
  if (!a || !b) {
    return a === b;
  }
  for (const axis of ["x", "y", "z"]) {
    const left = a[axis];
    const right = b[axis];
    if (!Array.isArray(left) || !Array.isArray(right)) {
      return false;
    }
    for (let index = 0; index < 3; index += 1) {
      if (Math.abs((left[index] || 0) - (right[index] || 0)) > epsilon) {
        return false;
      }
    }
  }
  return true;
}

// Camera position for the default top-left view (target is the scene origin / bed
// center). Distance roughly matches the library's own default framing.
function defaultGcodeCameraPosition(buildVolume) {
  const maxDimension = Math.max(buildVolume?.x || 0, buildVolume?.y || 0, buildVolume?.z || 0) || 256;
  const distance = maxDimension * 2.4;
  return sceneVecFromPrinter(DEFAULT_VIEW_DIRECTION).normalize().multiplyScalar(distance);
}

// X/Y/Z arrow triad sitting at the printer origin corner of the bed. Parented under
// a group with the same transform gcode-preview gives its toolpath group, so the
// arrows inherit the printer orientation (X red along bed X, Y green into the bed,
// Z blue up).
function buildOriginAxes(buildVolume) {
  const group = new Group();
  group.name = "gcode-origin-axes";
  group.quaternion.setFromEuler(new Euler(-Math.PI / 2, 0, 0));
  group.position.set(-(buildVolume?.x || 256) / 2, 0, (buildVolume?.y || 256) / 2);
  const length = clamp((buildVolume?.x || 256) * 0.18, 18, 44);
  const headLength = length * 0.22;
  const headWidth = headLength * 0.62;
  const origin = new Vector3(0, 0, 0);
  group.add(new ArrowHelper(new Vector3(1, 0, 0), origin, length, AXIS_COLOR_X, headLength, headWidth));
  group.add(new ArrowHelper(new Vector3(0, 1, 0), origin, length, AXIS_COLOR_Y, headLength, headWidth));
  group.add(new ArrowHelper(new Vector3(0, 0, 1), origin, length, AXIS_COLOR_Z, headLength, headWidth));
  return group;
}

function disposeOriginAxes(group) {
  group?.traverse?.((child) => {
    child.geometry?.dispose?.();
    const material = child.material;
    if (Array.isArray(material)) {
      material.forEach((entry) => entry?.dispose?.());
    } else {
      material?.dispose?.();
    }
  });
}

function readCssVar(name, fallback) {
  if (typeof window === "undefined") {
    return fallback;
  }
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

// Render the current frame then read the drawing buffer synchronously. The
// gcode-preview renderer is created without `preserveDrawingBuffer`, so the
// buffer is only readable in the same tick as the draw — hence the synchronous
// `toDataURL` immediately after `render()`.
function captureCanvasBlob(preview) {
  preview.render();
  const dataUrl = preview.canvas.toDataURL("image/png");
  const base64 = dataUrl.split(",")[1] || "";
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return new Blob([bytes], { type: "image/png" });
}

/**
 * Renders a `.gcode` toolpath with the `gcode-preview` library, which owns its
 * own THREE scene/renderer/camera/controls inside the canvas we hand it. Mirrors
 * the `DxfViewer` integration shape: self-contained, `forwardRef`, exposes a
 * CadViewer-compatible `captureScreenshot` so the workbench toolbar keeps working.
 * Adds two overlays the library lacks: an X/Y/Z triad at the bed origin, and a
 * CAD-style orientation gizmo (ViewPlaneControl) anchored bottom-right.
 */
const GcodePreviewPane = forwardRef(function GcodePreviewPane({
  gcodeUrl = "",
  modelKey = "",
  topLayer = null,
  showTravel = false,
  renderTubes = false,
  buildVolume = DEFAULT_BUILD_VOLUME,
  showViewPlane = true,
  onReady,
  onViewerAlertChange
}, ref) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const previewRef = useRef(null);
  const hasContentRef = useRef(false);
  const originAxesRef = useRef(null);
  const transitionRef = useRef(null);
  const rafRef = useRef(0);

  const [viewPlaneOrientation, setViewPlaneOrientation] = useState(null);
  const [activeViewPlaneFace, setActiveViewPlaneFace] = useState("");

  // Latest option values, read inside the load effect without re-running it.
  const optionsRef = useRef({ topLayer, showTravel, renderTubes });
  optionsRef.current = { topLayer, showTravel, renderTubes };

  // Sync the gizmo (orientation + highlighted face) to the live camera. Cheap and
  // guarded so the OrbitControls "change" stream doesn't thrash React state.
  const updateGizmoState = useCallback(() => {
    const preview = previewRef.current;
    if (!preview?.camera || !preview?.controls) {
      return;
    }
    const orientation = readGcodeViewPlaneOrientation(preview.camera);
    setViewPlaneOrientation((prev) => (viewPlaneOrientationClose(prev, orientation) ? prev : orientation));
    const nextFace = getGcodeActiveViewPlaneFaceId(preview.camera, preview.controls.target);
    setActiveViewPlaneFace((current) => (current === nextFace ? current : nextFace));
    // // Log the live camera direction on user orbit (skipped during the programmatic
    // // reset/face transitions) so the default can be tuned: the printer-space [x,y,z]
    // // maps straight into DEFAULT_VIEW_DIRECTION.
    // if (!transitionRef.current) {
    //   const printerDir = printerVecFromScene(preview.camera.position.clone().sub(preview.controls.target));
    //   const scenePos = preview.camera.position;
    //   console.log(
    //     "[gcode view] printer dir [x,y,z]:",
    //     [round2(printerDir.x), round2(printerDir.y), round2(printerDir.z)],
    //     "| scene pos:",
    //     [round2(scenePos.x), round2(scenePos.y), round2(scenePos.z)]
    //   );
    // }
  }, []);

  const stepViewTransition = useCallback(() => {
    const preview = previewRef.current;
    const transition = transitionRef.current;
    if (!preview?.camera || !preview?.controls || !transition) {
      rafRef.current = 0;
      return;
    }
    const progress = clamp((performance.now() - transition.startTime) / transition.durationMs, 0, 1);
    const eased = easeInOutCubic(progress);
    preview.camera.position.lerpVectors(transition.startPosition, transition.endPosition, eased);
    preview.camera.up.lerpVectors(transition.startUp, transition.endUp, eased).normalize();
    preview.camera.lookAt(preview.controls.target);
    preview.controls.update();
    updateGizmoState();
    if (progress < 1) {
      rafRef.current = requestAnimationFrame(stepViewTransition);
    } else {
      transitionRef.current = null;
      rafRef.current = 0;
    }
  }, [updateGizmoState]);

  const startViewTransition = useCallback((printerDirection, printerUp) => {
    const preview = previewRef.current;
    if (!preview?.camera || !preview?.controls) {
      return false;
    }
    const directionScene = sceneVecFromPrinter(printerDirection);
    const upScene = sceneVecFromPrinter(printerUp);
    if (directionScene.lengthSq() < 1e-6 || upScene.lengthSq() < 1e-6) {
      return false;
    }
    const target = preview.controls.target;
    const distance = preview.camera.position.distanceTo(target) || 1;
    transitionRef.current = {
      startTime: performance.now(),
      durationMs: VIEW_PLANE_TRANSITION_MS,
      startPosition: preview.camera.position.clone(),
      endPosition: target.clone().add(directionScene.normalize().multiplyScalar(distance)),
      startUp: preview.camera.up.clone(),
      endUp: upScene.normalize()
    };
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = requestAnimationFrame(stepViewTransition);
    return true;
  }, [stepViewTransition]);

  const activateViewPlaneFace = useCallback((faceId) => {
    const face = GCODE_VIEW_PLANE_FACE_BY_ID[faceId];
    if (!face) {
      return false;
    }
    setActiveViewPlaneFace(face.id);
    return startViewTransition(face.direction, face.up);
  }, [startViewTransition]);

  const activateDefaultViewPlane = useCallback(() => {
    setActiveViewPlaneFace("");
    return startViewTransition(DEFAULT_VIEW_DIRECTION, WORLD_UP);
  }, [startViewTransition]);

  // Init the preview once. gcode-preview reads the canvas size on construction
  // and on resize(); the ResizeObserver below keeps it in sync.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }
    const resolvedBuildVolume = buildVolume || DEFAULT_BUILD_VOLUME;
    const initialPosition = defaultGcodeCameraPosition(resolvedBuildVolume);
    const preview = initGcodePreview({
      canvas,
      buildVolume: resolvedBuildVolume,
      // Match the CAD/STL viewer's near-black scene background (BASE_VIEWER_THEME
      // sceneBackground) so the gcode mode reads as dark and consistent rather
      // than the lighter app chrome background.
      backgroundColor: readCssVar("--ui-viewer-bg", "#09090b"),
      renderExtrusion: true,
      renderTravel: showTravel,
      renderTubes,
      // Open on the default top-left view; the gizmo's reset returns here.
      initialCameraPosition: [initialPosition.x, initialPosition.y, initialPosition.z]
    });
    previewRef.current = preview;

    // The bed-origin triad must survive the library's per-render scene rebuilds:
    // render() calls initScene() which strips every scene child. Re-add the same
    // instance (and re-draw, since screenshot capture reads the buffer right after
    // render()) at the tail of every render() call.
    const originAxes = buildOriginAxes(resolvedBuildVolume);
    originAxesRef.current = originAxes;
    const baseRender = preview.render.bind(preview);
    preview.render = () => {
      baseRender();
      const axes = originAxesRef.current;
      if (axes) {
        preview.scene.add(axes);
        preview.renderer.render(preview.scene, preview.camera);
      }
    };
    preview.scene.add(originAxes);
    preview.renderer.render(preview.scene, preview.camera);

    const handleControlsChange = () => updateGizmoState();
    preview.controls?.addEventListener("change", handleControlsChange);
    updateGizmoState();

    return () => {
      preview.controls?.removeEventListener("change", handleControlsChange);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      transitionRef.current = null;
      previewRef.current = null;
      hasContentRef.current = false;
      disposeOriginAxes(originAxesRef.current);
      originAxesRef.current = null;
      preview.dispose?.();
    };
    // Init is intentionally mount-only; option/data changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the renderer sized to the container.
  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver !== "function") {
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      previewRef.current?.resize?.();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Load + parse the G-code whenever the source changes.
  useEffect(() => {
    const preview = previewRef.current;
    if (!preview || !gcodeUrl) {
      return undefined;
    }
    const controller = new AbortController();
    let cancelled = false;
    onViewerAlertChange?.(null);

    (async () => {
      try {
        const text = await loadRenderText(gcodeUrl, { signal: controller.signal });
        if (cancelled) {
          return;
        }
        preview.clear();
        preview.processGCode(text);
        hasContentRef.current = true;
        applyOptions(preview, optionsRef.current);
        preview.render();
        const layerCount = Array.isArray(preview.layers) ? preview.layers.length : 0;
        onReady?.({ layerCount });
      } catch (err) {
        if (cancelled || controller.signal.aborted) {
          return;
        }
        onViewerAlertChange?.({
          severity: "error",
          title: "G-code preview failed",
          detail: err instanceof Error ? err.message : String(err)
        });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // modelKey is included so re-selecting a regenerated file reloads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gcodeUrl, modelKey]);

  // Re-render (no reparse) when display options change.
  useEffect(() => {
    const preview = previewRef.current;
    if (!preview || !hasContentRef.current) {
      return;
    }
    applyOptions(preview, { topLayer, showTravel, renderTubes });
    preview.render();
  }, [topLayer, showTravel, renderTubes]);

  useImperativeHandle(ref, () => ({
    async captureScreenshot({ filename = "gcode-screenshot.png", mode = "download" } = {}) {
      const preview = previewRef.current;
      if (!preview?.canvas) {
        throw new Error("G-code preview not ready");
      }
      const blob = captureCanvasBlob(preview);
      if (mode === "clipboard") {
        return await copyImageBlobToClipboard(Promise.resolve(blob));
      }
      return triggerBlobDownload(blob, { filename });
    },
    // gcode has no shared perspective-restore flow; callers use optional chaining.
    getPerspective() {
      return null;
    },
    setPerspective() {
      return false;
    }
  }), []);

  return (
    <div ref={containerRef} className="absolute inset-0">
      <canvas ref={canvasRef} className="h-full w-full" />
      {showViewPlane ? (
        <ViewPlaneControl
          showViewPlane
          previewMode={false}
          isLoading={false}
          meshData={VIEW_PLANE_PRESENT}
          viewPlaneOffsetRight={16}
          viewPlaneOffsetBottom={16}
          compact={false}
          activeViewPlaneFace={activeViewPlaneFace}
          viewPlaneFaces={GCODE_VIEW_PLANE_FACES}
          viewPlaneOrientation={viewPlaneOrientation}
          activateViewPlaneFace={activateViewPlaneFace}
          activateDefaultViewPlane={activateDefaultViewPlane}
        />
      ) : null}
    </div>
  );
});

// gcode-preview's `endLayer` is the (inclusive) top visible layer index; a null
// topLayer means "show every layer".
function applyOptions(preview, { topLayer, showTravel, renderTubes }) {
  preview.renderTravel = Boolean(showTravel);
  preview.renderTubes = Boolean(renderTubes);
  const layerCount = Array.isArray(preview.layers) ? preview.layers.length : 0;
  if (topLayer == null || layerCount <= 0) {
    preview.endLayer = undefined;
  } else {
    preview.endLayer = Math.min(Math.max(Math.trunc(Number(topLayer)), 0), layerCount - 1);
  }
}

export default GcodePreviewPane;
