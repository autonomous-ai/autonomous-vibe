import assert from "node:assert/strict";
import test from "node:test";

import {
  FILE_STATUS_LEVELS,
  buildFileStatusItems,
  fileStatusHasWarningsOrErrors,
  formatFileStatusItemForAgent,
  gcodeFileStatusItems,
  mostIntenseFileStatusLevel,
  sdfFileStatusItems,
  stepFileStatusItems,
  viewerAlertFileStatusItem
} from "./fileStatusItems.js";

const viewerServerInfo = {
  workspaceRoot: "/workspace/text-to-cad",
  rootDir: "models",
  rootPath: "/workspace/text-to-cad/models",
};

test("stepFileStatusItems explains stale STEP source status", () => {
  const items = stepFileStatusItems({
    entry: {
      file: "simple/rectangular_clamp_block.step",
      kind: "part"
    },
    stepSourceStatus: {
      file: "models/simple/rectangular_clamp_block.step",
      stepPath: "models/simple/rectangular_clamp_block.step",
      sourceKind: "python",
      sourcePath: "models/simple/rectangular_clamp_block.py",
      step: {
        ok: false,
        status: "stale",
        stale: true,
        artifactHash: "",
        currentHash: "d60a7f19177e9070aecbb302ab5241f56af116c21427f619c61a94dc98623efc",
        message: "STEP file is missing Python source identity metadata."
      }
    },
    viewerServerInfo
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].level, FILE_STATUS_LEVELS.WARNING);
  assert.equal(items[0].title, "STEP file stale");
  assert.equal(items[0].message, "STEP file doesn't match the hash of the Python generator script.");
  assert.deepEqual(items[0].details.map((item) => item.label), [
    "STEP file",
    "Source kind",
    "Python source",
    "STEP source hash",
    "Current source hash"
  ]);
  assert.equal(items[0].details.find((item) => item.label === "STEP file")?.value, "simple/rectangular_clamp_block.step");
  assert.equal(items[0].details.find((item) => item.label === "Python source")?.value, "simple/rectangular_clamp_block.py");
  assert.equal(items[0].details[3].value, "Missing");
});

test("stepFileStatusItems treats missing STEP source files as warnings", () => {
  const items = stepFileStatusItems({
    entry: {
      file: "simple/cylindrical_cap.step",
      kind: "part"
    },
    stepSourceStatus: {
      file: "models/simple/cylindrical_cap.step",
      stepPath: "models/simple/cylindrical_cap.step",
      sourceKind: "python",
      sourcePath: "models/simple/cylindrical_cap.py",
      step: {
        ok: false,
        status: "missing",
        missing: true,
        stale: false,
        message: "STEP file is missing."
      }
    },
    viewerServerInfo
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].level, FILE_STATUS_LEVELS.WARNING);
  assert.equal(items[0].title, "STEP file missing");
  assert.equal(
    items[0].message,
    "STEP file was not generated for this Python script; only a GLB artifact is available."
  );
});

test("stepFileStatusItems explains hard-migrated missing STEP identity", () => {
  const items = stepFileStatusItems({
    entry: {
      file: "simple/generated.step",
      kind: "part"
    },
    stepSourceStatus: {
      file: "models/simple/generated.step",
      stepPath: "models/simple/generated.step",
      sourceKind: "python",
      sourcePath: "models/simple/generated.py",
      step: {
        ok: false,
        status: "missing_identity",
        missing: false,
        stale: false,
        metadataMissing: true,
        currentHash: "fingerprint",
        currentSourceHash: "source-hash",
        message: "STEP file is missing Python source identity metadata."
      }
    }
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].level, FILE_STATUS_LEVELS.WARNING);
  assert.equal(items[0].title, "STEP file identity missing");
  assert.equal(items[0].message, "STEP file is missing Python source identity metadata.");
});

