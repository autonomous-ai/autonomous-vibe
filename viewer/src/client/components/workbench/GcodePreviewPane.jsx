"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { init as initGcodePreview } from "gcode-preview";
import { loadRenderText } from "cadjs/lib/renderAssetClient";
import { copyImageBlobToClipboard } from "@/ui/clipboard";
import { triggerBlobDownload } from "@/ui/download";

// Bambu Lab is the only supported printer family (v1), so a fixed bed box is a
// reasonable default for the build-volume overlay. Most Bambu G-code lives in
// 0..256 coordinates, so the box lines up with the toolpath.
const DEFAULT_BUILD_VOLUME = { x: 256, y: 256, z: 256 };

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
 */
const GcodePreviewPane = forwardRef(function GcodePreviewPane({
  gcodeUrl = "",
  modelKey = "",
  topLayer = null,
  showTravel = false,
  renderTubes = false,
  buildVolume = DEFAULT_BUILD_VOLUME,
  onReady,
  onViewerAlertChange
}, ref) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const previewRef = useRef(null);
  const hasContentRef = useRef(false);

  // Latest option values, read inside the load effect without re-running it.
  const optionsRef = useRef({ topLayer, showTravel, renderTubes });
  optionsRef.current = { topLayer, showTravel, renderTubes };

  // Init the preview once. gcode-preview reads the canvas size on construction
  // and on resize(); the ResizeObserver below keeps it in sync.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }
    const preview = initGcodePreview({
      canvas,
      buildVolume: buildVolume || undefined,
      backgroundColor: readCssVar("--ui-app-bg", "#0b0e14"),
      renderExtrusion: true,
      renderTravel: showTravel,
      renderTubes
    });
    previewRef.current = preview;
    return () => {
      previewRef.current = null;
      hasContentRef.current = false;
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
