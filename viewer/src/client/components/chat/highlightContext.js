// Build the short, model-facing note that rides alongside an annotated-view
// screenshot ("Send to AI" from the draw toolbar). The screenshot shows *what*
// was circled (with numbered badges baked in per region); this note tells the
// model *where* each numbered region is and *what the user said about it*, in
// frame-relative terms plus the model's own coordinate system — so it can
// correlate the highlight with the 3D shape and the generating `main.py`.
//
// Pure + unit-tested (no DOM). Stroke points are the drawing overlay's
// normalized [0,1] viewport space with the origin at the top-left.

// Mirrors cadjs `isRegionStroke` (drawingTools.js). Kept as local strings so
// this helper and its test stay free of the cadjs module graph — the viewer
// already duplicates the tool names in workbench/constants.js for the same
// reason. The closed-shape tools are the ones that get a numbered badge + note.
const REGION_TOOLS = ["circle", "rectangle"];

export function isRegionStroke(stroke) {
  return REGION_TOOLS.includes(stroke?.tool);
}

/**
 * A suggested chat instruction to pre-fill when the user sends a drawing to the
 * AI, phrased around the shape(s) they drew: "Improve the detail inside the
 * circle." Returns "" when nothing is drawn (caller leaves the input empty).
 */
export function buildDrawingSuggestionText(strokes) {
  const all = Array.isArray(strokes) ? strokes : [];
  if (!all.length) return "";
  const regions = all.filter(isRegionStroke);
  let target;
  if (regions.length === 1) {
    target = regions[0].tool === "rectangle" ? "the rectangle" : "the circle";
  } else if (regions.length > 1) {
    target = regions.every((s) => s.tool === "rectangle")
      ? "the rectangles"
      : regions.every((s) => s.tool === "circle")
        ? "the circles"
        : "the highlighted areas";
  } else {
    // Only freehand/line/arrow marks — no closed region to name.
    target = "the highlighted area";
  }
  return `Improve ${target}.`;
}

/**
 * Axis-aligned bounding box over every point of every stroke, in normalized
 * [0,1] viewport space, plus the centroid. Returns null when there are no
 * finite points to bound.
 */
export function strokesBoundingBox(strokes) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let points = 0;
  for (const stroke of Array.isArray(strokes) ? strokes : []) {
    for (const point of Array.isArray(stroke?.points) ? stroke.points : []) {
      const x = Number(point?.x);
      const y = Number(point?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      points += 1;
    }
  }
  if (!points) return null;
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

/**
 * Coarse 3x3 position label for a normalized centroid ("top-left", "center",
 * "bottom-right", …). The dead-center cell collapses to plain "center".
 */
export function regionLabel(cx, cy) {
  const col = cx < 1 / 3 ? "left" : cx > 2 / 3 ? "right" : "center";
  const row = cy < 1 / 3 ? "top" : cy > 2 / 3 ? "bottom" : "middle";
  if (row === "middle" && col === "center") return "center";
  if (row === "middle") return col;
  if (col === "center") return row;
  return `${row}-${col}`;
}

// Representative point of a region in normalized space: a circle's stored
// center, else the bbox centroid (rectangles, fallbacks).
function regionCenter(stroke) {
  const points = Array.isArray(stroke?.points) ? stroke.points : [];
  if (stroke?.tool === "circle" && points.length) {
    const x = Number(points[0]?.x);
    const y = Number(points[0]?.y);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  }
  const box = strokesBoundingBox([stroke]);
  return box ? { x: box.cx, y: box.cy } : null;
}

function formatVector(vector) {
  if (!Array.isArray(vector) || vector.length < 3) return "";
  return `[${vector.slice(0, 3).map((n) => Number(n).toFixed(1)).join(", ")}]`;
}

function formatRegion(stroke, index) {
  const center = regionCenter(stroke);
  const where = center ? regionLabel(center.x, center.y) : "frame";
  const shape = stroke?.tool === "rectangle" ? "rectangle" : "circle";
  const note = String(stroke?.note || "").trim();
  const head = `region ${index + 1} (${shape}, ${where})`;
  return note ? `${head}: "${note}"` : head;
}

/**
 * Compose the bracketed context note. Returns "" when there's nothing useful to
 * say (no strokes and no camera), so callers can guard cheaply.
 *
 * @param {{strokes?: any[], perspective?: {position?: number[], target?: number[]}}} input
 * @returns {string}
 */
export function buildHighlightContextNote({ strokes, perspective } = {}) {
  const all = Array.isArray(strokes) ? strokes : [];
  const regions = all.filter(isRegionStroke);
  const lines = [];

  if (regions.length) {
    const detail = regions.map(formatRegion).join("; ");
    lines.push(
      `${regions.length} highlighted region${regions.length === 1 ? "" : "s"} on the attached view — ` +
        `${detail}. Numbered badges in the image mark each region (frame origin top-left).`,
    );
  } else {
    // No closed regions — freehand/arrow scribbles get a single bbox summary.
    const box = strokesBoundingBox(all);
    if (box) {
      const pct = (n) => Math.round(n * 100);
      lines.push(
        `Highlighted area on the attached view, around the ${regionLabel(box.cx, box.cy)} of the frame ` +
          `(normalized bounds x ${pct(box.minX)}–${pct(box.maxX)}%, ` +
          `y ${pct(box.minY)}–${pct(box.maxY)}%, origin top-left).`,
      );
    }
  }

  const eye = formatVector(perspective?.position);
  const target = formatVector(perspective?.target);
  if (eye && target) {
    lines.push(`Camera eye ${eye} looking at ${target} (model units).`);
  }
  if (!lines.length) return "";
  return `[Highlighted-view context: ${lines.join(" ")}]`;
}
