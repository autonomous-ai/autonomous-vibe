// Preflight checklist items + the "all checked" predicate. Extracted into a
// plain JS module so node:test can import them without parsing the JSX
// component.

export const PREFLIGHT_ITEMS = Object.freeze([
  { id: "plate", label: "Build plate is clear and clean" },
  { id: "filament", label: "Filament is loaded and matches the slice profile" },
  { id: "nozzle", label: "Nozzle is clean; no plastic stuck to the tip" },
  { id: "surroundings", label: "Surroundings are clear (lid closed if applicable)" },
  { id: "operator", label: "An operator is nearby for the first layer" },
]);

export function preflightAllChecked(checked) {
  if (!checked || typeof checked !== "object") return false;
  return PREFLIGHT_ITEMS.every((item) => checked[item.id] === true);
}
