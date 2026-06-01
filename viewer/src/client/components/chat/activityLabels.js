// Human-friendly labels for the activity stream so users can follow what
// the model is doing without reading raw tool names. Pure functions — unit
// tested without React.

function titleize(name) {
  const s = String(name || "").trim();
  if (!s) return "Working";
  return s
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Map a raw tool name (+ its input) to a short human phrase.
 * Falls back to a titleized tool name so nothing is ever hidden.
 *
 * @param {string} tool
 * @param {unknown} [input]
 * @returns {string}
 */
export function toolLabel(tool, input) {
  const name = String(tool || "");
  switch (name) {
    case "cadcode":
    case "Skill":
      return "Designing geometry";
    case "Write":
      return "Writing CAD source";
    case "Edit":
    case "MultiEdit":
      return "Editing CAD source";
    case "Read":
      return "Reading files";
    case "ExitPlanMode":
      return "Finalizing plan";
    case "Bash": {
      const cmd =
        input && typeof input === "object" && "command" in input
          ? String(/** @type {{command?: unknown}} */ (input).command || "")
          : "";
      if (/scripts\/cad|render|preview/.test(cmd)) return "Rendering preview";
      return "Running command";
    }
    default:
      return titleize(name);
  }
}

/**
 * Badge label for a turn's workflow phase.
 * @param {"plan"|"implement"|string|undefined} phase
 * @returns {string}
 */
export function phaseLabel(phase) {
  if (phase === "plan") return "Planning";
  if (phase === "implement") return "Building";
  return "";
}
