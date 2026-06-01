import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { inlineStepGlbArtifactPathForSource } from "../../common/stepSidecars.mjs";
import {
  STEP_EDGE_BARYCENTRIC_ATTRIBUTE,
  STEP_EDGE_CLASS_ATTRIBUTE,
  STEP_EDGE_VISIBILITY_CLASSES,
  STEP_TOPOLOGY_SCHEMA_VERSION
} from "../../common/stepTopology.mjs";
import {
  scanCadDirectory,
  validateStepTopologyArtifact,
} from "../cadDirectoryScanner.mjs";
import { buildMeshDataFromGlbBuffer } from "../render/glbMeshData.js";
import {
  ensureStepArtifactsForCatalog,
  ensureStepTopologyArtifact,
} from "./stepArtifactCompiler.mjs";
import { readTextToCadStepMetadataFile, TEXT_TO_CAD_GENERATOR } from "./stepMetadata.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
function findRepoRoot(startDir) {
  let current = startDir;
  for (;;) {
    if (
      fs.existsSync(path.join(current, "models")) &&
      fs.existsSync(path.join(current, "packages", "cadjs"))
    ) {
      return current;
    }
    const next = path.dirname(current);
    if (next === current) {
      throw new Error(`Unable to find repository root from ${startDir}`);
    }
    current = next;
  }
}

const REPO_ROOT = findRepoRoot(HERE);
const FIXTURE_STEP = path.join(
  REPO_ROOT,
  "models/benchmarks/benchmark_01_rectangular_calibration_block.step",
);
const FIXTURE_COLORED_STEP = path.join(
  REPO_ROOT,
  "models/benchmarks/benchmark_09_spiral_staircase.step",
);
const FIXTURE_CYLINDRICAL_STEP = path.join(
  REPO_ROOT,
  "models/simple/cylindrical_spacer_sleeve.step",
);

function makeTempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cad-viewer-step-compile-"));
}

function copyFixtureStep(repoRoot, relativePath = "models/block.step") {
  const targetPath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(FIXTURE_STEP, targetPath);
  return targetPath;
}

function writePythonBoxGenerator(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, [
    "from build123d import Box",
    "",
    "def gen_step():",
    "    return Box(1, 1, 1)",
    "",
  ].join("\n"));
}

