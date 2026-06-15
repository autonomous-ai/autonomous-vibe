// Human-friendly labels for the activity stream so users can follow what
// the model is doing without reading raw tool names. Pure functions — unit
// tested without React.

// Human duration: whole seconds under a minute, "Nm Ns" above. Floors so a
// fresh turn reads "0s" rather than rounding up mid-first-second.
export function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

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

/**
 * Roll a turn's tool-activity statuses into one summary status for the Activity
 * disclosure header glyph. A live step outranks everything (the group still
 * reads as working); otherwise a failure outranks a cancellation, which
 * outranks all-clear. Empty/missing → "ok" (nothing to flag).
 *
 * @param {{status?: string}[]|undefined} activity
 * @returns {"running"|"error"|"cancelled"|"ok"}
 */
export function aggregateActivityStatus(activity) {
  const list = Array.isArray(activity) ? activity : [];
  let seenError = false;
  let seenCancelled = false;
  for (const block of list) {
    if (block?.status === "running") return "running";
    if (block?.status === "error") seenError = true;
    else if (block?.status === "cancelled") seenCancelled = true;
  }
  if (seenError) return "error";
  if (seenCancelled) return "cancelled";
  return "ok";
}

/**
 * Whether a segment's Activity disclosure should default to open: the active
 * (live) group expands so progress is watchable, and any finished group with a
 * failed tool expands so the error is never hidden behind a collapsed summary.
 * A cancelled tool is not an error and collapses like a clean group.
 *
 * @param {{status?: string}[]|undefined} activity this segment's tool blocks
 * @param {boolean} active whether this is the turn's live/active group
 * @returns {boolean}
 */
export function activityDefaultsOpen(activity, active) {
  if (active) return true;
  return (Array.isArray(activity) ? activity : []).some((b) => b?.status === "error");
}
