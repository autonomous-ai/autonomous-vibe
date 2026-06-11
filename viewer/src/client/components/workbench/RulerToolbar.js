import { Box, Circle, Copy, Eye, EyeOff, Layers, MousePointerClick, Ruler, Spline, Triangle, Trash2, X } from "lucide-react";
import { cn } from "@/ui/utils";
import { ScrollArea } from "../ui/scroll-area";
import { TooltipProvider } from "../ui/tooltip";
import { RULER_TOOL, RULER_UNIT } from "../../workbench/constants";
import { formatAngle, formatLength } from "cadjs/lib/viewer/rulerGeometry";
import ToolbarShell from "./ToolbarShell";
import { ToolbarButton, ToolbarTextButton } from "./ToolbarButton";

const TOOL_ICON = {
  [RULER_TOOL.FEATURES]: MousePointerClick,
  [RULER_TOOL.DISTANCE]: Ruler,
  [RULER_TOOL.ANGLE]: Triangle,
  [RULER_TOOL.DIAMETER]: Circle,
  [RULER_TOOL.WALL_THICKNESS]: Layers,
  [RULER_TOOL.BOUNDING_BOX]: Box
};

const UNIT_OPTIONS = [
  { id: RULER_UNIT.MM, label: "mm" },
  { id: RULER_UNIT.CM, label: "cm" },
  { id: RULER_UNIT.INCH, label: "in" }
];

// Spline icon is a stand-in for the angle tool when an explicit angle glyph is
// not available — exported alias keeps lint happy if the icon set changes.
const FALLBACK_ANGLE_ICON = Spline;

function describeMeasurement(measurement, unit) {
  const components = Array.isArray(measurement?.components) ? measurement.components : [];
  switch (measurement?.tool) {
    case RULER_TOOL.ANGLE:
      return { title: formatAngle(measurement.value), detail: "Angle" };
    case RULER_TOOL.DIAMETER:
      return {
        title: `Ø ${formatLength(measurement.value, unit)}`,
        detail: `r ${formatLength(components[0] || measurement.value / 2, unit)}`
      };
    case RULER_TOOL.WALL_THICKNESS:
      return { title: formatLength(measurement.value, unit), detail: "Wall thickness" };
    case RULER_TOOL.BOUNDING_BOX:
      return {
        title: `${formatLength(components[0] || 0, unit)} × ${formatLength(components[1] || 0, unit)} × ${formatLength(components[2] || 0, unit)}`,
        detail: "Bounding box"
      };
    default:
      return {
        title: formatLength(measurement?.value || 0, unit),
        detail: `ΔX ${formatLength(components[0] || 0, unit)}  ΔY ${formatLength(components[1] || 0, unit)}  ΔZ ${formatLength(components[2] || 0, unit)}`
      };
  }
}

export default function RulerToolbar({
  className,
  rulerToolOptions,
  rulerTool,
  rulerUnit,
  rulerMeasurements = [],
  rulerVisible = true,
  isStepView = false,
  handleSelectRulerTool,
  handleSelectRulerUnit,
  handleToggleRulerVisible,
  handleClearRulerMeasurements,
  handleRemoveRulerMeasurement,
  handleCopyRulerMeasurement
}) {
  const measurements = Array.isArray(rulerMeasurements) ? rulerMeasurements : [];
  const VisibilityIcon = rulerVisible ? Eye : EyeOff;

  return (
    <ToolbarShell className={cn("flex flex-col gap-1.5 p-1.5", className)}>
      <TooltipProvider delayDuration={250}>
        <div className="flex flex-wrap items-center gap-1">
          {rulerToolOptions.map(({ id, label, stepOnly }) => {
            const Icon = TOOL_ICON[id] || FALLBACK_ANGLE_ICON;
            const active = rulerTool === id;
            const disabled = !!stepOnly && !isStepView;
            return (
              <ToolbarButton
                key={id}
                label={disabled ? `${label} (STEP models only)` : label}
                active={active}
                aria-pressed={active}
                disabled={disabled}
                onClick={() => handleSelectRulerTool(id)}
              >
                <Icon className="size-3.5" strokeWidth={2} aria-hidden="true" />
              </ToolbarButton>
            );
          })}

          <span className="mx-0.5 h-5 w-px bg-[var(--ui-border)]/60" aria-hidden="true" />

          <ToolbarButton
            label={rulerVisible ? "Hide measurements" : "Show measurements"}
            active={!rulerVisible}
            onClick={handleToggleRulerVisible}
          >
            <VisibilityIcon className="size-3.5" strokeWidth={2} aria-hidden="true" />
          </ToolbarButton>

          <ToolbarButton
            label="Clear all"
            onClick={handleClearRulerMeasurements}
            disabled={!measurements.length}
          >
            <Trash2 className="size-3.5" strokeWidth={2} aria-hidden="true" />
          </ToolbarButton>
        </div>

        <div className="flex items-center gap-1">
          {UNIT_OPTIONS.map(({ id, label }) => (
            <ToolbarTextButton
              key={id}
              label={`Show measurements in ${label}`}
              active={rulerUnit === id}
              aria-pressed={rulerUnit === id}
              className="min-h-7 flex-1 px-2 py-0.5"
              onClick={() => handleSelectRulerUnit(id)}
            >
              {label}
            </ToolbarTextButton>
          ))}
        </div>

        {measurements.length ? (
          <ScrollArea className="max-h-44 w-full" type="auto" scrollbars="vertical">
            <ul className="flex flex-col gap-1 pr-1">
              {measurements.map((measurement) => {
                const Icon = TOOL_ICON[measurement.tool] || Ruler;
                const { title, detail } = describeMeasurement(measurement, rulerUnit);
                return (
                  <li
                    key={measurement.id}
                    className="flex items-center gap-2 rounded-md bg-[var(--ui-panel-muted)] px-2 py-1"
                  >
                    <Icon className="size-3.5 shrink-0 text-[var(--ui-text-muted)]" strokeWidth={2} aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-semibold tabular-nums text-[var(--ui-text)]">{title}</div>
                      <div className="truncate text-[10px] tabular-nums text-[var(--ui-text-muted)]">{detail}</div>
                    </div>
                    <ToolbarButton
                      label="Copy value"
                      tooltipSide="left"
                      onClick={() => handleCopyRulerMeasurement(measurement)}
                    >
                      <Copy className="size-3.5" strokeWidth={2} aria-hidden="true" />
                    </ToolbarButton>
                    <ToolbarButton
                      label="Remove"
                      tooltipSide="left"
                      onClick={() => handleRemoveRulerMeasurement(measurement.id)}
                    >
                      <X className="size-3.5" strokeWidth={2} aria-hidden="true" />
                    </ToolbarButton>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        ) : (
          <p className="px-1 py-0.5 text-[10px] leading-snug text-[var(--ui-text-muted)]">
            {rulerTool === RULER_TOOL.FEATURES
              ? "Hover a face or edge; click two to measure, double-click for length / Ø."
              : "Click the model to measure. Distance and angle take 2–3 points."}
          </p>
        )}
      </TooltipProvider>
    </ToolbarShell>
  );
}