async function waitForFile(filePath, { timeoutMs = 10000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function glbArrayBuffer(filePath) {
  const bytes = fs.readFileSync(filePath);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function readGlbJson(filePath) {
  const bytes = fs.readFileSync(filePath);
  const jsonLength = bytes.readUInt32LE(12);
  return JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8"));
}

function readGlbChunks(filePath) {
  const bytes = fs.readFileSync(filePath);
  const jsonLength = bytes.readUInt32LE(12);
  const jsonStart = 20;
  const jsonEnd = jsonStart + jsonLength;
  const json = JSON.parse(bytes.subarray(jsonStart, jsonEnd).toString("utf8"));
  const binaryHeaderStart = jsonEnd;
  const binaryLength = binaryHeaderStart + 8 <= bytes.length ? bytes.readUInt32LE(binaryHeaderStart) : 0;
  const binaryStart = binaryHeaderStart + 8;
  const binary = bytes.subarray(binaryStart, binaryStart + binaryLength);
  return { json, binary };
}

function readStepTopologySelectorManifest(filePath) {
  const { json, binary } = readGlbChunks(filePath);
  const selectorViewIndex = json.extensions?.STEP_topology?.selectorView;
  assert.equal(Number.isInteger(selectorViewIndex), true);
  const selectorView = json.bufferViews?.[selectorViewIndex];
  assert.equal(Boolean(selectorView), true);
  const start = Number(selectorView.byteOffset || 0);
  const end = start + Number(selectorView.byteLength || 0);
  return JSON.parse(binary.subarray(start, end).toString("utf8"));
}

function readStepTopologyIndexManifest(filePath) {
  const { json, binary } = readGlbChunks(filePath);
  const indexViewIndex = json.extensions?.STEP_topology?.indexView;
  assert.equal(Number.isInteger(indexViewIndex), true);
  const indexView = json.bufferViews?.[indexViewIndex];
  assert.equal(Boolean(indexView), true);
  const start = Number(indexView.byteOffset || 0);
  const end = start + Number(indexView.byteLength || 0);
  return JSON.parse(binary.subarray(start, end).toString("utf8"));
}

function readStepEdgeManifest(filePath) {
  const { json, binary } = readGlbChunks(filePath);
  const edgeViewIndex = json.extensions?.STEP_topology?.edgeView;
  assert.equal(Number.isInteger(edgeViewIndex), true);
  const edgeView = json.bufferViews?.[edgeViewIndex];
  assert.equal(Boolean(edgeView), true);
  const start = Number(edgeView.byteOffset || 0);
  const end = start + Number(edgeView.byteLength || 0);
  return JSON.parse(binary.subarray(start, end).toString("utf8"));
}

function stepEscape(value) {
  return String(value).replace(/'/g, "''");
}

function addTextToCadMetadataToStep(stepPath, entryKind) {
  const text = fs.readFileSync(stepPath, "utf-8");
  const maxId = Math.max(0, ...Array.from(text.matchAll(/#(\d+)\s*=/g), (match) => Number(match[1])));
  const productDefinition = /#(\d+)\s*=\s*PRODUCT_DEFINITION\s*\(/i.exec(text)?.[1];
  const representationContext = /#\d+\s*=\s*(?:ADVANCED_BREP_SHAPE_REPRESENTATION|SHAPE_REPRESENTATION)\s*\(.*?,\s*#(\d+)\s*\)\s*;/is.exec(text)?.[1];
  const dataEndMatches = Array.from(text.matchAll(/ENDSEC\s*;/gi));
  assert.ok(productDefinition, "fixture STEP must have a PRODUCT_DEFINITION");
  assert.ok(representationContext, "fixture STEP must have a representation context");
  assert.ok(dataEndMatches.length, "fixture STEP must have an ENDSEC");
  const properties = [
    ["cadpy:generator", TEXT_TO_CAD_GENERATOR],
    ["cadpy:entryKind", entryKind],
  ];
  let nextId = maxId + 1;
  const entities = [];
  for (const [propertyName, propertyValue] of properties) {
    const itemId = nextId;
    const representationId = nextId + 1;
    const propertyId = nextId + 2;
    const linkId = nextId + 3;
    nextId += 4;
    entities.push(
      `#${itemId}=DESCRIPTIVE_REPRESENTATION_ITEM('${stepEscape(propertyName)}','${stepEscape(propertyValue)}');`,
      `#${representationId}=REPRESENTATION('${stepEscape(propertyName)}',(#${itemId}),#${representationContext});`,
      `#${propertyId}=PROPERTY_DEFINITION('cadpy metadata','${stepEscape(propertyName)}',#${productDefinition});`,
      `#${linkId}=PROPERTY_DEFINITION_REPRESENTATION(#${propertyId},#${representationId});`,
    );
  }
  const insertAt = dataEndMatches.at(-1).index;
  fs.writeFileSync(stepPath, `${text.slice(0, insertAt)}\n${entities.join("\n")}\n${text.slice(insertAt)}`);
}

function occurrenceById(manifest, id) {
  const columns = manifest.tables?.occurrenceColumns || [];
  const idIndex = columns.indexOf("id");
  const row = (manifest.occurrences || []).find((candidate) => candidate[idIndex] === id);
  assert.ok(row, `missing occurrence ${id}`);
  return Object.fromEntries(columns.map((column, index) => [column, row[index]]));
}

function materialColors(gltf) {
  return (gltf.materials || [])
    .map((material) => material?.pbrMetallicRoughness?.baseColorFactor)
    .filter(Array.isArray);
}

function hasApproxColor(colors, expected, epsilon = 0.01) {
  return colors.some((color) => (
    color.length >= expected.length &&
    expected.every((component, index) => Math.abs(Number(color[index]) - component) <= epsilon)
  ));
}

test("ensureStepTopologyArtifact writes a canonical GLB with STEP_topology", async (t) => {
  const repoRoot = makeTempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const stepPath = copyFixtureStep(repoRoot);
  const glbPath = inlineStepGlbArtifactPathForSource(stepPath);

  assert.equal(fs.existsSync(glbPath), false);
  const result = await ensureStepTopologyArtifact({ repoRoot, stepPath });

  assert.equal(result.ok, true);
  assert.equal(result.glbPath, glbPath);
  assert.equal(fs.existsSync(glbPath), true);
  assert.equal(result.validation.ok, true);
  assert.equal(result.validation.glbPath, "models/.block.step.glb");

  const validation = validateStepTopologyArtifact({
    repoRoot,
    sourcePath: stepPath,
    cadPath: "models/block",
  });
  assert.equal(validation.stepArtifact.ok, true);
  assert.equal(validation.stepArtifact.sourcePath, "models/block.step");

  const gltf = readGlbJson(glbPath);
  const topology = readStepTopologySelectorManifest(glbPath);
  const indexTopology = readStepTopologyIndexManifest(glbPath);
  const edgeView = readStepEdgeManifest(glbPath);
  const edgeColumns = topology.tables?.edgeColumns || [];
  const visibilityClassIndex = edgeColumns.indexOf("visibilityClass");
  assert.equal(gltf.extensions?.STEP_topology?.schemaVersion, STEP_TOPOLOGY_SCHEMA_VERSION);
  assert.equal(Number.isInteger(gltf.extensions?.STEP_topology?.edgeView), true);
  for (const mesh of gltf.meshes || []) {
    for (const primitive of mesh.primitives || []) {
      assert.equal(Number.isInteger(primitive.attributes?.[STEP_EDGE_BARYCENTRIC_ATTRIBUTE]), true);
      assert.equal(Number.isInteger(primitive.attributes?.[STEP_EDGE_CLASS_ATTRIBUTE]), true);
    }
  }
  assert.equal(topology.schemaVersion, STEP_TOPOLOGY_SCHEMA_VERSION);
  assert.equal(indexTopology.schemaVersion, STEP_TOPOLOGY_SCHEMA_VERSION);
  assert.equal(edgeView.schemaVersion, STEP_TOPOLOGY_SCHEMA_VERSION);
  assert.equal(topology.sourcePath, "models/block.step");
  assert.equal(indexTopology.sourcePath, "models/block.step");
  assert.equal(edgeView.sourcePath, "models/block.step");
  assert.equal(edgeView.profile, "surface-edges");
  assert.deepEqual(edgeView.primitiveAttributes, {
    barycentric: STEP_EDGE_BARYCENTRIC_ATTRIBUTE,
    class: STEP_EDGE_CLASS_ATTRIBUTE,
  });
  assert.deepEqual(edgeView.halfEdgeColumns, [
    "edgeRow",
    "faceRow",
    "occurrenceRow",
    "primitiveIndex",
    "triangleIndex",
    "side",
    "classCode",
  ]);
  assert.equal(edgeView.halfEdgesView, "surfaceHalfEdges");
  assert.ok(edgeView.buffers?.views?.surfaceHalfEdges);
  assert.equal(edgeView.faces, undefined);
  assert.equal(edgeView.relations, undefined);
  assert.ok(topology.capabilities?.edgeClassification);
  assert.ok(topology.capabilities?.surfaceEdgeRendering);
  assert.ok(indexTopology.capabilities?.edgeClassification);
  assert.ok(edgeColumns.includes("surfaceHalfEdgeStart"));
  assert.ok(edgeColumns.includes("surfaceHalfEdgeCount"));
  assert.ok(edgeColumns.includes("adjacentFaceCount"));
  assert.ok(edgeColumns.includes("continuity"));
  assert.ok(edgeColumns.includes("dihedralDeg"));
  assert.ok(edgeColumns.includes("visibilityClass"));
  assert.ok((topology.edges || []).some((row) => row[visibilityClassIndex] === STEP_EDGE_VISIBILITY_CLASSES.FEATURE));

  const mesh = await buildMeshDataFromGlbBuffer(glbArrayBuffer(glbPath));
  assert.equal(mesh.parts.length, 1);
  assert.ok(mesh.vertices.length > 0);
  assert.ok(mesh.indices.length > 0);
  assert.equal(mesh.surfaceEdgeBarycentric.length, mesh.vertices.length);
  assert.equal(mesh.surfaceEdgeClass.length, mesh.vertices.length);
});

test("ensureStepTopologyArtifact classifies tangent and seam CAD edges", async (t) => {
  const repoRoot = makeTempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const stepPath = path.join(repoRoot, "models/cylindrical_spacer_sleeve.step");
  fs.mkdirSync(path.dirname(stepPath), { recursive: true });
  fs.copyFileSync(FIXTURE_CYLINDRICAL_STEP, stepPath);

  const result = await ensureStepTopologyArtifact({ repoRoot, stepPath });
  const topology = readStepTopologySelectorManifest(result.glbPath);
  const edgeColumns = topology.tables?.edgeColumns || [];
  const visibilityClassIndex = edgeColumns.indexOf("visibilityClass");
  const surfaceHalfEdgeCountIndex = edgeColumns.indexOf("surfaceHalfEdgeCount");
  const visibilityClasses = new Set((topology.edges || []).map((row) => row[visibilityClassIndex]));

  assert.equal(result.ok, true);
  assert.equal(visibilityClasses.has(STEP_EDGE_VISIBILITY_CLASSES.TANGENT), true);
  assert.equal(visibilityClasses.has(STEP_EDGE_VISIBILITY_CLASSES.SEAM), true);
  assert.ok((topology.edges || [])
    .filter((row) => row[visibilityClassIndex] === STEP_EDGE_VISIBILITY_CLASSES.TANGENT)
    .some((row) => Number(row[surfaceHalfEdgeCountIndex]) > 0));
  assert.ok((topology.edges || [])
    .filter((row) => row[visibilityClassIndex] === STEP_EDGE_VISIBILITY_CLASSES.SEAM)
    .some((row) => Number(row[surfaceHalfEdgeCountIndex]) > 0));
});

test("ensureStepTopologyArtifact preserves STEP presentation colors as GLB materials", async (t) => {
  const repoRoot = makeTempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const stepPath = path.join(repoRoot, "models/spiral.step");
  fs.mkdirSync(path.dirname(stepPath), { recursive: true });
  fs.copyFileSync(FIXTURE_COLORED_STEP, stepPath);
  addTextToCadMetadataToStep(stepPath, "assembly");

  const result = await ensureStepTopologyArtifact({ repoRoot, stepPath });
  const gltf = readGlbJson(result.glbPath);
  const colors = materialColors(gltf);
  const topology = readStepTopologySelectorManifest(result.glbPath);
  const indexTopology = readStepTopologyIndexManifest(result.glbPath);
  const firstTreadAssembly = occurrenceById(topology, "o1.3");
  const firstTread = occurrenceById(topology, "o1.3.1");
  const secondTread = occurrenceById(topology, "o1.4.1");
  const lastTread = occurrenceById(topology, "o1.22.1");

  assert.equal(result.ok, true);
  assert.equal(result.entryKind, "assembly");
  assert.ok(colors.length >= 5);
  assert.ok(hasApproxColor(colors, [0.78, 0.58, 0.35, 1]));
  assert.ok(hasApproxColor(colors, [0.22, 0.28, 0.34, 1]));
  assert.ok((gltf.nodes || []).filter((node) => Array.isArray(node.matrix)).length >= 30);
  assert.equal(topology.occurrences?.[0]?.[2], "benchmark_09_spiral_staircase_helical_handrail");
  assert.equal(firstTreadAssembly.sourceName, "helical_tread_01");
  assert.equal(indexTopology.assembly?.root?.children?.[2]?.displayName, "helical_tread_01");
  assert.notDeepEqual(firstTread.bbox, secondTread.bbox);
  assert.ok(Math.abs(firstTread.bbox.min[2] - 4) < 0.001);
  assert.ok(Math.abs(secondTread.bbox.min[2] - 10) < 0.001);
  assert.ok(Math.abs(lastTread.bbox.min[2] - 118) < 0.001);

  const mesh = await buildMeshDataFromGlbBuffer(glbArrayBuffer(result.glbPath));
  const meshParts = new Map(mesh.parts.map((part) => [part.occurrenceId, part]));
  assert.equal(mesh.has_source_colors, true);
  assert.ok(meshParts.get("o1.3.1")?.bounds?.min?.[2] > 3.9);
  assert.ok(meshParts.get("o1.22.1")?.bounds?.min?.[2] > 117.9);
});

test("ensureStepTopologyArtifact respects cadpy STEP entryKind metadata", async (t) => {
  const repoRoot = makeTempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const stepPath = path.join(repoRoot, "models/benchmark_09_spiral_staircase.step");
  fs.mkdirSync(path.dirname(stepPath), { recursive: true });
  fs.copyFileSync(FIXTURE_COLORED_STEP, stepPath);
  addTextToCadMetadataToStep(stepPath, "part");

  const result = await ensureStepTopologyArtifact({ repoRoot, stepPath });
  const gltf = readGlbJson(result.glbPath);
  const indexTopology = readStepTopologyIndexManifest(result.glbPath);

  assert.equal(result.ok, true);
  assert.equal(result.entryKind, "part");
  assert.equal(gltf.extensions?.STEP_topology?.entryKind, "part");
  assert.equal(indexTopology.entryKind, "part");
  assert.equal(indexTopology.assembly, undefined);

  const catalog = scanCadDirectory({ repoRoot, rootDir: "models" });
  assert.equal(catalog.entries.length, 1);
  assert.equal(catalog.entries[0].kind, "part");
  assert.equal(catalog.entries[0].artifact, undefined);
  assert.ok(catalog.entries[0].url.includes(".benchmark_09_spiral_staircase.step.glb"));
  assert.equal(catalog.entries[0].hash.length, 64);
});

test("ensureStepArtifactsForCatalog generates missing STEP artifacts before scanning", async (t) => {
  const repoRoot = makeTempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const stepPath = copyFixtureStep(repoRoot, "workspace/parts/block.step");

  const results = await ensureStepArtifactsForCatalog({ repoRoot, rootDir: "workspace" });

  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(fs.existsSync(inlineStepGlbArtifactPathForSource(stepPath)), true);

  const catalog = scanCadDirectory({ repoRoot, rootDir: "workspace" });
  assert.equal(catalog.entries.length, 1);
  assert.equal(catalog.entries[0].artifact, undefined);
  assert.ok(catalog.entries[0].url.includes(".block.step.glb"));
  assert.equal(catalog.entries[0].hash.length, 64);
});

test("ensureStepArtifactsForCatalog uses same-stem Python generators without rewriting STEP", async (t) => {
  const repoRoot = makeTempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const stepPath = copyFixtureStep(repoRoot, "workspace/generated/block.step");
  const originalStepBytes = fs.readFileSync(stepPath);
  const generatorPath = path.join(repoRoot, "workspace/generated/block.py");
  writePythonBoxGenerator(generatorPath);

  const results = await ensureStepArtifactsForCatalog({ repoRoot, rootDir: "workspace" });

  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].sourceKind, "python");
  assert.deepEqual(fs.readFileSync(stepPath), originalStepBytes);

  const indexTopology = readStepTopologyIndexManifest(inlineStepGlbArtifactPathForSource(stepPath));
  assert.equal(indexTopology.sourceKind, "python");
  assert.equal(indexTopology.sourcePath, "workspace/generated/block.py");
  assert.equal(indexTopology.sourceFiles, undefined);

  const catalog = scanCadDirectory({ repoRoot, rootDir: "workspace" });
  assert.equal(catalog.entries.length, 1);
  assert.equal(catalog.entries[0].artifact, undefined);
  assert.ok(catalog.entries[0].url.includes(".block.step.glb"));
  assert.equal(catalog.entries[0].hash.length, 64);
});

test("ensureStepTopologyArtifact rebuilds stale Python-backed artifacts when explicitly requested", async (t) => {
  const repoRoot = makeTempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const stepPath = copyFixtureStep(repoRoot, "workspace/generated/block.step");
  const generatorPath = path.join(repoRoot, "workspace/generated/block.py");
  writePythonBoxGenerator(generatorPath);

  const first = await ensureStepTopologyArtifact({ repoRoot, stepPath });
  assert.equal(first.ok, true);
  const glbPath = inlineStepGlbArtifactPathForSource(stepPath);
  const previousManifest = readStepTopologyIndexManifest(glbPath);

  fs.appendFileSync(generatorPath, "\n# source identity change\n");
  const staleCatalog = scanCadDirectory({ repoRoot, rootDir: "workspace" });
  assert.equal(staleCatalog.entries[0].artifact.error, "stale_source_identity");

  const second = await ensureStepTopologyArtifact({ repoRoot, stepPath });
  assert.equal(second.ok, true);
  assert.equal(second.skipped, undefined);
  const nextManifest = readStepTopologyIndexManifest(glbPath);
  assert.equal(nextManifest.sourceKind, "python");
  assert.notEqual(nextManifest.sourceFingerprint, previousManifest.sourceFingerprint);

  const freshCatalog = scanCadDirectory({ repoRoot, rootDir: "workspace" });
  assert.equal(freshCatalog.entries[0].artifact, undefined);
});

test("ensureStepTopologyArtifact records explicit non-same-stem Python sourcePath", async (t) => {
  const repoRoot = makeTempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const stepPath = path.join(repoRoot, "workspace/generated/robot.step");
  const generatorPath = path.join(repoRoot, "workspace/sources/assembly.py");
  writePythonBoxGenerator(generatorPath);

  const result = await ensureStepTopologyArtifact({
    repoRoot,
    stepPath,
    sourcePath: generatorPath,
    skipStepWrite: true,
    force: true,
  });

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(stepPath), false);
  assert.equal(result.validation.ok, true);
  assert.equal(result.validation.sourceKind, "python");
  assert.equal(result.validation.sourcePath, "workspace/sources/assembly.py");

  const indexTopology = readStepTopologyIndexManifest(inlineStepGlbArtifactPathForSource(stepPath));
  const edgeView = readStepEdgeManifest(inlineStepGlbArtifactPathForSource(stepPath));
  assert.equal(indexTopology.sourceKind, "python");
  assert.equal(indexTopology.sourcePath, "workspace/sources/assembly.py");
  assert.equal(edgeView.sourceKind, "python");
  assert.equal(edgeView.sourcePath, "workspace/sources/assembly.py");

  const catalog = scanCadDirectory({ repoRoot, rootDir: "workspace" });
  assert.equal(catalog.entries.length, 1);
  assert.equal(catalog.entries[0].file, "generated/robot.step");
  assert.equal(catalog.entries[0].artifact, undefined);
  assert.ok(catalog.entries[0].url.includes(".robot.step.glb"));
  assert.equal(catalog.entries[0].hash.length, 64);
});

test("ensureStepTopologyArtifact rebuilds stale non-same-stem Python artifacts from recorded sourcePath", async (t) => {
  const repoRoot = makeTempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const stepPath = path.join(repoRoot, "workspace/generated/robot.step");
  const generatorPath = path.join(repoRoot, "workspace/sources/assembly.py");
  writePythonBoxGenerator(generatorPath);

  const first = await ensureStepTopologyArtifact({
    repoRoot,
    stepPath,
    sourcePath: generatorPath,
    skipStepWrite: true,
    force: true,
  });
  assert.equal(first.ok, true);
  const glbPath = inlineStepGlbArtifactPathForSource(stepPath);
  const previousManifest = readStepTopologyIndexManifest(glbPath);

  fs.appendFileSync(generatorPath, "\n# source identity change\n");
  const staleCatalog = scanCadDirectory({ repoRoot, rootDir: "workspace" });
  assert.equal(staleCatalog.entries[0].artifact.error, "stale_source_identity");
  assert.equal(staleCatalog.entries[0].artifact.sourceKind, "python");

  const second = await ensureStepTopologyArtifact({ repoRoot, stepPath });
  assert.equal(second.ok, true);
  assert.equal(second.validation.sourceKind, "python");
  assert.equal(second.validation.sourcePath, "workspace/sources/assembly.py");

  const nextManifest = readStepTopologyIndexManifest(glbPath);
  assert.equal(nextManifest.sourceKind, "python");
  assert.equal(nextManifest.sourcePath, "workspace/sources/assembly.py");
  assert.notEqual(nextManifest.sourceFingerprint, previousManifest.sourceFingerprint);
});

test("ensureStepTopologyArtifact can write Python STEP after the GLB is ready", async (t) => {
  const repoRoot = makeTempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const stepPath = path.join(repoRoot, "workspace/generated/robot.step");
  const generatorPath = path.join(repoRoot, "workspace/sources/robot.py");
  writePythonBoxGenerator(generatorPath);

  const result = await ensureStepTopologyArtifact({
    repoRoot,
    stepPath,
    sourcePath: generatorPath,
    skipStepWrite: true,
    force: true,
    writeStepAfterArtifact: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.stepWrite?.status, "pending");
  const glbPath = inlineStepGlbArtifactPathForSource(stepPath);
  assert.equal(fs.existsSync(glbPath), true);
  const indexTopology = readStepTopologyIndexManifest(glbPath);
  assert.equal(indexTopology.sourceKind, "python");
  await waitForFile(stepPath);
  const metadata = readTextToCadStepMetadataFile(stepPath);
  assert.equal(metadata.sourceHash, indexTopology.sourceHash);
  assert.equal(metadata.sourceFingerprint, indexTopology.sourceFingerprint);
});
