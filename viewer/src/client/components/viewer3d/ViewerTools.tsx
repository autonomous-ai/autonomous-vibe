import { Boxes, Crosshair, Move3D, PencilRuler, RefreshCw, Ruler, Scissors, Waves } from "lucide-react";
import { type MutableRefObject, useEffect } from "react";
import { cn } from "@/ui/utils";
import { AppearanceMenu } from "./AppearanceMenu";
import { ExplodePanel } from "./ExplodePanel";
import { MeasurePanel } from "./MeasurePanel";
import { SectionPanel } from "./SectionPanel";
import { useAppearanceStore } from "./appearance.store";
import { useCrossSectionStore } from "./crossSection.store";
import { useExplodeStore } from "./explode.store";
import { useMeasureStore } from "./measure.store";

const OVERLAY_BTN =
  "flex size-9 items-center justify-center rounded-md cad-glass-surface border border-sidebar-border text-sidebar-foreground shadow-sm transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";
const OVERLAY_BTN_ACTIVE =
  "border-primary/30 bg-primary/85 text-primary-foreground hover:bg-primary/75 hover:text-primary-foreground";

function inset(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

interface ViewerToolsProps {
  /** Imperative reset published by ModelCanvas; re-frames to the default view. */
  resetRef: MutableRefObject<(() => void) | null>;
  /** Bounding cage + dimensions overlay toggle. */
  showBed: boolean;
  onToggleBed: () => void;
  viewportFrameInsets?: { left?: number; right?: number; top?: number; bottom?: number };
}

/** Bottom-right overlay control cluster for the 3D viewer — appearance (material /
 *  x-ray / wireframe / part colors / feature edges / bloom), exploded-view, cross-section
 *  slice, point-to-point measure, reflective floor, camera-control switch, print-bed
 *  dimensions toggle, and reset view. Drives the appearance / cross-section / explode /
 *  measure stores that <ModelCanvas> reads. Ported from the panda-website model viewer. */
export function ViewerTools({ resetRef, showBed, onToggleBed, viewportFrameInsets }: ViewerToolsProps) {
  const controls = useAppearanceStore((s) => s.controls);
  const setControls = useAppearanceStore((s) => s.setControls);
  const reflectiveFloor = useAppearanceStore((s) => s.reflectiveFloor);
  const setReflectiveFloor = useAppearanceStore((s) => s.setReflectiveFloor);

  const sectionEnabled = useCrossSectionStore((s) => s.enabled);
  const setSectionEnabled = useCrossSectionStore((s) => s.setEnabled);
  const explodeEnabled = useExplodeStore((s) => s.enabled);
  const setExplodeEnabled = useExplodeStore((s) => s.setEnabled);
  const measureEnabled = useMeasureStore((s) => s.enabled);
  const setMeasureEnabled = useMeasureStore((s) => s.setEnabled);

  // Leave every inspection tool off when the viewer unmounts so nothing carries into the
  // next model (these stores are global singletons).
  useEffect(
    () => () => {
      setSectionEnabled(false);
      setExplodeEnabled(false);
      setMeasureEnabled(false);
    },
    [setSectionEnabled, setExplodeEnabled, setMeasureEnabled],
  );

  // Explode is mutually exclusive with section + measure (its CPU displacement fights their
  // world-space picks/clip); section and measure may coexist. Mirrors the website viewer.
  const toggleSection = () => {
    const next = !sectionEnabled;
    setSectionEnabled(next);
    if (next) setExplodeEnabled(false);
  };
  const toggleMeasure = () => {
    const next = !measureEnabled;
    setMeasureEnabled(next);
    if (next) setExplodeEnabled(false);
  };
  const toggleExplode = () => {
    const next = !explodeEnabled;
    setExplodeEnabled(next);
    if (next) {
      setSectionEnabled(false);
      setMeasureEnabled(false);
    }
  };

  const clusterStyle = {
    right: `${inset(viewportFrameInsets?.right) + 16}px`,
    bottom: `${inset(viewportFrameInsets?.bottom) + 16}px`,
  };
  const panelStyle = {
    left: `${inset(viewportFrameInsets?.left) + 16}px`,
    top: `${inset(viewportFrameInsets?.top) + 16}px`,
  };
  const measurePanelStyle = {
    top: `${inset(viewportFrameInsets?.top) + 16}px`,
  };

  return (
    <>
      <div className="pointer-events-auto absolute z-20 flex items-center gap-2" style={clusterStyle}>
        <AppearanceMenu />

        <button
          type="button"
          onClick={toggleExplode}
          aria-label={explodeEnabled ? "Disable exploded view" : "Enable exploded view"}
          aria-pressed={explodeEnabled}
          className={cn(OVERLAY_BTN, explodeEnabled && OVERLAY_BTN_ACTIVE)}
        >
          <Boxes className="size-4" strokeWidth={2} aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={toggleSection}
          aria-label={sectionEnabled ? "Disable cross section" : "Enable cross section"}
          aria-pressed={sectionEnabled}
          className={cn(OVERLAY_BTN, sectionEnabled && OVERLAY_BTN_ACTIVE)}
        >
          <Scissors className="size-4" strokeWidth={2} aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={toggleMeasure}
          aria-label={measureEnabled ? "Disable measure tool" : "Enable measure tool"}
          aria-pressed={measureEnabled}
          className={cn(OVERLAY_BTN, measureEnabled && OVERLAY_BTN_ACTIVE)}
        >
          <PencilRuler className="size-4" strokeWidth={2} aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={() => setReflectiveFloor(!reflectiveFloor)}
          aria-label={reflectiveFloor ? "Disable reflective floor" : "Enable reflective floor"}
          aria-pressed={reflectiveFloor}
          className={cn(OVERLAY_BTN, reflectiveFloor && OVERLAY_BTN_ACTIVE)}
        >
          <Waves className="size-4" strokeWidth={2} aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={() => setControls(controls === "orbit" ? "trackball" : "orbit")}
          aria-label={
            controls === "orbit" ? "Switch to trackball controls" : "Switch to orbit controls"
          }
          className={OVERLAY_BTN}
        >
          {controls === "orbit" ? (
            <RefreshCw className="size-4" strokeWidth={2} aria-hidden="true" />
          ) : (
            <Move3D className="size-4" strokeWidth={2} aria-hidden="true" />
          )}
        </button>

        <button
          type="button"
          onClick={onToggleBed}
          aria-label={showBed ? "Hide print bed and dimensions" : "Show print bed and dimensions"}
          aria-pressed={showBed}
          className={cn(OVERLAY_BTN, showBed && OVERLAY_BTN_ACTIVE)}
        >
          <Ruler className="size-4" strokeWidth={2} aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={() => resetRef.current?.()}
          aria-label="Reset view"
          className={OVERLAY_BTN}
        >
          <Crosshair className="size-4" strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      {explodeEnabled ? <ExplodePanel style={panelStyle} /> : null}
      {sectionEnabled ? <SectionPanel style={panelStyle} /> : null}
      {measureEnabled ? <MeasurePanel style={measurePanelStyle} /> : null}
    </>
  );
}
