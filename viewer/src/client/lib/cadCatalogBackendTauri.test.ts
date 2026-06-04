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

// An assembly's integrated `.stl` carries `artifact.parts`; the adapter turns
// each into a render-ready child entry on `entry.parts` (with a `__partOf`
// marker + synthesized hash) without adding them as standalone catalog entries.
test("readCatalog attaches assembly parts to the integrated stl entry", async () => {
  const restore = __setTransportForTesting({
    catalog_read: async () => ({
      revision: 3,
      rootPath: "/p",
      entries: [
        {
          file: "robot.stl",
          kind: "stl",
          url: "pandaasset://localhost/robot.stl",
          artifact: {
            parts: [
              { name: "chassis", file: "robot_parts/chassis.stl", url: "pandaasset://localhost/robot_parts/chassis.stl?v=1" },
              { name: "dome", file: "robot_parts/dome.stl", url: "pandaasset://localhost/robot_parts/dome.stl?v=1" },
            ],
          },
        },
      ],
    }),
  });
  try {
    const catalog = await tauriCadCatalogBackend.readCatalog();
    // No standalone part entries leaked into the flat list.
    assert.equal(catalog.entries.length, 1);
    const stl = catalog.entries[0];
    assert.equal(stl.parts.length, 2);
    const chassis = stl.parts[0];
    assert.equal(chassis.file, "robot_parts/chassis.stl");
    assert.equal(chassis.kind, "stl");
    assert.equal(chassis.__partOf, "robot.stl");
    assert.equal(chassis.hash, "pandaasset://localhost/robot_parts/chassis.stl?v=1#3");
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
