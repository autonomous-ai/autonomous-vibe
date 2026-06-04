import { decimateMesh } from "./meshDecimate.js";
import { LARGE_MESH_TRIANGLE_COUNT } from "./meshCost.js";

const LOD_TARGET_RATIO = 0.15;

function buildBoundsFromGeometry(geometry) {
  geometry.computeBoundingBox();
  const min = geometry.boundingBox?.min;
  const max = geometry.boundingBox?.max;
  if (!min || !max) {
    return {
      min: [0, 0, 0],
      max: [0, 0, 0],
    };
  }
  return {
    min: [min.x, min.y, min.z],
    max: [max.x, max.y, max.z],
  };
}

const STL_NORMAL_CREASE_ANGLE = Math.PI / 4;

function buildDisplayGeometryFromStlGeometry(geometry, toCreasedNormals) {
  const displayGeometry = geometry.clone();
  displayGeometry.deleteAttribute?.("normal");
  const normalGeometry = typeof toCreasedNormals === "function"
    ? toCreasedNormals(displayGeometry, STL_NORMAL_CREASE_ANGLE)
    : displayGeometry;
  if (normalGeometry !== displayGeometry) {
    displayGeometry.dispose?.();
  }
  if (!normalGeometry.getAttribute("normal")) {
    normalGeometry.computeVertexNormals?.();
  }
  return normalGeometry;
}

function buildGeometryIndices(geometry, vertexCount) {
  const indexAttribute = geometry.getIndex?.();
  if (indexAttribute?.count > 0) {
    return new Uint32Array(indexAttribute.array);
  }
  const indices = new Uint32Array(vertexCount);
  for (let index = 0; index < vertexCount; index += 1) {
    indices[index] = index;
  }
  return indices;
}

// Attach a decimated level-of-detail proxy for meshes large enough that
// full-resolution geometry can't sustain a smooth orbit. The viewer renders this
// proxy only while the camera is moving and snaps back to full detail at rest,
// so it never reduces the fidelity the user actually inspects. Cheap enough
// (O(n), ~10-25 ms at a million triangles) to run inline in the worker.
function attachLodIfLarge(meshData) {
  const triangleCount = Math.floor((meshData.indices?.length || 0) / 3);
  if (triangleCount < LARGE_MESH_TRIANGLE_COUNT) {
    return meshData;
  }
  const lod = decimateMesh(meshData.vertices, meshData.indices, { targetRatio: LOD_TARGET_RATIO });
  if (lod.outputTriangles > 0 && lod.outputTriangles < triangleCount) {
    meshData.lod = {
      vertices: lod.vertices,
      indices: lod.indices,
      normals: lod.normals,
    };
  }
  return meshData;
}

export function buildMeshDataFromStlGeometry(geometry, { toCreasedNormals } = {}) {
  const displayGeometry = buildDisplayGeometryFromStlGeometry(geometry, toCreasedNormals);
  const positions = geometry.getAttribute("position");
  const displayPositions = displayGeometry.getAttribute("position");
  const displayNormals = displayGeometry.getAttribute("normal");
  try {
    if (!positions || positions.itemSize !== 3 || !displayPositions || displayPositions.itemSize !== 3) {
      throw new Error("STL geometry is missing vertex positions");
    }
    const vertexCount = displayPositions.count;
    return attachLodIfLarge({
      vertices: new Float32Array(displayPositions.array),
      indices: buildGeometryIndices(displayGeometry, vertexCount),
      normals: displayNormals?.itemSize === 3 ? new Float32Array(displayNormals.array) : new Float32Array(displayPositions.array.length),
      colors: new Float32Array(0),
      edge_indices: new Uint32Array(0),
      bounds: buildBoundsFromGeometry(geometry),
      parts: [],
      has_source_colors: false,
      sourceColor: "",
      sourceFormat: "stl",
    });
  } finally {
    displayGeometry.dispose?.();
  }
}

export async function buildMeshDataFromStlBuffer(buffer) {
  const [{ STLLoader }, { toCreasedNormals }] = await Promise.all([
    import("three/examples/jsm/loaders/STLLoader.js"),
    import("three/examples/jsm/utils/BufferGeometryUtils.js"),
  ]);
  const loader = new STLLoader();
  const geometry = loader.parse(buffer);
  try {
    return buildMeshDataFromStlGeometry(geometry, { toCreasedNormals });
  } finally {
    geometry.dispose?.();
  }
}
