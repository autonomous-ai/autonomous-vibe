// Panda's Tauri IPC backend for cadManifestStore.
//
// cadjs is backend-agnostic by design — its source of truth lives at
// packages/cadjs/src/lib/cadManifestStore.js and has no awareness of
// Tauri. This adapter routes each catalog operation through the Tauri
// IPC transport, then is injected into cadjs via setCadCatalogBackend()
// at viewer startup (see main.jsx).
//
// Shape mapping: the Rust IPC GenerationStatus is
//   { queue, pythonAvailable, lastError? }
// but cadjs's normalizeCadGenerationStatus expects the legacy
//   { runs, files }
// shape (HTTP /__cad/generation-status). We adapt here so the cadjs
// store and its downstream consumers (CadWorkspace etc.) stay unchanged.

import { transport } from "./transport.ts";

// The Rust catalog (Track C, simplified) omits the per-asset `hash` that
// cadjs's `entryHasMesh` requires before it treats a mesh as renderable —
// without it, no STL ever renders. Synthesize one from the asset URL (plus the
// catalog revision as a belt-and-suspenders suffix). The real cache-bust lives
// in the URL: Rust's `scan_workspace` appends a `?v=<mtime>-<size>` token to
// renderable mesh URLs (`commands/catalog.rs`), so a regenerated, same-path
// `.stl` gets a new URL — which busts both cadjs's URL-keyed byte cache
// (`renderAssetClient.js` `stlCache`) and this synthesized hash, so the viewer
// re-renders. Scoped to the directly-renderable `.stl` mesh so STEP entries
// stay "no mesh" (their archival B-rep is not rendered; the sibling `.stl` is
// the preview). The bytes are served by the pandaasset:// scheme.
const RENDERABLE_MESH_KINDS = new Set(["stl"]);

// Turn an assembly's `artifact.parts` (from the `.step.json` sidecar) into
// render-ready `.stl` catalog entries. Each carries `__partOf` (the integrated
// model's file) so it stays out of the flat rail; they are attached to the
// integrated entry as `entry.parts` and shown nested under its "Parts" section.
// The workspace expands these into its `entryMap` so selecting one resolves and
// renders through the normal single-model path.
function synthesizePartEntry(part, parentFile, revision) {
  const url = String(part?.url || "");
  const file = String(part?.file || "");
  if (!url || !file) {
    return null;
  }
  return {
    file,
    kind: "stl",
    sourceKind: "static",
    url,
    hash: `${url}#${revision}`,
    name: String(part?.name || ""),
    __partOf: parentFile,
  };
}

function withRenderableMeshHashes(catalog) {
  if (!catalog || !Array.isArray(catalog.entries)) {
    return catalog;
  }
  const revision = catalog.revision ?? 0;
  const entries = catalog.entries.map((entry) => {
    if (!entry) {
      return entry;
    }
    let next = entry;
    if (!next.hash && RENDERABLE_MESH_KINDS.has(next.kind)) {
      const url = String(next.url || "");
      if (url) {
        next = { ...next, hash: `${url}#${revision}` };
      }
    }
    const parts = next.artifact?.parts;
    if (Array.isArray(parts) && parts.length > 0) {
      const children = parts
        .map((part) => synthesizePartEntry(part, next.file, revision))
        .filter(Boolean);
      if (children.length > 0) {
        next = next === entry ? { ...entry } : next;
        next.parts = children;
      }
    }
    return next;
  });
  return { ...catalog, entries };
}

export const tauriCadCatalogBackend = {
  async readCatalog() {
    return withRenderableMeshHashes(await transport.catalog_read());
  },

  async readGenerationStatus() {
    const ipc = await transport.generation_status_read();
    return {
      schemaVersion: 1,
      runs: Array.isArray(ipc?.queue)
        ? ipc.queue.map((q) => ({
            file: q.file,
            startedAt: q.startedAt,
            kind: q.kind,
          }))
        : [],
      files: {},
    };
  },

  async regenerateStepArtifact(fileRef /*, { signal } = {} */) {
    await transport.step_artifact_regenerate(fileRef, false);
    // IPC returns void; refresh the catalog so the caller's downstream
    // publishCadManifest() pick up the new artifact.
    const catalog = withRenderableMeshHashes(await transport.catalog_read());
    return { catalog };
  },

  async readStepSourceStatus(fileRef /*, { signal } = {} */) {
    return transport.step_source_status_read(fileRef);
  },
};