test("stepFileStatusItems marks missing STEP artifacts as errors", () => {
  const items = stepFileStatusItems({
    entry: {
      file: "tom/STEP/robot_arm.step",
      kind: "assembly",
      artifact: {
        ok: false,
        error: "missing_glb",
        stale: false,
        sourceKind: "python",
        stepPath: "models/tom/STEP/robot_arm.step",
        glbPath: "models/tom/STEP/.robot_arm.step.glb",
        artifactHash: "",
        currentHash: "new-hash",
        message: "GLB artifact is missing."
      }
    },
    viewerServerInfo
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].level, FILE_STATUS_LEVELS.ERROR);
  assert.equal(items[0].title, "STEP artifact missing");
  assert.equal(items[0].message, "Generated GLB is missing.");
  assert.equal(items[0].details.find((item) => item.label === "Code")?.value, "missing_glb");
  assert.equal(items[0].details.find((item) => item.label === "GLB artifact")?.value, "tom/STEP/.robot_arm.step.glb");
});

test("stepFileStatusItems reads artifact warnings from current-file status", () => {
  const items = stepFileStatusItems({
    entry: {
      file: "tom/STEP/robot_arm.step",
      kind: "assembly"
    },
    stepSourceStatus: {
      artifact: {
        ok: false,
        error: "missing_glb",
        sourceKind: "step",
        stepPath: "models/tom/STEP/robot_arm.step",
        glbPath: "models/tom/STEP/.robot_arm.step.glb"
      },
      step: {
        ok: true,
        status: "current",
        missing: false,
        stale: false
      }
    },
    viewerServerInfo
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].title, "STEP artifact missing");
  assert.equal(items[0].details.find((item) => item.label === "GLB artifact")?.value, "tom/STEP/.robot_arm.step.glb");
});

test("stepFileStatusItems keeps renderable STEP artifact issues as warnings", () => {
  const renderableArtifactCases = [
    ["stale_source_identity", true, "STEP artifact stale", "Generated GLB doesn't match the hash of the STEP file."],
    ["missing_glb", false, "STEP artifact missing", "Generated GLB is missing."],
    ["missing_step_topology", false, "STEP artifact metadata warning", "Generated GLB is missing STEP topology metadata."],
    ["missing_selector_topology", false, "STEP artifact metadata warning", "Generated GLB is missing selector topology metadata."],
    ["missing_edge_topology", false, "STEP artifact metadata warning", "Generated GLB is missing surface edge topology metadata."],
    ["missing_surface_edge_attributes", false, "STEP artifact metadata warning", "Generated GLB is missing surface edge render attributes."],
    ["unsupported_step_topology", false, "STEP artifact metadata warning", "Generated GLB topology metadata is unsupported."],
    ["missing_source_path", false, "STEP artifact metadata warning", "Generated GLB metadata is missing its source path."],
    ["missing_source_identity", false, "STEP artifact metadata warning", "Generated GLB is missing the hash of the STEP file."]
  ];

  for (const [error, stale, title, message] of renderableArtifactCases) {
    const items = stepFileStatusItems({
      entry: {
        file: "simple/part.step",
        kind: "part",
        url: "/models/simple/.part.step.glb?v=hash",
        hash: "glb-hash",
        artifact: {
          ok: false,
          error,
          stale
        }
      }
    });

    assert.equal(items.length, 1);
    assert.equal(items[0].level, FILE_STATUS_LEVELS.WARNING);
    assert.equal(items[0].title, title);
    assert.equal(items[0].message, message);
  }
});

test("stepFileStatusItems marks non-renderable STEP artifact issues as errors", () => {
  const items = stepFileStatusItems({
    entry: {
      file: "simple/part.step",
      kind: "part",
      artifact: {
        ok: false,
        error: "missing_source_path",
        message: "GLB STEP_topology is missing required sourcePath identity."
      }
    }
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].level, FILE_STATUS_LEVELS.ERROR);
  assert.equal(items[0].title, "STEP artifact unavailable");
  assert.equal(items[0].message, "Generated GLB metadata is missing its source path.");
});

test("stepFileStatusItems trims obsolete regeneration prompts from artifact messages", () => {
  const items = stepFileStatusItems({
    entry: {
      file: "simple/part.step",
      kind: "part",
      artifact: {
        ok: false,
        error: "unsupported_step_topology",
        message: "STEP topology schema is unsupported.\nRegenerate STEP artifacts with legacy instructions:"
      }
    }
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].message, "Generated GLB topology metadata is unsupported.");
});

