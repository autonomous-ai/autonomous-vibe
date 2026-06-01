import { RENDER_FORMAT } from "cadjs/lib/fileFormats.js";

const BUILDABLE_STEP_ARTIFACT_ERROR_CODES = new Set([
  "missing_glb",
  "missing_step_topology",
  "missing_edge_topology",
  "missing_surface_edge_attributes",
  "missing_selector_topology",
  "missing_source_path",
  "missing_source_identity",
  "stale_source_identity",
  "unsupported_step_topology"
]);

function stepEntryIsPythonBacked(entry) {
  const artifactSourceKind = String(entry?.artifact?.sourceKind || "").trim().toLowerCase();
  if (artifactSourceKind === "python") {
    return true;
  }
  const sourceKind = String(entry?.sourceKind || entry?.stepSourceKind || "").trim().toLowerCase();
  if (sourceKind === "python") {
    return true;
  }
  const sourcePath = String(entry?.source?.sourcePath || entry?.source?.file || "").trim().toLowerCase();
  return sourcePath.endsWith(".py");
}

export function stepArtifactIsStale(entry, sourceFormat) {
  return (
    sourceFormat === RENDER_FORMAT.STEP &&
    entry?.artifact?.ok === false &&
    (
      entry.artifact.stale === true ||
      String(entry.artifact.error || "") === "stale_source_identity"
    )
  );
}

export function stepArtifactCanGenerate(entry, sourceFormat, { generationAvailable = true } = {}) {
  if (!generationAvailable || sourceFormat !== RENDER_FORMAT.STEP) {
    return false;
  }
  if (stepEntryIsPythonBacked(entry)) {
    return false;
  }
  if (entry?.artifact?.ok) {
    return false;
  }
  return BUILDABLE_STEP_ARTIFACT_ERROR_CODES.has(String(entry?.artifact?.error || ""));
}

export function stepArtifactNeedsWarning(entry, sourceFormat, options = {}) {
  return (
    sourceFormat === RENDER_FORMAT.STEP &&
    entry?.artifact?.ok === false &&
    !stepArtifactCanGenerate(entry, sourceFormat, options)
  );
}
