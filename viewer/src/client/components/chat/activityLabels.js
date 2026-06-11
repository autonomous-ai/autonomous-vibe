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
      return "Designing";
    case "Write":
      return "Writing CAD source";
    case "Edit":
    case "MultiEdit":
      return "Editing CAD source";
    case "Read":
      return "Reading files";
    case "Grep":
      return "Searching code";
    case "Glob":
      return "Finding files";
    case "WebSearch":
      return "Searching the web";
    case "WebFetch":
      return "Reading a page";
    case "Task":
    case "Agent":
      return "Running a subtask";
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
 * The specific target a tool acted on — the search pattern, the file, the
 * command, the query — so a trace row reads "Searching code · «pattern»"
 * instead of a bare verb. Returns "" when there's nothing meaningful to show.
 * Full string (no truncation); callers truncate for display.
 *
 * @param {string} tool
 * @param {unknown} [input]
 * @returns {string}
 */
export function toolDetail(tool, input) {
  const obj = input && typeof input === "object" ? /** @type {Record<string, unknown>} */ (input) : {};
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const basename = (p) => {
    const s = str(p);
    const parts = s.split(/[\\/]/);
    return parts[parts.length - 1] || s;
  };
  switch (String(tool || "")) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return basename(obj.file_path);
    case "Grep":
    case "Glob":
      return str(obj.pattern);
    case "Bash":
      return str(obj.command);
    case "WebSearch":
      return str(obj.query);
    case "WebFetch":
      return str(obj.url);
    case "Task":
    case "Agent":
      return str(obj.description);
    case "cadcode":
    case "Skill":
      return str(obj.command) || str(obj.skill) || str(obj.name);
    default: {
      // Generic: surface the first non-empty string field so a new tool is
      // never reduced to a bare verb.
      for (const value of Object.values(obj)) {
        const s = str(value);
        if (s) return s;
      }
      return "";
    }
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
