import { type LucideIcon, MoveHorizontal, Ruler, Triangle, X } from "lucide-react";
import type { MeasurePick } from "./measure.store";
import { useMeasureStore } from "./measure.store";

// Result math ported from Online3DViewer's CalculateMarkerValues
// (MIT © 2023 Viktor Kovacs, source/website/measuretool.js).
// https://github.com/kovacsv/Online3DViewer

type Vec = [number, number, number];

/** Radians→degrees, matching O3DV's RadDeg constant. */
const RAD_DEG = 57.29577951308232;
/** O3DV's BigEps — the tolerance (radians) for treating two faces as parallel. */
const BIG_EPS = 0.0001;

/** Length in raw model units, no unit label — 3 decimals, matching Online3DViewer. */
function formatLength(n: number): string {
  return n.toFixed(3);
}

/** Angle with a degree symbol — 1 decimal, matching Online3DViewer. */
function formatAngle(n: number): string {
  return `${n.toFixed(1)}°`;
}

function sub(a: Vec, b: Vec): Vec {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a: Vec, b: Vec): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function length(a: Vec): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** Point-to-point distance (O3DV pointsDistance). */
function distance(a: Vec, b: Vec): number {
  return length(sub(a, b));
}

/** Angle (radians, 0…π) between two face normals — O3DV's `aNormal.angleTo(bNormal)`.
 *  Null when either normal is missing (a face-less geometry). */
function faceAngleRad(n1: Vec, n2: Vec): number | null {
  const m1 = length(n1);
  const m2 = length(n2);
  if (m1 === 0 || m2 === 0) return null;
  const cos = dot(n1, n2) / (m1 * m2);
  return Math.acos(Math.min(1, Math.max(-1, cos)));
}

/** Perpendicular gap between two faces, but only when they're parallel/opposite
 *  (angle ≈ 0 or π within BigEps) — O3DV's parallelFacesDistance. Distance from the
 *  second point to the plane through the first point with the first face's normal. */
function parallelDistance(a: MeasurePick, b: MeasurePick): number | null {
  const angle = faceAngleRad(a.normal, b.normal);
  if (angle === null) return null;
  const isParallel = Math.abs(angle) < BIG_EPS || Math.abs(angle - Math.PI) < BIG_EPS;
  if (!isParallel) return null;
  const m = length(a.normal);
  if (m === 0) return null;
  const unit: Vec = [a.normal[0] / m, a.normal[1] / m, a.normal[2] / m];
  return Math.abs(dot(unit, sub(b.position, a.position)));
}

/**
 * Floating readout for the measure tool, ported from Online3DViewer's UpdatePanel.
 * Reads the global measure store directly (single instance, mirrors SectionPanel), so
 * it stays in sync with the in-canvas <MeasureLayer>. Mounted by ViewerTools only while
 * the tool is enabled. Pinned top-center like O3DV's panel.
 *
 * With two picks it lists, in order: distance of points; distance of parallel faces
 * (only when the faces are parallel); and the angle between the faces.
 */
export function MeasurePanel({ style }: { style?: React.CSSProperties }) {
  const picks = useMeasureStore((s) => s.picks);
  const setEnabled = useMeasureStore((s) => s.setEnabled);

  const [a, b] = picks;
  const pointsDistance = a && b ? distance(a.position, b.position) : null;
  const parallel = a && b ? parallelDistance(a, b) : null;
  const angleRad = a && b ? faceAngleRad(a.normal, b.normal) : null;
  const facesAngle = angleRad === null ? null : angleRad * RAD_DEG;

  return (
    <div
      className="cad-glass-popover pointer-events-auto absolute left-1/2 z-30 flex -translate-x-1/2 items-center gap-4 rounded-md border border-sidebar-border px-4 py-2.5 shadow-md"
      style={style}
    >
      {a && b ? (
        <div className="flex items-center gap-4">
          {pointsDistance !== null && (
            <Row icon={Ruler} value={formatLength(pointsDistance)} label="Distance of points" />
          )}
          {parallel !== null && (
            <Row
              icon={MoveHorizontal}
              value={formatLength(parallel)}
              label="Distance of parallel faces"
            />
          )}
          {facesAngle !== null && (
            <Row icon={Triangle} value={formatAngle(facesAngle)} label="Angle of faces" />
          )}
        </div>
      ) : (
        <span className="text-sm text-muted-foreground">
          {picks.length === 0 ? "Select a point." : "Select another point."}
        </span>
      )}

      <button
        type="button"
        onClick={() => setEnabled(false)}
        aria-label="Close measure tool"
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <X className="size-4" strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}

/** Compact icon + value result row (O3DV's AddValue — icon with a title, then value). */
function Row({ icon: RowIcon, value, label }: { icon: LucideIcon; value: string; label: string }) {
  return (
    <div className="flex items-center gap-2" title={label}>
      <RowIcon className="size-4 text-muted-foreground" strokeWidth={2} aria-hidden="true" />
      <span className="text-sm font-semibold tabular-nums text-primary">{value}</span>
    </div>
  );
}
