import test from "node:test";
import assert from "node:assert/strict";

import { __setTransportForTesting } from "./transport.ts";
import { tauriCadCatalogBackend } from "./cadCatalogBackendTauri.js";

// The Rust catalog omits per-asset hashes, which cadjs's entryHasMesh
// requires before a mesh renders. The adapter synthesizes one (url +
// revision) for the directly-renderable `.stl` mesh. STEP entries must stay
// untouched (their sibling `.stl` is the preview, not the `.step` itself).
test("readCatalog adds a hash to stl entries but not step", async () => {
  const restore = __setTransportForTesting({
    catalog_read: async () => ({
      revision: 7,
      rootPath: "/p",
      entries: [
        { file: "m.stl", kind: "stl", url: "pandaasset://localhost/m.stl" },
        { file: "m.step", kind: "step", url: "pandaasset://localhost/m.step" },
        { file: "m.py", kind: "py", url: "pandaasset://localhost/m.py" },
      ],
    }),
  });
  try {
    const catalog = await tauriCadCatalogBackend.readCatalog();
    const byKind = Object.fromEntries(catalog.entries.map((e) => [e.kind, e]));
    assert.equal(byKind.stl.hash, "pandaasset://localhost/m.stl#7");
    assert.equal(byKind.step.hash, undefined);
    assert.equal(byKind.py.hash, undefined);
  } finally {
    restore();
  }
});

test("readCatalog leaves an existing hash and empty entries alone", async () => {
  const restore = __setTransportForTesting({
    catalog_read: async () => ({
      revision: 2,
      rootPath: "/p",
      entries: [
        { file: "m.stl", kind: "stl", url: "pandaasset://localhost/m.stl", hash: "real" },
        { file: "n.stl", kind: "stl", url: "" },
      ],
    }),
  });
  try {
    const catalog = await tauriCadCatalogBackend.readCatalog();
    assert.equal(catalog.entries[0].hash, "real");
    assert.equal(catalog.entries[1].hash, undefined);
  } finally {
    restore();
  }
});