test("parser warnings normalize to status items", () => {
  assert.deepEqual(gcodeFileStatusItems({ warnings: ["Inch units are not supported."] }).map((item) => ({
    level: item.level,
    source: item.source,
    title: item.title,
    message: item.message
  })), [{
    level: FILE_STATUS_LEVELS.WARNING,
    source: "gcode-parser",
    title: "G-code warning",
    message: "Inch units are not supported."
  }]);

  assert.equal(sdfFileStatusItems({
    staticMetadata: {
      warnings: ["Unsupported geometry was skipped."]
    }
  })[0].title, "SDF warning");
});

test("generated source status explains missing hard-migrated fingerprints", () => {
  const items = buildFileStatusItems({
    entry: {
      file: "robots/robot.urdf",
      kind: "urdf",
      sourceKind: "python",
      sourceStatus: {
        ok: false,
        status: "missing_identity",
        stale: false,
        sourceKind: "python",
        sourcePath: "models/robots/robot_urdf.py",
        message: "Generated file is missing Python sourceFingerprint metadata."
      }
    },
    fileSheetKind: "urdf",
    viewerServerInfo
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].level, FILE_STATUS_LEVELS.WARNING);
  assert.equal(items[0].title, "Generated file identity missing");
  assert.equal(
    items[0].message,
    "This file records a Python generator path, but it is missing sourceFingerprint metadata."
  );
  assert.equal(items[0].details.find((item) => item.label === "Python source")?.value, "robots/robot_urdf.py");
});

test("viewer alerts normalize to status items", () => {
  const item = viewerAlertFileStatusItem({
    severity: "error",
    summary: "Mesh load failed",
    title: "Failed to load render mesh",
    message: "404",
    resolution: "Reload the page.",
    command: "python -m cadpy.step_artifact --repo-root . --step model.step"
  });

  assert.equal(item.level, FILE_STATUS_LEVELS.ERROR);
  assert.equal(item.title, "Failed to load render mesh");
  assert.equal(item.details.find((detail) => detail.label === "Resolution")?.value, "Reload the page.");
  assert.equal(item.details.find((detail) => detail.label === "Command")?.mono, true);
});

test("buildFileStatusItems combines producers and exposes the most intense level", () => {
  const items = buildFileStatusItems({
    entry: {
      file: "simple/part.step",
      kind: "part",
      artifact: {
        ok: false,
        error: "stale_source_identity",
        stale: true,
        message: "GLB was generated from older source."
      }
    },
    fileSheetKind: "step",
    viewerAlert: {
      severity: "error",
      summary: "Mesh load failed",
      title: "Failed to load render mesh",
      message: "404"
    }
  });

  assert.equal(fileStatusHasWarningsOrErrors(items), true);
  assert.equal(mostIntenseFileStatusLevel(items), FILE_STATUS_LEVELS.ERROR);
  assert.deepEqual(items.map((item) => item.level), [
    FILE_STATUS_LEVELS.ERROR,
    FILE_STATUS_LEVELS.ERROR
  ]);
  assert.equal(items[0].message, "Generated GLB doesn't match the hash of the STEP file.");
});

test("formatFileStatusItemForAgent copies status items with details", () => {
  const item = stepFileStatusItems({
    entry: {
      file: "simple/part.step",
      kind: "part",
      artifact: {
        ok: false,
        error: "stale_source_identity",
        stale: true,
        sourceKind: "python",
        stepPath: "models/simple/part.step",
        glbPath: "models/simple/.part.step.glb",
        artifactHash: "old-hash",
        currentHash: "new-hash"
      }
    },
    viewerServerInfo
  })[0];

  assert.equal(formatFileStatusItemForAgent(item), [
    "CAD Viewer issue",
    "Level: Error",
    "Title: STEP artifact stale",
    "Description: Generated GLB doesn't match the hash of the Python generator script.",
    "Source: catalog",
    "Code: stale_source_identity",
    "",
    "Details:",
    "- Code: stale_source_identity",
    "- STEP file: simple/part.step",
    "- GLB artifact: simple/.part.step.glb",
    "- Source kind: python",
    "- Artifact hash: old-hash",
    "- Current hash: new-hash"
  ].join("\n"));
});
