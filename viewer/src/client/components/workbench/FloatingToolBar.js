import {
  AlertTriangle,
  Crosshair,
  Layers,
  MousePointer2,
  PenTool,
  Printer
} from "lucide-react";
import { RENDER_FORMAT } from "@/workbench/constants";
import {
  isMeshRenderFormat,
  isRobotRenderFormat
} from "cadjs/lib/fileFormats";
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
  canUndoDrawing,
  canRedoDrawing,
  drawingStrokes,
  canSlice = false,
  slicing = false,
  sliceLabel = "Slice plate",
  sliceError = "",
  handleSlicePlate,
  canPrint = false,
  printing = false,
  printLabel = "Print",
  handlePrint,
  canOpenInStudio = false,
  openingInStudio = false,
  openInStudioLabel = "Open in Bambu Studio",
  handleOpenInStudio
}) {
  const dxfMode = renderFormat === RENDER_FORMAT.DXF;
  const urdfMode = renderFormat === RENDER_FORMAT.URDF;
  const robotMode = isRobotRenderFormat(renderFormat);
  const meshOnlyMode = isMeshRenderFormat(renderFormat);
  const gcodeMode = renderFormat === RENDER_FORMAT.GCODE;
  const captureDisabled = viewerLoading || (dxfMode ? !selectedDxfData : !selectedMeshData);
  const selectDisabled = viewerLoading ||
    !selectedMeshData ||
    referenceSelectionPending ||
    referenceSelectionUnavailable ||
    referenceSelectionDeferred;
  const posePickerDisabled = viewerLoading || !selectedMeshData || !urdfPosePickerAvailable;
  const selectLabel = referenceSelectionPending ? "Preparing selection" : "Select";

  return (
    <div
      className="absolute z-20 flex flex-col items-end gap-1.5"
      style={floatingCadToolbarPosition}
    >
      <TooltipProvider delayDuration={250}>
        <div className={`pointer-events-auto inline-flex w-fit items-center gap-1 self-end rounded-md p-1 ${FLOATING_TOOL_BAR_SURFACE_CLASS}`}>
          {!dxfMode && !robotMode && !meshOnlyMode && !gcodeMode ? (
            <>
              <ToolbarButton
                label={selectLabel}
                active={referenceSelectionDeferred ? false : selectionToolActive}
                onClick={() => handleSelectTabToolMode("references")}
                disabled={selectDisabled}
                aria-pressed={referenceSelectionDeferred ? false : selectionToolActive}
              >
                <MousePointer2 className="size-3.5" strokeWidth={2} aria-hidden="true" />
              </ToolbarButton>

              <ToolbarButton
                label="Draw"
                active={drawToolActive}
                onClick={() => handleSelectTabToolMode("draw")}
                disabled={viewerLoading || !selectedMeshData}
                aria-pressed={drawToolActive}
              >
                <PenTool className="size-3.5" strokeWidth={2} aria-hidden="true" />
              </ToolbarButton>
            </>
          ) : null}

          {!dxfMode && urdfMode ? (
            <ToolbarButton
              label="Select Pose"
              active={urdfPosePickerActive}
              onClick={handleToggleUrdfPosePicker}
              disabled={posePickerDisabled}
              aria-pressed={urdfPosePickerActive}
            >
              <Crosshair className="size-3.5" strokeWidth={2} aria-hidden="true" />
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

      {!dxfMode && !meshOnlyMode && drawToolActive ? (
        <DrawingToolbar
          className={CAD_WORKSPACE_TOOLBAR_DESKTOP_WIDTH_CLASS}
          drawingToolOptions={drawingToolOptions}
          drawingTool={drawingTool}
          handleSelectDrawingTool={handleSelectDrawingTool}
          handleUndoDrawing={handleUndoDrawing}
          handleRedoDrawing={handleRedoDrawing}
          handleClearDrawings={handleClearDrawings}
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
