import {
  Crosshair,
  Layers,
  MousePointer2,
  PenTool
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
  handleSliceForBambu
}) {
  const dxfMode = renderFormat === RENDER_FORMAT.DXF;
  const urdfMode = renderFormat === RENDER_FORMAT.URDF;
  const robotMode = isRobotRenderFormat(renderFormat);
  const meshOnlyMode = isMeshRenderFormat(renderFormat);
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
          {!dxfMode && !robotMode && !meshOnlyMode ? (
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
              label={slicing ? "Slicing…" : "Slice for Bambu"}
              onClick={() => {
                void handleSliceForBambu?.();
              }}
              disabled={captureDisabled || slicing}
              className="h-9 w-auto gap-1.5 px-3 text-sm font-medium"
            >
              <Layers className="size-4" strokeWidth={2} aria-hidden="true" />
              {slicing ? "Slicing…" : "Slice for Bambu"}
            </ToolbarButton>
          ) : null}
        </div>
      </TooltipProvider>

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
