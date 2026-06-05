import FileSheet, {
  FILE_SHEET_FIELD_LABEL_CLASSES,
  FILE_SHEET_PRECISION_SLIDER_CLASSES,
  FileSheetSection,
  FileSheetSliderField,
  FileSheetSubsection,
  FileSheetToggleRow,
  parseFileSheetNumberInput
} from "./FileSheet";
import {
  Accordion
} from "../ui/accordion";
import { Badge } from "../ui/badge";
import { Slider } from "../ui/slider";
import FileStatusSection from "./FileStatusSection";
const fieldLabelClasses = FILE_SHEET_FIELD_LABEL_CLASSES;

function formatNumber(value, digits = 2) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue.toFixed(digits) : (0).toFixed(digits);
}

function formatCount(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? String(Math.round(numericValue)) : "0";
}

function normalizedBounds(bounds) {
  const min = Array.isArray(bounds?.min) ? bounds.min : [0, 0, 0];
  const max = Array.isArray(bounds?.max) ? bounds.max : [0, 0, 0];
  return { min, max };
}

function boundsAxisText(bounds, axis, digits = 1) {
  const { min, max } = normalizedBounds(bounds);
  return `${formatNumber(min[axis], digits)} to ${formatNumber(max[axis], digits)} mm`;
}

function visibleLayerText(layerCount, maxLayer) {
  if (layerCount < 1) {
    return "0 / 0";
  }
  const visibleCount = maxLayer + 1;
  return visibleCount > 1
    ? `1-${visibleCount} / ${layerCount}`
    : `1 / ${layerCount}`;
}

function parseVisibleLayerInput(value, fallbackVisibleCount, layerCount) {
  if (layerCount < 1) {
    return 0;
  }
  const text = String(value ?? "").trim();
  const rangeMatch = text.match(/\b\d+\s*-\s*(\d+)\b/);
  const parsedValue = rangeMatch?.[1] ?? value;
  return parseFileSheetNumberInput(parsedValue, {
    fallback: fallbackVisibleCount,
    min: 1,
    max: Math.max(layerCount, 0),
    integer: true
  }) - 1;
}

function GcodeValueField({ label, value, mono = false }) {
  const displayValue = String(value ?? "");
  return (
    <div className="block min-w-0">
      <span className={fieldLabelClasses}>{label}</span>
      <div
        className={`mt-1 min-h-7 truncate rounded-md border border-border/70 bg-muted/25 px-2 py-1.5 text-[11px] font-medium leading-4 text-foreground ${mono ? "font-mono" : ""}`}
        title={displayValue}
      >
        {displayValue}
      </div>
    </div>
  );
}

export default function GcodeFileSheet({
  open,
  isDesktop,
  width,
  selectedEntry = null,
  onOpenChange,
  onStartResize,
  gcodeData = null,
  maxLayer = 0,
  showTravel = false,
  renderTubes = false,
  onMaxLayerChange,
  onShowTravelChange,
  onRenderTubesChange,
  fileDownloadAvailable = false,
  viewerServerInfo = null,
  localFileOpenAvailable = false,
  fileAccessBusyKey = "",
  onOpenFileAsset,
  suppressDynamicMetadataStatus = false,
  statusItems = [],
  themeSections = null,
  openSectionIds = [],
  onOpenSectionIdsChange
}) {
  const layers = Array.isArray(gcodeData?.layers) ? gcodeData.layers : [];
  const stats = gcodeData?.stats || {};
  const layerCount = layers.length;
  const safeMaxLayer = layerCount > 0
    ? Math.min(Math.max(Math.trunc(Number(maxLayer) || 0), 0), layerCount - 1)
    : 0;
  const hasGcodeData = Boolean(gcodeData);
  const visibleLayers = visibleLayerText(layerCount, safeMaxLayer);

  return (
    <FileSheet
      open={open}
      title="G-code"
      isDesktop={isDesktop}
      width={width}
      onOpenChange={onOpenChange}
      onStartResize={onStartResize}
    >
      <Accordion
        type="multiple"
        value={openSectionIds}
        onValueChange={onOpenSectionIdsChange}
        className="text-sm"
      >
        <FileStatusSection items={statusItems} />

        <FileSheetSection value="toolpath" title="Toolpath">
            <div>
              {!hasGcodeData ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">Loading G-code...</p>
              ) : null}

              <FileSheetSubsection title="Summary" contentClassName="px-3">
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="secondary" className="font-normal">
                    {formatCount(layerCount)} layer{layerCount === 1 ? "" : "s"}
                  </Badge>
                  {Number.isFinite(Number(stats.extrusionMoves)) ? (
                    <Badge variant="outline" className="font-normal">
                      {formatCount(stats.extrusionMoves)} path{formatCount(stats.extrusionMoves) === "1" ? "" : "s"}
                    </Badge>
                  ) : null}
                </div>
              </FileSheetSubsection>

              <FileSheetSubsection title="Layers">
                <FileSheetSliderField
                  label="Visible layers"
                  value={visibleLayers}
                  onValueCommit={(nextValue) => {
                    onMaxLayerChange?.(parseVisibleLayerInput(nextValue, safeMaxLayer + 1, layerCount));
                  }}
                  valueInputProps={{
                    disabled: layerCount <= 1,
                    ariaLabel: "Visible G-code layers value",
                    inputMode: "numeric"
                  }}
                >
                <Slider
                  value={[safeMaxLayer]}
                  min={0}
                  max={Math.max(layerCount - 1, 0)}
                  step={1}
                  disabled={layerCount <= 1}
                  onValueChange={(nextValue) => {
                    onMaxLayerChange?.(Number(nextValue?.[0] ?? 0));
                  }}
                  className={FILE_SHEET_PRECISION_SLIDER_CLASSES}
                  aria-label="Visible G-code layers"
                />
                </FileSheetSliderField>
              </FileSheetSubsection>

              <FileSheetSubsection title="Rendering">
                <FileSheetToggleRow
                  label="Travel moves"
                  description="Show non-extrusion travel paths."
                  checked={showTravel}
                  onCheckedChange={(checked) => onShowTravelChange?.(checked)}
                  ariaLabel="Show G-code travel moves"
                />

                <FileSheetToggleRow
                  label="Tube rendering"
                  description="Draw extrusions as 3D tubes (slower)."
                  checked={renderTubes}
                  onCheckedChange={(checked) => onRenderTubesChange?.(checked)}
                  ariaLabel="Render G-code extrusions as tubes"
                />
              </FileSheetSubsection>
            </div>
        </FileSheetSection>

        <FileSheetSection value="bounds" title="Bounds">
            <div className="grid grid-cols-1 gap-2 px-3 py-3">
              <GcodeValueField label="X" value={boundsAxisText(gcodeData?.bounds, 0, 1)} mono />
              <GcodeValueField label="Y" value={boundsAxisText(gcodeData?.bounds, 1, 1)} mono />
              <GcodeValueField label="Z" value={boundsAxisText(gcodeData?.bounds, 2, 2)} mono />
            </div>
        </FileSheetSection>

      </Accordion>
    </FileSheet>
  );
}
