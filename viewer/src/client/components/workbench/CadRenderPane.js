import { useEffect, useRef, useState } from "react";
import { Box, ChevronLeft, ChevronRight, CircleAlert, Image as ImageIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { cn } from "@/ui/utils";
import { ModelCanvas } from "../viewer3d/ModelCanvas";
import { CanvasErrorBoundary } from "../viewer3d/CanvasErrorBoundary";
import { ViewerTools } from "../viewer3d/ViewerTools";
import { DrawingOverlay } from "../viewer3d/DrawingOverlay";
import GcodePreviewPane from "./GcodePreviewPane";

const SLIDE_BTN =
  "pointer-events-auto flex size-9 items-center justify-center rounded-full cad-glass-surface border border-sidebar-border text-sidebar-foreground shadow-sm transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";

const VIEWPORT_ISSUE_META = Object.freeze({
  error: {
    label: "Error",
    borderClassName: "border-destructive/45",
    iconClassName: "border-destructive/45 bg-destructive/10 text-destructive dark:text-red-300",
    labelClassName: "text-destructive dark:text-red-300"
  },
  warning: {
    label: "Warning",
    borderClassName: "border-amber-500/45",
    iconClassName: "border-amber-500/55 bg-amber-500/10 text-amber-500 dark:text-amber-300",
    labelClassName: "text-amber-500 dark:text-amber-300"
  }
});

function viewportInsetPx(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : 0;
}

function viewportIssueMetaForAlert(alert) {
  return alert?.severity === "warning"
    ? VIEWPORT_ISSUE_META.warning
    : VIEWPORT_ISSUE_META.error;
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function copyBlobToClipboard(blob) {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    throw new Error("Clipboard image copy is not supported in this environment.");
  }
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}

/**
 * The 3D render surface. A single STL viewer (react-three-fiber) fed the selected
 * entry's preview `.stl` URL. Overlays for a missing file and viewer errors ride on
 * top; the surrounding chrome (chat, sidebar, toolbar) lives in CadWorkspace.
 */
export default function CadRenderPane({
  viewerRef,
  stlUrl = "",
  selectedKey,
  missingFileRef = "",
  previewMode,
  suppressEmptyState = false,
  showBed = false,
  viewportFrameInsets,
  viewerAlert,
  drawToolActive = false,
  drawingTool,
  drawingStrokes,
  onDrawingStrokesChange,
  gcodeUrl = "",
  gcodeTopLayer = null,
  gcodeShowTravel = false,
  gcodeRenderTubes = false,
  onGcodeReady,
  onGcodeViewerAlertChange,
  handleViewerAlertChange,
  images = [],
  slideCount = 0,
  activeSlide = 0,
  onSlideChange
}) {
  const viewerAlertIconLabel = "Viewer error. See the Issues section for details.";
  const missingFileLabel = String(missingFileRef || "").trim();
  // A sliced `.gcode` toolpath is rendered by the dedicated gcode preview pane; STL
  // models by the fiber ModelCanvas. gcode takes precedence when both resolve.
  const gcodeMode = Boolean(gcodeUrl);
  const hasModel = !gcodeMode && Boolean(stlUrl);
  const imageList = Array.isArray(images) ? images : [];
  const hasImages = imageList.length > 0;
  // Two tabs sharing one slider: the 3D tab pages through every 3D model in the
  // project (each selection drives the canvas); the Image tab pages through every
  // generated render. The toggle switches tabs; the slider (arrows + dots) pages
  // within the active tab. gcode mode owns the stage and shows neither.
  const [viewMode, setViewMode] = useState("3d");
  const [imageIndex, setImageIndex] = useState(0);
  // Fall back to 3D whenever the project has no images so the Image tab can never
  // strand the viewer on an empty stage.
  useEffect(() => {
    if (!hasImages && viewMode !== "3d") {
      setViewMode("3d");
    }
  }, [hasImages, viewMode]);
  const imageMode = !gcodeMode && viewMode === "image" && hasImages;
  const safeImageIndex = hasImages ? Math.min(imageIndex, imageList.length - 1) : 0;
  const currentImage = imageMode ? imageList[safeImageIndex] : null;
  const showModel = !gcodeMode && !imageMode && hasModel;
  const showImage = Boolean(currentImage);
  const goToImage = (index) => {
    const len = imageList.length;
    if (len < 1) {
      return;
    }
    setImageIndex(((index % len) + len) % len);
  };

  // The slider is tab-aware: models in the 3D tab, images in the Image tab.
  const sliderCount = imageMode ? imageList.length : slideCount;
  const sliderIndex = imageMode ? safeImageIndex : activeSlide;
  const slideTo = imageMode ? goToImage : (index) => onSlideChange?.(index);
  const slideNoun = imageMode ? "image" : "model";
  const showSlider = !previewMode && !gcodeMode && sliderCount > 1;
  const canToggleView = !previewMode && !gcodeMode && hasImages && hasModel;
  // Imperative reset published by ModelCanvas (re-frames to the default view) plus the
  // print-bed / dimensions toggle — both driven from the ViewerTools overlay.
  const resetViewerRef = useRef(null);
  const [showBedOverlay, setShowBedOverlay] = useState(showBed);
  // ModelCanvas publishes its capture handle here; the drawing overlay publishes its
  // 2D canvas here. CadRenderPane owns `viewerRef` and composites the two so a
  // screenshot (e.g. "Send to chat") carries the annotations drawn on the model.
  const modelCaptureRef = useRef(null);
  const drawingCanvasElRef = useRef(null);

  useEffect(() => {
    // In gcode mode the preview pane owns `viewerRef` (via its own imperative handle),
    // so the STL composite handle must not clobber it.
    if (!viewerRef || gcodeMode) {
      return undefined;
    }
    viewerRef.current = {
      getCanvas() {
        return modelCaptureRef.current?.getCanvas?.() || null;
      },
      // Screen rect of the 2D annotation canvas, used to place the region-note
      // popover (draw a region → type a prompt → send to the model).
      getDrawingCanvasRect() {
        return drawingCanvasElRef.current?.getBoundingClientRect() || null;
      },
      async captureScreenshot({ mode = "blob", filename } = {}) {
        const modelCanvas = modelCaptureRef.current?.getCanvas?.();
        if (!modelCanvas) {
          return undefined;
        }
        const width = modelCanvas.width || 1;
        const height = modelCanvas.height || 1;
        const composite = document.createElement("canvas");
        composite.width = width;
        composite.height = height;
        const ctx = composite.getContext("2d");
        if (!ctx) {
          return undefined;
        }
        ctx.drawImage(modelCanvas, 0, 0, width, height);
        const drawingCanvas = drawingCanvasElRef.current;
        if (drawingCanvas && drawingCanvas.width && drawingCanvas.height) {
          // The annotation canvas covers the same viewport; scale it onto the export.
          ctx.drawImage(drawingCanvas, 0, 0, width, height);
        }
        const blob = await new Promise((resolve) => composite.toBlob((b) => resolve(b), "image/png"));
        if (!blob) {
          return undefined;
        }
        if (mode === "download") {
          triggerBlobDownload(blob, filename || "model.png");
          return undefined;
        }
        if (mode === "clipboard") {
          await copyBlobToClipboard(blob);
          return undefined;
        }
        return blob;
      }
    };
    return () => {
      if (viewerRef) {
        viewerRef.current = null;
      }
    };
  }, [viewerRef, gcodeMode]);
  const blockingViewerAlert = viewerAlert && viewerAlert.blocking !== false && (
    viewerAlert.blocking ||
    viewerAlert.severity !== "warning" ||
    !(hasModel || gcodeMode)
  )
    ? viewerAlert
    : null;
  const viewportIssueMeta = viewportIssueMetaForAlert(blockingViewerAlert);

  const modelViewportOverlayStyle = {
    left: `${viewportInsetPx(viewportFrameInsets?.left)}px`,
    right: `${viewportInsetPx(viewportFrameInsets?.right)}px`,
    top: `${viewportInsetPx(viewportFrameInsets?.top)}px`,
    bottom: `${viewportInsetPx(viewportFrameInsets?.bottom)}px`
  };
  // The render pane is a full-bleed layer behind the floating sidebars; inset the
  // actual 3D stage by the sidebar/sheet widths so the canvas lives in the visible
  // column *between* the left (Models) sidebar and the right (file sheet) panel
  // instead of stretching underneath them.
  const modelStageStyle = modelViewportOverlayStyle;

  return (
    <div className="absolute inset-0">
      <div className="absolute overflow-hidden" style={modelStageStyle}>
        {gcodeMode ? (
          <GcodePreviewPane
            ref={viewerRef}
            gcodeUrl={gcodeUrl}
            modelKey={selectedKey}
            topLayer={gcodeTopLayer}
            showTravel={gcodeShowTravel}
            renderTubes={gcodeRenderTubes}
            onReady={onGcodeReady}
            onViewerAlertChange={onGcodeViewerAlertChange || handleViewerAlertChange}
          />
        ) : showModel ? (
          <CanvasErrorBoundary
            resetKey={stlUrl}
            fallback={
              <div className="pointer-events-none absolute inset-0 grid place-items-center bg-background/60 px-6 text-center">
                <p className="text-sm text-muted-foreground">Could not load the model preview.</p>
              </div>
            }
          >
            <ModelCanvas
              key={selectedKey || stlUrl}
              url={stlUrl}
              captureRef={modelCaptureRef}
              resetRef={resetViewerRef}
              showBed={showBedOverlay}
            />
          </CanvasErrorBoundary>
        ) : showImage ? (
          <div className="absolute inset-0 bg-background">
            <img
              src={currentImage.url}
              alt={currentImage.name || "Preview image"}
              className="h-full w-full bg-background object-contain"
              draggable={false}
            />
          </div>
        ) : suppressEmptyState ? (
          // Live build stage owns the viewport (the blueprint overlay is drawn on
          // top by CadWorkspace) — keep an empty background so the placeholder text
          // doesn't show through mid-generation.
          <div className="absolute inset-0 bg-background" />
        ) : (
          <div className="absolute inset-0 grid place-items-center bg-background text-center">
            <p className="px-6 text-sm text-muted-foreground">No model to preview yet.</p>
          </div>
        )}

        {showModel ? (
          <DrawingOverlay
            enabled={Boolean(drawToolActive) && !previewMode}
            drawingTool={drawingTool}
            drawingStrokes={drawingStrokes}
            onDrawingStrokesChange={onDrawingStrokesChange}
            previewMode={previewMode}
            canvasElementRef={drawingCanvasElRef}
          />
        ) : null}

        {/* Prev/next within the active tab — all 3D models (3D tab) or all
            renders (Image tab). Arrows flank the stage, dots mark the position. */}
        {showSlider ? (
          <>
            <button
              type="button"
              onClick={() => slideTo(sliderIndex - 1)}
              aria-label={`Previous ${slideNoun}`}
              className={cn(SLIDE_BTN, "absolute left-4 top-1/2 z-20 -translate-y-1/2")}
            >
              <ChevronLeft className="size-5" strokeWidth={2} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => slideTo(sliderIndex + 1)}
              aria-label={`Next ${slideNoun}`}
              className={cn(SLIDE_BTN, "absolute right-4 top-1/2 z-20 -translate-y-1/2")}
            >
              <ChevronRight className="size-5" strokeWidth={2} aria-hidden="true" />
            </button>
            <div className="pointer-events-auto absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full cad-glass-surface border border-sidebar-border px-3 py-2 shadow-sm">
              {Array.from({ length: sliderCount }).map((_, i) => (
                <button
                  // Dots index a fixed-length slide list, so position is a stable key.
                  // eslint-disable-next-line react/no-array-index-key
                  key={i}
                  type="button"
                  onClick={() => slideTo(i)}
                  aria-label={`Go to ${slideNoun} ${i + 1}`}
                  aria-current={i === sliderIndex}
                  className={cn(
                    "h-2 rounded-full transition-all",
                    i === sliderIndex
                      ? "w-6 bg-primary"
                      : "w-2 bg-muted-foreground/40 hover:bg-muted-foreground/70",
                  )}
                />
              ))}
            </div>
          </>
        ) : null}

        {/* 3D / Image tab toggle — bottom-left glass pill, mirrors the model
            website's viewer. Shown only when the project has both a model and
            images to switch between. */}
        {canToggleView ? (
          <div className="pointer-events-auto absolute bottom-4 left-4 z-20 flex items-center gap-1 rounded-full cad-glass-surface border border-sidebar-border p-1 shadow-sm">
            <ViewModeButton
              active={!imageMode}
              onClick={() => setViewMode("3d")}
              icon={<Box className="size-4" strokeWidth={2} aria-hidden="true" />}
              label="3D"
            />
            <ViewModeButton
              active={imageMode}
              onClick={() => setViewMode("image")}
              icon={<ImageIcon className="size-4" strokeWidth={2} aria-hidden="true" />}
              label="Image"
            />
          </div>
        ) : null}
      </div>

      {showModel && !previewMode ? (
        <ViewerTools
          resetRef={resetViewerRef}
          showBed={showBedOverlay}
          onToggleBed={() => setShowBedOverlay((value) => !value)}
          viewportFrameInsets={viewportFrameInsets}
        />
      ) : null}

      {!previewMode && missingFileLabel ? (
        <div
          className="pointer-events-none absolute z-30 flex min-w-0 items-center justify-center px-4 py-4"
          style={modelViewportOverlayStyle}
        >
          <Alert
            variant="destructive"
            className="cad-glass-popover pointer-events-auto w-full max-w-xl min-w-0 p-5 text-center shadow-lg"
          >
            <p className="col-start-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-destructive">
              File does not exist
            </p>
            <AlertTitle className="col-start-1 mt-1 line-clamp-none text-lg text-foreground">File does not exist</AlertTitle>
            <AlertDescription className="col-start-1 mt-1 text-sm leading-6 text-muted-foreground">
              <code className="rounded-md bg-muted px-2 py-1 text-xs text-foreground">{missingFileLabel}</code>
            </AlertDescription>
          </Alert>
        </div>
      ) : null}

      {!previewMode && blockingViewerAlert ? (
        <div
          className="pointer-events-none absolute z-30 flex min-w-0 items-center justify-center px-3 py-3 sm:px-4"
          style={modelViewportOverlayStyle}
        >
          <div
            role="alert"
            aria-label={viewerAlertIconLabel}
            title={viewerAlertIconLabel}
            className={cn(
              "cad-glass-popover pointer-events-auto flex w-full max-w-sm min-w-0 flex-col items-center gap-2 rounded-md border px-4 py-3 text-center shadow-md",
              viewportIssueMeta.borderClassName
            )}
          >
            <span className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-full border",
              viewportIssueMeta.iconClassName
            )}>
              <CircleAlert className="size-5" strokeWidth={2} aria-hidden="true" />
            </span>
            <div className="min-w-0 max-w-full">
              <span className={cn(
                "text-[10px] font-medium uppercase tracking-[0.08em]",
                viewportIssueMeta.labelClassName
              )}>
                {viewportIssueMeta.label}
              </span>
              <div className="mt-1 line-clamp-2 min-w-0 max-w-full break-words text-sm font-medium leading-5 text-foreground">
                {viewerAlert.title || viewerAlert.summary || "Viewer issue"}
              </div>
              {viewerAlert.message ? (
                <p className="mt-1 line-clamp-3 min-w-0 max-w-full break-words text-xs leading-5 text-muted-foreground">
                  {viewerAlert.message}
                </p>
              ) : null}
              {viewerAlert.resolution ? (
                <p className="mt-1 line-clamp-2 min-w-0 max-w-full break-words text-xs leading-5 text-muted-foreground">
                  {viewerAlert.resolution}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Segmented control button used by the 3D / Image view toggle. */
function ViewModeButton({ active, onClick, icon, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1.5 rounded-full px-3 py-1 text-[0.8125rem] font-medium transition-colors",
        active
          ? "bg-primary/85 text-primary-foreground"
          : "text-sidebar-foreground/70 hover:text-sidebar-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
