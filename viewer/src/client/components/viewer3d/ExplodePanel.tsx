import { Check, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/ui/utils";
import type { ExplodeAxis, ExplodeStyle } from "./explode";
import { useExplodeStore } from "./explode.store";

const STYLES: { id: ExplodeStyle; label: string; desc: string }[] = [
  { id: "hierarchical", label: "Grouped", desc: "Separate by sub-assembly" },
  { id: "radial", label: "Radial", desc: "Push out from the center" },
  { id: "axis", label: "Axis", desc: "Stack along one direction" },
  { id: "peel", label: "Peel", desc: "Outer parts leave first" },
  { id: "layout", label: "Layout", desc: "Lay parts out on a grid" },
];

const AXES: { id: ExplodeAxis; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "x", label: "X" },
  { id: "y", label: "Y" },
  { id: "z", label: "Z" },
];

/** Floating control panel for the exploded-view tool. Reads and writes the global explode store
 *  directly (single instance, mirrors the SectionPanel pattern), so any change updates the live
 *  offsets through <ExplodeRig>. Mounted by ViewerTools only while the tool is enabled. */
export function ExplodePanel({ style }: { style?: React.CSSProperties }) {
  const factor = useExplodeStore((s) => s.factor);
  const explodeStyle = useExplodeStore((s) => s.style);
  const axis = useExplodeStore((s) => s.axis);
  const leafCount = useExplodeStore((s) => s.leafCount);

  const setEnabled = useExplodeStore((s) => s.setEnabled);
  const setFactor = useExplodeStore((s) => s.setFactor);
  const setStyle = useExplodeStore((s) => s.setStyle);
  const setAxis = useExplodeStore((s) => s.setAxis);

  const singlePart = leafCount === 1; // 0 = not measured yet; 1 = one shell, nothing to explode

  return (
    <div
      className="cad-glass-popover pointer-events-auto absolute z-30 w-64 rounded-md border border-sidebar-border p-4 shadow-md"
      style={style}
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-semibold text-foreground">Exploded View</span>
        <button
          type="button"
          onClick={() => setEnabled(false)}
          aria-label="Close exploded view"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <X className="size-4" strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      {singlePart ? (
        <p className="text-xs text-muted-foreground">
          This model is a single part — there's nothing to separate.
        </p>
      ) : (
        <>
          {/* Arrangement style — compact single-line rows; the description shows as a title
              tooltip so the cryptic names (Peel / Layout) stay discoverable without the extra line. */}
          <Field label="Arrangement">
            <div className="flex flex-col gap-1">
              {STYLES.map((s) => {
                const active = explodeStyle === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setStyle(s.id)}
                    aria-pressed={active}
                    title={s.desc}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-sm px-2.5 py-1 text-left text-xs font-semibold leading-tight transition-colors",
                      active
                        ? "bg-primary text-primary-foreground"
                        : "bg-secondary text-foreground hover:bg-border",
                    )}
                  >
                    <span className="truncate">{s.label}</span>
                    {active ? (
                      <Check className="size-3 shrink-0" strokeWidth={2.5} aria-hidden="true" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </Field>

          {/* Stack axis — only meaningful for the axis style. */}
          {explodeStyle === "axis" ? (
            <Field label="Stack axis">
              <div className="flex gap-1 rounded-sm bg-secondary p-1">
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
          ) : null}

          {/* Amount */}
          <Field label="Amount" hint={`${Math.round(factor * 100)}%`}>
            <Slider min={0} max={1} step={0.01} value={factor} onChange={setFactor} />
          </Field>
        </>
      )}
    </div>
  );
}

/** Labeled control row, with an optional right-aligned value readout. */
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="mb-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          {label}
        </span>
        {hint ? (
          <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </div>
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
