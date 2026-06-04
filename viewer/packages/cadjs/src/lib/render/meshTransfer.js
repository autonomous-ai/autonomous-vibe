export function meshDataTransferList(meshData) {
  const buffers = [
    meshData?.vertices?.buffer,
    meshData?.indices?.buffer,
    meshData?.normals?.buffer,
    meshData?.colors?.buffer,
    meshData?.edge_indices?.buffer,
    meshData?.surfaceEdgeBarycentric?.buffer,
    meshData?.surfaceEdgeClass?.buffer,
    meshData?.guide_line_segments?.buffer,
    meshData?.lod?.vertices?.buffer,
    meshData?.lod?.indices?.buffer,
    meshData?.lod?.normals?.buffer
  ].filter((buffer) => buffer instanceof ArrayBuffer && buffer.byteLength > 0);
  return [...new Set(buffers)];
}
