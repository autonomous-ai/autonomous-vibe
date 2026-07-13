import {
  AlertTriangle,
  Box,
  Layers,
  PenTool,
  Printer,
  Share2
} from "lucide-react";
import { RENDER_FORMAT } from "@/workbench/constants";
import { TooltipProvider } from "../ui/tooltip";
import DrawingToolbar from "./DrawingToolbar";
import { ToolbarButton } from "./ToolbarButton";
import { CAD_WORKSPACE_TOOLBAR_DESKTOP_WIDTH_CLASS } from "./ToolbarShell";

const FLOATING_TOOL_BAR_SURFACE_CLASS =
  "cad-glass-surface border border-sidebar-border text-sidebar-foreground shadow-sm";

function DesktopFloatingToolBar({
  renderFormat,
  floatingCadToolbarPosition,
  selectionToolActive,
  referenceSelectionPending = false,
  referenceSelectionUnavailable = false,
  referenceSelectionDeferred = false,
  urdfPosePickerAvailable = false,
  urdfPosePickerActive = false,
  handleToggleUrdfPosePicker,
  drawToolActive,
  handleSelectTabToolMode,
  viewerLoading,
  selectedMeshData,
  selectedDxfData,
  drawingToolOptions,
  drawingTool,
  handleSelectDrawingTool,
  handleUndoDrawing,
  handleRedoDrawing,
  handleClearDrawings,
  handleSendDrawingToChat,
  canUndoDrawing,
  canRedoDrawing,
  drawingStrokes,
  rulerToolActive = false,
  rulerToolOptions = [],
  rulerTool,
  rulerUnit,
  rulerMeasurements = [],
  rulerVisible = true,
  handleSelectRulerTool,
  handleSelectRulerUnit,
  handleToggleRulerVisible,
  handleClearRulerMeasurements,
  handleRemoveRulerMeasurement,
  handleCopyRulerMeasurement,
  canSlice = false,
  slicing = false,
  sliceLabel = "Slice plate",
  sliceError = "",
  handleSlicePlate,
  canPrint = false,
  printing = false,
  printLabel = "Print",
  handlePrint,
  canPublish = false,
  publishing = false,
  publishLabel = "Publish",
  handlePublish,
  canViewSourceModel = false,
  viewSourceModelLabel = "View model",
  handleViewSourceModel,
  canOpenInStudio = false,
  openingInStudio = false,
  openInStudioLabel = "Open in Bambu Studio",
  handleOpenInStudio
}) {
  const dxfMode = renderFormat === RENDER_FORMAT.DXF;
  const captureDisabled = viewerLoading || (dxfMode ? !selectedDxfData : !selectedMeshData);

  return (
    <div
      className="absolute z-20 flex flex-col items-end gap-1.5"
      style={floatingCadToolbarPosition}
    >
      <TooltipProvider delayDuration={250}>
        <div className={`pointer-events-auto inline-flex w-fit items-center gap-1 self-end rounded-md p-1 ${FLOATING_TOOL_BAR_SURFACE_CLASS}`}>
          {/* Draw is a screen-space annotation overlay — available for the mesh (STL)
              preview, not for DXF. Toggles: click again to leave draw mode. */}
          {!dxfMode ? (
            <ToolbarButton
              label={drawToolActive ? "Done drawing" : "Draw"}
              active={drawToolActive}
              onClick={() => handleSelectTabToolMode(drawToolActive ? "references" : "draw")}
              disabled={viewerLoading || !selectedMeshData}
              aria-pressed={drawToolActive}
            >
              <PenTool className="size-3.5" strokeWidth={2} aria-hidden="true" />
            </ToolbarButton>
          ) : null}

          {canSlice ? (
            <ToolbarButton
              label={sliceLabel}
              onClick={() => {
                void handleSlicePlate?.();
              }}
              disabled={captureDisabled || slicing}
              className="h-9 w-auto gap-1.5 px-3 text-sm font-medium"
            >
              <Layers className="size-4" strokeWidth={2} aria-hidden="true" />
              {sliceLabel}
            </ToolbarButton>
          ) : null}

          {/* Publish the finished model to panda-social (design-import API).
              Shown for a printable model view; disabled while an upload is in
              flight. Copies the project workspace and returns the design URL. */}
          {canPublish ? (
            <ToolbarButton
              label={publishLabel}
              onClick={() => {
                void handlePublish?.();
              }}
              disabled={publishing}
              className="h-9 w-auto gap-1.5 px-3 text-sm font-medium"
            >
              <Share2 className="size-4" strokeWidth={2} aria-hidden="true" />
              {publishLabel}
            </ToolbarButton>
          ) : null}

          {/* Sliced-gcode escape hatch: a `.gcode` view has no model to
              manipulate, so offer a one-click return to the source STL the
              toolpath was sliced from (resolved in CadWorkspace). */}
          {canViewSourceModel ? (
            <ToolbarButton
              label={viewSourceModelLabel}
              onClick={() => {
                handleViewSourceModel?.();
              }}
              className="h-9 w-auto gap-1.5 px-3 text-sm font-medium"
            >
              <Box className="size-4" strokeWidth={2} aria-hidden="true" />
              {viewSourceModelLabel}
            </ToolbarButton>
          ) : null}

          {canPrint ? (
            <ToolbarButton
              label={printLabel}
              onClick={() => {
                void handlePrint?.();
              }}
              disabled={printing}
              className="h-9 w-auto gap-1.5 px-3 text-sm font-medium"
            >
              <Printer className="size-4" strokeWidth={2} aria-hidden="true" />
              {printLabel}
            </ToolbarButton>
          ) : null}

          {/* Dedicated STL hand-off: always enabled (it needs no paired printer
              or slice — just opens the model in the locally installed slicer,
              Bambu Studio or OrcaSlicer), disabled only while the open is in
              flight. The label names whichever app will actually open. */}
          {canOpenInStudio ? (
            <ToolbarButton
              label={openInStudioLabel}
              onClick={() => {
                void handleOpenInStudio?.();
              }}
              disabled={openingInStudio}
              className="h-9 w-auto gap-1.5 px-3 text-sm font-medium"
            >
              <Printer className="size-4" strokeWidth={2} aria-hidden="true" />
              {openInStudioLabel}
            </ToolbarButton>
          ) : null}
        </div>
      </TooltipProvider>

      {/* Persistent slice failure — the transient toast was too easy to miss,
          so failures (e.g. OrcaSlicer not found) stick next to the button
          until the next slice attempt clears them. */}
      {canSlice && sliceError ? (
        <div
          role="alert"
          className={`pointer-events-auto flex max-w-xs items-start gap-1.5 self-end rounded-md px-2.5 py-1.5 text-xs text-destructive ${FLOATING_TOOL_BAR_SURFACE_CLASS}`}
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{sliceError}</span>
        </div>
      ) : null}

      {!dxfMode && drawToolActive ? (
        <DrawingToolbar
          className={CAD_WORKSPACE_TOOLBAR_DESKTOP_WIDTH_CLASS}
          drawingToolOptions={drawingToolOptions}
          drawingTool={drawingTool}
          handleSelectDrawingTool={handleSelectDrawingTool}
          handleUndoDrawing={handleUndoDrawing}
          handleRedoDrawing={handleRedoDrawing}
          handleClearDrawings={handleClearDrawings}
          handleSendDrawingToChat={handleSendDrawingToChat}
          canUndoDrawing={canUndoDrawing}
          canRedoDrawing={canRedoDrawing}
          drawingStrokes={drawingStrokes}
        />
      ) : null}
    </div>
  );
}

export default function FloatingToolBar({
  previewMode,
  selectedEntry,
  ...toolbarProps
}) {
  if (previewMode || !selectedEntry) {
    return null;
  }

  return <DesktopFloatingToolBar {...toolbarProps} />;
}
