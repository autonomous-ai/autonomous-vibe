// Pure helpers for the library pane. Kept JSX-free and dependency-free so
// they can be tested under Node's --test runner without a DOM.

/**
 * Sort a project list newest-first by updatedAt. Stable: ties are broken by
 * name (case-insensitive) so the UI doesn't flip on equal timestamps.
 */
export function sortProjects(projects) {
  const list = Array.isArray(projects) ? projects.slice() : [];
  list.sort((a, b) => {
    const updatedDelta = Number(b?.updatedAt ?? 0) - Number(a?.updatedAt ?? 0);
    if (updatedDelta !== 0) {
      return updatedDelta;
    }
    const nameA = String(a?.name ?? "").toLowerCase();
    const nameB = String(b?.name ?? "").toLowerCase();
    return nameA.localeCompare(nameB);
  });
  return list;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Human-friendly relative date for a project row ("Today", "Yesterday",
 * "3 days ago", "May 14"). Stays deterministic when callers pass a fixed
 * `now` value, so tests can pin the output.
 */
export function formatRelativeDate(timestamp, now = Date.now()) {
  const t = Number(timestamp);
  if (!Number.isFinite(t) || t <= 0) {
    return "—";
  }
  const diffDays = Math.floor((Number(now) - t) / DAY_MS);
  if (diffDays <= 0) {
    return "Today";
  }
  if (diffDays === 1) {
    return "Yesterday";
  }
  if (diffDays < 7) {
    return `${diffDays} days ago`;
  }
  const date = new Date(t);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Build the row payload that ProjectList renders. Returns a list of items
 * plus an `empty` flag the UI uses to switch to its zero-state card.
 */
export function buildProjectListItems(projects, currentProjectId, now = Date.now()) {
  const sorted = sortProjects(projects);
  const items = sorted.map((project) => ({
    id: project.id,
    name: project.name || "Untitled project",
    relativeUpdatedAt: formatRelativeDate(project.updatedAt, now),
    hasModel: Boolean(project.hasModel),
    selected: project.id === currentProjectId,
  }));
  return {
    items,
    empty: items.length === 0,
  };
}

/**
 * Submit a candidate name through the store action. Lets tests verify that
 * project_create is invoked with the trimmed name without mounting the
 * React tree.
 */
export async function submitNewProjectName(name, store, existingNames = []) {
  const reason = validateNewProjectName(name, existingNames);
  if (reason) {
    throw new Error(reason);
  }
  return store.create(name.trim());
}

/**
 * Validation rule for the New Project dialog. Returns "" when the candidate
 * passes, otherwise a human-readable reason.
 */
export function validateNewProjectName(name, existingNames = []) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) {
    return "Name is required";
  }
  if (trimmed.length > 64) {
    return "Name must be 64 characters or fewer";
  }
  const lowered = trimmed.toLowerCase();
  const clashes = Array.isArray(existingNames)
    ? existingNames.some((existing) => String(existing ?? "").trim().toLowerCase() === lowered)
    : false;
  if (clashes) {
    return "A project with that name already exists";
  }
  return "";
}
