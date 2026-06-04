// Fast vertex-clustering decimation for preview LOD.
//
// Operates on plain typed arrays (no THREE dependency) so it can run inside the
// STL/GLB mesh worker before the geometry ever reaches the main thread. The goal
// is a cheap, O(n) level-of-detail proxy shown *during* camera interaction on
// huge meshes — full-resolution geometry is still rendered at rest. Quality is
// lower than quadric edge-collapse (SimplifyModifier), but it is fast enough to
// run synchronously on million-triangle meshes and good enough for an orbit proxy.

const DEFAULT_TARGET_RATIO = 0.25;
const MIN_GRID = 4;
const MAX_GRID = 512;

function boundsOf(vertices) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i], y = vertices[i + 1], z = vertices[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

// Pick a per-axis grid resolution whose cell count is on the order of the target
// vertex count. Only axes with meaningful extent count toward the cell budget, so
// a planar or thin mesh (one near-zero axis) still decimates across the axes it
// actually occupies instead of producing a needlessly fine grid that collapses
// nothing. Degenerate axes get a single cell.
function resolveGrid(bounds, targetVertices, override) {
  if (Number.isFinite(override) && override >= 1) {
    const g = Math.max(1, Math.min(MAX_GRID, Math.floor(override)));
    return [g, g, g];
  }
  const extents = [
    bounds.maxX - bounds.minX,
    bounds.maxY - bounds.minY,
    bounds.maxZ - bounds.minZ
  ].map((e) => Math.max(e, 0));
  const maxExtent = Math.max(...extents, 1e-9);
  const isEffective = extents.map((e) => e > maxExtent * 1e-4);
  const effectiveCount = isEffective.filter(Boolean).length || 1;
  const effectiveProduct = extents.reduce(
    (product, extent, axis) => (isEffective[axis] ? product * Math.max(extent, 1e-6) : product),
    1
  );
  // cells across the effective axes ≈ targetVertices → cellSize = (P / cells)^(1/d)
  const cellSize = Math.pow(effectiveProduct / Math.max(targetVertices, 1), 1 / effectiveCount);
  return extents.map((extent, axis) => {
    if (!isEffective[axis]) {
      return 1;
    }
    return Math.max(MIN_GRID, Math.min(MAX_GRID, Math.ceil(extent / cellSize)));
  });
}

function accumulateVertexNormals(vertices, indices) {
  const normals = new Float32Array(vertices.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ax = vertices[a], ay = vertices[a + 1], az = vertices[a + 2];
    const ux = vertices[b] - ax, uy = vertices[b + 1] - ay, uz = vertices[b + 2] - az;
    const vx = vertices[c] - ax, vy = vertices[c + 1] - ay, vz = vertices[c + 2] - az;
    // cross(u, v) — magnitude is proportional to triangle area, so larger faces
    // contribute more to the averaged vertex normal (area weighting for free).
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz;
    normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz;
    normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const nx = normals[i], ny = normals[i + 1], nz = normals[i + 2];
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-12) {
      normals[i] = nx / len;
      normals[i + 1] = ny / len;
      normals[i + 2] = nz / len;
    } else {
      normals[i + 2] = 1;
    }
  }
  return normals;
}

/**
 * Decimate an indexed triangle mesh by collapsing vertices that fall in the same
 * spatial grid cell to a single averaged representative, then dropping triangles
 * that become degenerate (two or more corners share a cell).
 *
 * @param {Float32Array} vertices  flat xyz positions (length % 3 === 0)
 * @param {Uint32Array}  indices   triangle indices (length % 3 === 0)
 * @param {object} [opts]
 * @param {number} [opts.targetRatio=0.25] desired fraction of input vertices
 * @param {number} [opts.gridResolution]   force a fixed per-axis grid (overrides ratio)
 * @returns {{vertices: Float32Array, indices: Uint32Array, normals: Float32Array,
 *           inputTriangles: number, outputTriangles: number}}
 */
export function decimateMesh(vertices, indices, opts = {}) {
  const targetRatio = Number.isFinite(opts.targetRatio) ? opts.targetRatio : DEFAULT_TARGET_RATIO;
  const vertexCount = Math.floor(vertices.length / 3);
  const inputTriangles = Math.floor(indices.length / 3);
  if (vertexCount === 0 || inputTriangles === 0) {
    return {
      vertices: new Float32Array(0),
      indices: new Uint32Array(0),
      normals: new Float32Array(0),
      inputTriangles: 0,
      outputTriangles: 0
    };
  }

  const bounds = boundsOf(vertices);
  const targetVertices = Math.max(MIN_GRID, Math.floor(vertexCount * clampRatio(targetRatio)));
  const [gx, gy, gz] = resolveGrid(bounds, targetVertices, opts.gridResolution);
  const sx = (gx - 1) / Math.max(bounds.maxX - bounds.minX, 1e-6);
  const sy = (gy - 1) / Math.max(bounds.maxY - bounds.minY, 1e-6);
  const sz = (gz - 1) / Math.max(bounds.maxZ - bounds.minZ, 1e-6);

  // Map every input vertex to a cell id, building cluster representatives lazily
  // so the output is dense (only occupied cells get an index).
  const cellOfVertex = new Int32Array(vertexCount); // -> cluster index
  const cellToCluster = new Map();
  const acc = []; // [sumX, sumY, sumZ, count] per cluster
  for (let v = 0; v < vertexCount; v += 1) {
    const i = v * 3;
    const cx = Math.min(gx - 1, Math.max(0, Math.round((vertices[i] - bounds.minX) * sx)));
    const cy = Math.min(gy - 1, Math.max(0, Math.round((vertices[i + 1] - bounds.minY) * sy)));
    const cz = Math.min(gz - 1, Math.max(0, Math.round((vertices[i + 2] - bounds.minZ) * sz)));
    const cell = (cz * gy + cy) * gx + cx;
    let cluster = cellToCluster.get(cell);
    if (cluster === undefined) {
      cluster = acc.length / 4;
      cellToCluster.set(cell, cluster);
      acc.push(0, 0, 0, 0);
    }
    const base = cluster * 4;
    acc[base] += vertices[i];
    acc[base + 1] += vertices[i + 1];
    acc[base + 2] += vertices[i + 2];
    acc[base + 3] += 1;
    cellOfVertex[v] = cluster;
  }

  const clusterCount = acc.length / 4;
  const outVertices = new Float32Array(clusterCount * 3);
  for (let c = 0; c < clusterCount; c += 1) {
    const base = c * 4;
    const n = acc[base + 3] || 1;
    outVertices[c * 3] = acc[base] / n;
    outVertices[c * 3 + 1] = acc[base + 1] / n;
    outVertices[c * 3 + 2] = acc[base + 2] / n;
  }

  // Remap triangles; drop any that collapsed to a line or point.
  const outIndices = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = cellOfVertex[indices[t]];
    const b = cellOfVertex[indices[t + 1]];
    const c = cellOfVertex[indices[t + 2]];
    if (a !== b && b !== c && a !== c) {
      outIndices.push(a, b, c);
    }
  }

  const indicesArray = new Uint32Array(outIndices);
  return {
    vertices: outVertices,
    indices: indicesArray,
    normals: accumulateVertexNormals(outVertices, indicesArray),
    inputTriangles,
    outputTriangles: Math.floor(indicesArray.length / 3)
  };
}

function clampRatio(ratio) {
  if (!Number.isFinite(ratio)) {
    return DEFAULT_TARGET_RATIO;
  }
  return Math.min(0.9, Math.max(0.01, ratio));
}
