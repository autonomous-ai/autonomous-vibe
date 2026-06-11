export const DRAWING_TOOL = Object.freeze({
  FREEHAND: "freehand",
  LINE: "line",
  SURFACE_LINE: "surface-line",
  ARROW: "arrow",
  DOUBLE_ARROW: "double-arrow",
  RECTANGLE: "rectangle",
  CIRCLE: "circle",
  FILL: "fill",
  ERASE: "erase"
});

// The closed-shape tools the "Send to AI" flow treats as labelled *regions*:
// each gets a numbered badge baked into the screenshot and can carry a note.
// Open annotations (freehand, line, arrow) stay un-numbered scribbles.
const REGION_TOOLS = Object.freeze([DRAWING_TOOL.CIRCLE, DRAWING_TOOL.RECTANGLE]);

export function isRegionStroke(stroke) {
  return REGION_TOOLS.includes(stroke?.tool);
}

/** The region strokes in draw order — index+1 is the badge number. */
export function regionStrokes(strokes) {
  return (Array.isArray(strokes) ? strokes : []).filter(isRegionStroke);
}
