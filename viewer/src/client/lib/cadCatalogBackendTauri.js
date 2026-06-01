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
// without it, no STL/GLB ever renders. Synthesize one from the asset URL +
// catalog revision: stable within a revision and cache-busting when
// artifacts change (the revision bumps on `artifact_changed`). Scoped to
// directly-renderable mesh kinds so STEP entries stay "no mesh" instead of
// trying to load a `.step` as a GLB (Panda doesn't emit a STEP→GLB sidecar
// in cadjs's shape yet). The bytes are served by the pandaasset:// scheme.
const RENDERABLE_MESH_KINDS = new Set(["stl", "glb"]);

function withRenderableMeshHashes(catalog) {
  if (!catalog || !Array.isArray(catalog.entries)) {
    return catalog;
  }
  const revision = catalog.revision ?? 0;
  const entries = catalog.entries.map((entry) => {
    if (!entry || entry.hash || !RENDERABLE_MESH_KINDS.has(entry.kind)) {
      return entry;
    }
    const url = String(entry.url || "");
    return url ? { ...entry, hash: `${url}#${revision}` } : entry;
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
