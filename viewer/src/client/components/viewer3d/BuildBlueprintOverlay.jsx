import { useMemo } from "react";

import { useChatStore } from "@/store/chat";
import { findActiveTurn, buildManifestFromTurn } from "./buildManifest.js";

// Live build stage — the pre-artifact phase. While the model is still writing
// CAD source (no geometry on disk yet) the viewport would otherwise be a dead
// grid. This overlay turns that wait into a draftsman's blueprint: the model's
// own task roadmap (or, as a fallback, the source files it writes) is drawn as a
// stack of schematic blocks that ink in as each step is worked. When the first
// real model lands the overlay fades out as the 3D wireframe→solid materialize
// fades in — draft → sketch → solid, one continuous arc.

const BLUEPRINT_COLOR = "#5b9dff";
// Color at a given alpha — inline styles (not Tailwind opacity modifiers, which
// can't be generated for a CSS-var color and would silently drop).
const bp = (alpha) => `rgba(91, 157, 255, ${alpha})`;
// Rect geometry for the per-step "draw-in": perimeter drives stroke-dashoffset.
const RECT_W = 30;
const RECT_H = 22;
const RECT_PERIMETER = 2 * (RECT_W + RECT_H);

function StepRect({ status }) {
  const inked = status === "active" || status === "done";
  return (
    <svg
      width={RECT_W + 4}
      height={RECT_H + 4}
      viewBox={`-2 -2 ${RECT_W + 4} ${RECT_H + 4}`}
      className="shrink-0"
      aria-hidden="true"
      style={status === "active" ? { filter: `drop-shadow(0 0 4px ${BLUEPRINT_COLOR})` } : undefined}
    >
      {/* Ghost placeholder — always present so the full roadmap reads as faint
          dashed outlines from the first frame (the website-skeleton feel). */}
      <rect
        x={0}
        y={0}
        width={RECT_W}
        height={RECT_H}
        rx={2}
        fill="none"
        stroke={bp(0.22)}
        strokeWidth={1}
        strokeDasharray="3 3"
      />
      {/* Inked outline — draws itself in when the step becomes active. */}
      <rect
        x={0}
        y={0}
        width={RECT_W}
        height={RECT_H}
        rx={2}
        fill={status === "done" ? bp(0.1) : "none"}
        stroke={bp(inked ? 0.95 : 0)}
        strokeWidth={1.25}
        strokeDasharray={RECT_PERIMETER}
        strokeDashoffset={inked ? 0 : RECT_PERIMETER}
        style={{ transition: "stroke-dashoffset 700ms ease, stroke 300ms ease" }}
      />
      {status === "done" ? (
        <path
          d={`M ${RECT_W * 0.32} ${RECT_H * 0.52} L ${RECT_W * 0.45} ${RECT_H * 0.66} L ${RECT_W * 0.68} ${RECT_H * 0.36}`}
          fill="none"
          stroke={BLUEPRINT_COLOR}
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
    </svg>
  );
}

// A single line of text that slides up + fades in whenever its value changes,
// inside a fixed-height, clipped box so a short→long change can never reflow the
// layout. Keyed by value so React remounts (re-runs the animation) on change;
// `truncate` keeps it to one line with an ellipsis.
function SlideText({ value }) {
  return (
    <span
      aria-hidden="true"
      className="relative block flex-1 overflow-hidden"
      style={{ height: "1.4em" }}
    >
      <span
        key={value}
        className="absolute inset-0 truncate"
        style={{ animation: "bp-slide-up 360ms cubic-bezier(0.22, 1, 0.36, 1)" }}
      >
        {value}
      </span>
    </span>
  );
}

function StepRow({ step, index }) {
  const { status, label } = step;
  const labelAlpha = status === "done" ? 0.8 : status === "active" ? 1 : 0.4;
  return (
    <li
      className="flex items-center gap-3 pl-1"
      style={{
        animation: "bp-slide-up 360ms cubic-bezier(0.22, 1, 0.36, 1) both",
        animationDelay: `${index * 45}ms`,
      }}
    >
      <StepRect status={status} />
      <span className="font-mono text-[13px] leading-tight" style={{ color: bp(labelAlpha) }}>
        {label}
      </span>
      {status === "active" ? (
        <span className="font-mono text-[11px] animate-pulse" style={{ color: bp(0.7) }}>
          drafting…
        </span>
      ) : null}
    </li>
  );
}

/**
 * @param {{ visible: boolean, title?: string }} props
 *   visible — true while the viewport is empty mid-build (drives the crossfade);
 *             the parent keeps this mounted briefly after it flips false so the
 *             fade-out overlaps the 3D materialize fade-in.
 */
export default function BuildBlueprintOverlay({ visible, title }) {
  const history = useChatStore((state) => state.history);
  const manifest = useMemo(() => buildManifestFromTurn(findActiveTurn(history)), [history]);
  const { steps, currentStep } = manifest;

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
      style={{ opacity: visible ? 1 : 0, transition: "opacity 450ms ease" }}
    >
      <style>{
        "@keyframes bp-slide-up { from { transform: translateY(55%); opacity: 0; } to { transform: translateY(0); opacity: 1; } }"
      }</style>
      {/* Soft vignette for legibility; the real viewport grid shows through as
          the blueprint "paper". */}
      <div
        className="absolute inset-0"
        style={{ background: "radial-gradient(ellipse at center, rgba(0,0,0,0) 40%, rgba(0,0,0,0.35) 100%)" }}
      />
      <div className="absolute inset-0 flex items-center justify-center px-6">
        <div role="status" aria-live="polite" className="w-[min(86vw,30rem)]">
          <div className="mb-4 flex items-baseline gap-2 font-mono">
            <span className="text-[13px] tracking-[0.25em]" style={{ color: BLUEPRINT_COLOR }}>
              ▦ DRAFTING
            </span>
            {title ? (
              <span className="truncate text-[12px]" style={{ color: bp(0.6) }}>· {title}</span>
            ) : null}
          </div>

          <div className="mb-5 flex items-center gap-2 font-mono text-[13px]" style={{ color: bp(0.85) }}>
            <span aria-hidden="true" className="shrink-0 animate-pulse">▸</span>
            <span className="sr-only">{currentStep}</span>
            <SlideText value={currentStep} />
          </div>

          {steps.length > 0 ? (
            <ul className="flex flex-col gap-3">
              {steps.map((step, i) => (
                <StepRow key={step.id} step={step} index={i} />
              ))}
            </ul>
          ) : (
            <p className="font-mono text-[12px]" style={{ color: bp(0.45) }}>
              Laying out the design…
            </p>
          )}

          <div
            className="mt-6 pt-2 text-right font-mono text-[10px] tracking-[0.2em]"
            style={{ color: bp(0.35), borderTop: `1px solid ${bp(0.15)}` }}
          >
            VIBE CAD
          </div>
        </div>
      </div>
    </div>
  );
}
