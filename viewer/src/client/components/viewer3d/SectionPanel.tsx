import { FlipHorizontal2, RotateCcw, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/ui/utils";
import { useCrossSectionStore } from "./crossSection.store";
import type { SectionAxis } from "./section";

const AXES: { id: SectionAxis; label: string }[] = [
  { id: "x", label: "X" },
  { id: "y", label: "Y" },
  { id: "z", label: "Z" },
  { id: "custom", label: "Custom" },
];

/** Floating control panel for the cross-section tool. Reads and writes the global
 *  cross-section store directly, so any change updates the live GPU clip through
 *  <SectionRig>. Mounted by ViewerTools only while the tool is enabled. */
export function SectionPanel({ style }: { style?: React.CSSProperties }) {
  const axis = useCrossSectionStore((s) => s.axis);
  const position = useCrossSectionStore((s) => s.position);
  const rotation = useCrossSectionStore((s) => s.rotation);
  const showHiddenHalf = useCrossSectionStore((s) => s.showHiddenHalf);
  const hiddenOpacity = useCrossSectionStore((s) => s.hiddenOpacity);
  const highlightCut = useCrossSectionStore((s) => s.highlightCut);

  const setEnabled = useCrossSectionStore((s) => s.setEnabled);
  const setAxis = useCrossSectionStore((s) => s.setAxis);
  const setPosition = useCrossSectionStore((s) => s.setPosition);
  const setRotation = useCrossSectionStore((s) => s.setRotation);
  const toggleFlip = useCrossSectionStore((s) => s.toggleFlip);
  const setShowHiddenHalf = useCrossSectionStore((s) => s.setShowHiddenHalf);
  const setHiddenOpacity = useCrossSectionStore((s) => s.setHiddenOpacity);
  const setHighlightCut = useCrossSectionStore((s) => s.setHighlightCut);
  const reset = useCrossSectionStore((s) => s.reset);

  const setRot = (i: number, deg: number) => {
    const next: [number, number, number] = [...rotation];
    next[i] = (deg * Math.PI) / 180;
    setRotation(next);
  };

  return (
    <div
      className="cad-glass-popover pointer-events-auto absolute z-30 w-64 rounded-md border border-sidebar-border p-4 shadow-md"
      style={style}
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-semibold text-foreground">Cross Section</span>
        <button
          type="button"
          onClick={() => setEnabled(false)}
          aria-label="Close cross section"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <X className="size-4" strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <Field label="Plane">
        <div className="flex gap-1 rounded-md bg-secondary p-1">
          {AXES.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setAxis(a.id)}
              className={cn(
                "flex-1 rounded-sm px-2 py-1.5 text-xs font-semibold transition-colors",
                axis === a.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {a.label}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Position">
        <Slider min={-1} max={1} step={0.005} value={position} onChange={setPosition} />
      </Field>

      {axis === "custom" ? (
        <Field label="Rotation">
          <div className="flex flex-col gap-2">
            {(["X", "Y", "Z"] as const).map((label, i) => (
              <div key={label} className="flex items-center gap-2">
                <span className="w-3 text-[11px] text-muted-foreground">{label}</span>
                <Slider
                  min={-180}
                  max={180}
                  step={1}
                  value={((rotation[i] ?? 0) * 180) / Math.PI}
                  onChange={(deg) => setRot(i, deg)}
                />
              </div>
            ))}
          </div>
        </Field>
      ) : null}

      <div className="mb-3 flex gap-2">
        <button
          type="button"
          onClick={toggleFlip}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-secondary py-2 text-xs font-medium text-foreground transition-colors hover:bg-border"
        >
          <FlipHorizontal2 className="size-4" strokeWidth={2} aria-hidden="true" />
          Flip
        </button>
        <button
          type="button"
          onClick={reset}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-secondary py-2 text-xs font-medium text-foreground transition-colors hover:bg-border"
        >
          <RotateCcw className="size-4" strokeWidth={2} aria-hidden="true" />
          Reset
        </button>
      </div>

      <div className="my-3 h-px bg-border" />

      <Toggle label="Highlight cut surface" checked={highlightCut} onChange={setHighlightCut} />
      <Toggle label="Show hidden half" checked={showHiddenHalf} onChange={setShowHiddenHalf} />
      {showHiddenHalf ? (
        <Field label="Transparency">
          <Slider min={0.05} max={0.8} step={0.05} value={hiddenOpacity} onChange={setHiddenOpacity} />
        </Field>
      ) : null}
    </div>
  );
}

/** Labeled control row. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-3">
      <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

/** Native range input themed to the brand accent. */
function Slider({
  min,
  max,
  step,
  value,
  onChange,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
    />
  );
}

/** Label + switch row. */
function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="mb-2 flex w-full items-center justify-between"
      aria-pressed={checked}
    >
      <span className="text-sm text-muted-foreground">{label}</span>
      <span
        className={cn(
          "flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors",
          checked ? "bg-primary" : "bg-secondary",
        )}
      >
        <span
          className={cn(
            "size-4 rounded-full bg-white transition-transform",
            checked ? "translate-x-4" : "translate-x-0",
          )}
        />
      </span>
    </button>
  );
}
