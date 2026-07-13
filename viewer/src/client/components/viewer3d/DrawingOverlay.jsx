import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/ui/utils";
import {
  DRAWING_ERASE_THRESHOLD_PX,
  DRAWING_MIN_POINT_DISTANCE_PX,
  DRAWING_MIN_STROKE_LENGTH_PX,
  buildFillStrokeAtPoint,
  maxDrawingStrokeOrdinal,
  redrawDrawingCanvas
} from "cadjs/lib/viewer/drawingCanvas";
import {
  buildDrawingPoint,
  distanceToStrokeInPixels,
  drawingToolNeedsTwoPoints,
  strokeLengthInPixels
} from "cadjs/lib/viewer/drawingGeometry";
import { useViewerDrawingOverlay } from "./useViewerDrawingOverlay";

/**
 * 2D annotation layer drawn over the STL viewer. A screen-space canvas the user
 * sketches on (freehand / line / arrow / rectangle / circle / fill / erase); strokes
 * are normalized 0–1 so they track the viewport as it resizes. Restored from the old
 * CadViewer drawing overlay — decoupled from the 3D scene, so the pixel-space tools
 * work unchanged (the 3D-only "surface line" tool is already coerced to freehand
 * upstream in CadWorkspace). Captures pointer input only while `enabled`, so orbiting
 * the model still works when the draw tool is off.
 */
export function DrawingOverlay({
  enabled = false,
  drawingTool,
  drawingStrokes,
  onDrawingStrokesChange,
  previewMode = false,
  canvasElementRef
}) {
  const canvasRef = useRef(null);
  const draftRef = useRef(null);
  const strokesRef = useRef(Array.isArray(drawingStrokes) ? drawingStrokes : []);
  const changeRef = useRef(onDrawingStrokesChange);
  const idRef = useRef(0);
  const [readyTick, setReadyTick] = useState(0);

  changeRef.current = onDrawingStrokesChange;

  // Publish the backing canvas so the pane can composite annotations into exports.
  useEffect(() => {
    if (canvasElementRef) {
      canvasElementRef.current = canvasRef.current;
    }
    return () => {
      if (canvasElementRef) {
        canvasElementRef.current = null;
      }
    };
  }, [canvasElementRef]);

  const syncDrawingCanvasSize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }
    const parent = canvas.parentElement;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const width = Math.max(1, Math.round((parent?.clientWidth || 1) * dpr));
    const height = Math.max(1, Math.round((parent?.clientHeight || 1) * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return canvas;
  }, []);

  const renderDrawingOverlay = useCallback(() => {
    const canvas = syncDrawingCanvasSize();
    if (!canvas) {
      return;
    }
    redrawDrawingCanvas(canvas, strokesRef.current, draftRef.current);
  }, [syncDrawingCanvasSize]);

  // Keep the stroke mirror + id counter in sync with the controlled prop, then redraw.
  useEffect(() => {
    strokesRef.current = Array.isArray(drawingStrokes) ? drawingStrokes : [];
    idRef.current = Math.max(idRef.current, maxDrawingStrokeOrdinal(strokesRef.current));
    renderDrawingOverlay();
  }, [drawingStrokes, renderDrawingOverlay]);

  // Resize the backing canvas with its container so strokes stay aligned.
  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!parent || typeof ResizeObserver === "undefined") {
      renderDrawingOverlay();
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      renderDrawingOverlay();
      setReadyTick((tick) => tick + 1);
    });
    observer.observe(parent);
    renderDrawingOverlay();
    return () => observer.disconnect();
  }, [renderDrawingOverlay]);

  useViewerDrawingOverlay({
    drawingCanvasRef: canvasRef,
    drawingDraftRef: draftRef,
    drawingStrokesRef: strokesRef,
    drawingChangeRef: changeRef,
    drawingIdRef: idRef,
    drawingEnabled: enabled,
    drawingTool,
    // Truthy sentinel: the overlay activates whenever the draw tool is on and a model
    // is showing (the parent only mounts this component when there is one).
    meshData: enabled ? true : null,
    previewMode,
    viewerReadyTick: readyTick,
    renderDrawingOverlay,
    redrawDrawingCanvas,
    buildDrawingPoint,
    distanceToStrokeInPixels,
    strokeLengthInPixels,
    drawingToolNeedsTwoPoints,
    buildFillStrokeAtPoint,
    // Surface-line anchoring needs the 3D scene; it's coerced to freehand upstream,
    // so no anchor providers are wired here.
    buildSurfaceLineAnchor: undefined,
    updateSurfaceLineAnchor: undefined,
    drawingEraseThresholdPx: DRAWING_ERASE_THRESHOLD_PX,
    drawingMinPointDistancePx: DRAWING_MIN_POINT_DISTANCE_PX,
    drawingMinStrokeLengthPx: DRAWING_MIN_STROKE_LENGTH_PX
  });

  return (
    <canvas
      ref={canvasRef}
      className={cn(
        "absolute inset-0 z-10 h-full w-full",
        enabled ? "pointer-events-auto cursor-crosshair" : "pointer-events-none"
      )}
      style={{ touchAction: "none" }}
    />
  );
}
