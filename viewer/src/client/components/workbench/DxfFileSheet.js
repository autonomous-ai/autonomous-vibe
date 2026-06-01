import { useEffect, useState } from "react";
import { Minus, Plus } from "lucide-react";
import {
  DXF_BEND_DIRECTION,
  normalizeDxfBendAngleDeg,
  normalizeDxfBendDirection,
  normalizeDxfPreviewThicknessMm
} from "cadjs/lib/dxf/buildPreviewMesh";
import {
  Accordion
} from "../ui/accordion";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import FileSheet, {
  FILE_SHEET_COMPACT_ICON_BUTTON_CLASSES,
  FILE_SHEET_COMPACT_NUMERIC_INPUT_CLASSES,
  FILE_SHEET_SEGMENTED_ITEM_CLASSES,
  FileSheetControlRow,
  FileSheetSection,
  FileSheetSectionBody
} from "./FileSheet";
import FileStatusSection from "./FileStatusSection";

const compactInputClasses = FILE_SHEET_COMPACT_NUMERIC_INPUT_CLASSES;
const compactIconButtonClasses = FILE_SHEET_COMPACT_ICON_BUTTON_CLASSES;

function formatThicknessInput(valueMm) {
  const numericValue = Number(valueMm);
  if (!Number.isFinite(numericValue)) {
    return "";
  }
  return numericValue.toFixed(4).replace(/\.?0+$/, "");
}

function formatAngleInput(valueDeg) {
  const rounded = Math.round(Number(valueDeg) * 10) / 10;
  return Number.isFinite(rounded) ? String(rounded) : "";
}

function DxfBendRow({
  index,
  setting,
  onChange
}) {
  const [draftAngle, setDraftAngle] = useState(() => formatAngleInput(setting?.angleDeg));

  useEffect(() => {
    setDraftAngle(formatAngleInput(setting?.angleDeg));
  }, [setting?.angleDeg]);

  const commitAngle = (nextValue) => {
    const normalizedAngle = normalizeDxfBendAngleDeg(nextValue, setting?.angleDeg);
    onChange(index, { angleDeg: normalizedAngle });
    setDraftAngle(formatAngleInput(normalizedAngle));
  };

  const direction = normalizeDxfBendDirection(setting?.direction);

  return (
    <FileSheetControlRow label={`B${index + 1}`}>
      <div className="grid grid-cols-[minmax(0,1fr)_5.75rem] gap-2">
        <div className="min-w-0">
          <span className="sr-only">Direction</span>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={direction}
            onValueChange={(nextDirection) => {
              if (!nextDirection) {
                return;
              }
              onChange(index, { direction: nextDirection });
            }}
            className="grid h-7 w-full min-w-0 grid-cols-2"
            aria-label={`Bend ${index + 1} direction`}
          >
            <ToggleGroupItem
              value={DXF_BEND_DIRECTION.UP}
              className={`!h-7 text-[11px] ${FILE_SHEET_SEGMENTED_ITEM_CLASSES}`}
            >
              Up
            </ToggleGroupItem>
            <ToggleGroupItem
              value={DXF_BEND_DIRECTION.DOWN}
              className={`!h-7 text-[11px] ${FILE_SHEET_SEGMENTED_ITEM_CLASSES}`}
            >
              Down
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <label className="block">
          <span className="sr-only">Angle</span>
          <div className="relative">
            <Input
              type="number"
              min="0"
              max="180"
              step="1"
              inputMode="decimal"
              value={draftAngle}
              onChange={(event) => {
                setDraftAngle(event.target.value);
              }}
              onFocus={(event) => {
                event.currentTarget.select();
              }}
              onMouseUp={(event) => {
                event.preventDefault();
              }}
              onBlur={() => {
                commitAngle(draftAngle);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
              className={`${compactInputClasses} w-full pr-9 text-right`}
              aria-label={`Bend ${index + 1} angle in degrees`}
            />
            <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted-foreground">deg</span>
          </div>
        </label>
      </div>
    </FileSheetControlRow>
  );
}

export default function DxfFileSheet({
  open,
  isDesktop,
  width,
  selectedEntry = null,
  onOpenChange,
  valueMm,
  bendSettings,
  hasDxfData,
  viewerLoading,
  onStartResize,
  onThicknessChange,
  onBendChange,
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
  const [draftValue, setDraftValue] = useState(() => formatThicknessInput(valueMm));
  const normalizedBendSettings = Array.isArray(bendSettings) ? bendSettings : [];

  useEffect(() => {
    setDraftValue(formatThicknessInput(valueMm));
  }, [valueMm]);

  const commitValue = (nextValue) => {
    const normalizedValue = normalizeDxfPreviewThicknessMm(nextValue, valueMm);
    onThicknessChange(normalizedValue);
    setDraftValue(formatThicknessInput(normalizedValue));
  };

  return (
    <FileSheet
      open={open}
      title="DXF"
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

        <FileSheetSection value="plate" title="Plate">
          <FileSheetSectionBody>
            <FileSheetControlRow label="Thickness">
              <div className="grid grid-cols-[2rem_minmax(0,1fr)_2rem] items-center gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={compactIconButtonClasses}
                  onClick={() => {
                    commitValue(valueMm - 0.25);
                  }}
                  disabled={!hasDxfData}
                  aria-label="Reduce DXF material thickness"
                  title="Reduce thickness"
                >
                  <Minus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                </Button>
                <div className="relative block">
                  <Input
                    type="number"
                    min="0.2"
                    max="25"
                    step="any"
                    inputMode="decimal"
                    value={draftValue}
                    disabled={!hasDxfData}
                    onChange={(event) => {
                      setDraftValue(event.target.value);
                    }}
                    onBlur={() => {
                      commitValue(draftValue);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.currentTarget.blur();
                      }
                    }}
                    className={`${compactInputClasses} w-full pr-9 text-right`}
                    aria-label="DXF material thickness in millimeters"
                  />
                  <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted-foreground">mm</span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={compactIconButtonClasses}
                  onClick={() => {
                    commitValue(valueMm + 0.25);
                  }}
                  disabled={!hasDxfData}
                  aria-label="Increase DXF material thickness"
                  title="Increase thickness"
                >
                  <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                </Button>
              </div>
            </FileSheetControlRow>
          </FileSheetSectionBody>
        </FileSheetSection>

        <FileSheetSection value="bends" title="Bends">
          <FileSheetSectionBody>
            {normalizedBendSettings.length ? normalizedBendSettings.map((setting, index) => (
              <DxfBendRow
                key={setting.id || `bend-${index + 1}`}
                index={index}
                setting={setting}
                onChange={onBendChange}
              />
            )) : (
              <p className="px-3 py-1 text-xs text-muted-foreground">
                {viewerLoading ? "Loading bends..." : "No bends are available."}
              </p>
            )}
          </FileSheetSectionBody>
        </FileSheetSection>
      </Accordion>
    </FileSheet>
  );
}
