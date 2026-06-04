// Classifies a catalog entry as a printable model/part a consumer cares about
// (a thing they'd put on the plate), versus an intermediate or developer-facing
// file (G-code, DXF, robot descriptors). Used to scope the workspace's left
// "Models" rail / home / breadcrumb to printable parts only.
//
// Reuses the existing kind classification in entryIconKind so the filter stays
// in lockstep with the icons the UI already shows.

import { entrySourceFormat } from "cadjs/lib/fileFormats.js";
import { ENTRY_ICON_KIND, entryIconKind } from "./entryIconKind.js";

// Raw STEP/STP (entryIconKind's STEP_PART) is deliberately excluded: a consumer
// picks parts/models, not files, and every generated part already surfaces as its
// printable mesh (stl/glb/3mf) or — for multi-solid models — an assembly. The .step
// is the archival B-rep; surfacing it both duplicates the part in the rail and drives
// the STEP-tree viewer path. Multi-solid models still appear via ENTRY_ICON_KIND.ASSEMBLY.
const PRINTABLE_MODEL_KINDS = new Set([
  ENTRY_ICON_KIND.ASSEMBLY,
  ENTRY_ICON_KIND.STL_MESH,
  ENTRY_ICON_KIND.THREE_MF_MESH,
  ENTRY_ICON_KIND.GLB_MESH,
]);

// Non-model catalog kinds that `entryIconKind` would otherwise bucket into
// STEP_PART (its fallback), which made source/metadata/preview files show up
// as bogus "<file>.step" models in the rail. Exclude them explicitly so the
// Models rail only lists actual models (step/stl/glb/assembly/3mf).
const NON_MODEL_KINDS = new Set(["py", "json", "png", "txt", "md", "csv"]);

export function isPrintableModelEntry(entry) {
  if (!entry) {
    return false;
  }
  // Per-part STLs are shown nested under their integrated model's "Parts"
  // section, never as standalone top-level models.
  if (entry.__partOf) {
    return false;
  }
  const rawKind = String(entry.kind || "").toLowerCase();
  if (NON_MODEL_KINDS.has(rawKind)) {
    return false;
  }
  const kind = entryIconKind(entry, { sourceFormat: entrySourceFormat(entry) });
  return PRINTABLE_MODEL_KINDS.has(kind);
}
