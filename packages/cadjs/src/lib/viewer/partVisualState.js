import { syncLineMaterialOpacity } from "../../common/renderEdges.js";
import {
  REFERENCE_HOVER_COLOR,
  REFERENCE_SELECTED_COLOR
} from "./referenceGeometry.js";
import { BASE_VIEWER_THEME } from "./stageTheme.js";
import { readSourceColor } from "./surfaceMaterials.js";

const CAD_EDGE_OPACITY = 0.84;
const PART_HOVER_OPACITY_BOOST = 0.08;
const PART_SELECTED_OPACITY_BOOST = 0.12;
const PART_HIGHLIGHT_SURFACE_RENDER_ORDER = 23;
const PART_HIGHLIGHT_EDGE_RENDER_ORDER = 26;
export const FOCUSED_DIMMED_SURFACE_OPACITY = 0.035;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function getPartHighlightColors(THREE) {
  return {
    hoveredSurfaceColor: new THREE.Color(REFERENCE_HOVER_COLOR),
    hoveredEdgeColor: new THREE.Color(REFERENCE_SELECTED_COLOR),
    selectedSurfaceColor: new THREE.Color(REFERENCE_SELECTED_COLOR),
    selectedEdgeColor: new THREE.Color(REFERENCE_SELECTED_COLOR)
  };
}

export function normalizePartIdList(value) {
  return (Array.isArray(value) ? value : [value])
    .map((id) => String(id || "").trim())
    .filter(Boolean);
}

export function referenceMatchesFocusedPart(reference, focusedPartIdSet) {
  if (!focusedPartIdSet?.size) {
    return true;
  }
  const partId = String(reference?.partId || "").trim();
  return partId
    ? focusedPartIdSet.has(partId)
    : focusedPartIdSet.has("__model__");
}

function baseObjectRenderOrder(record, object, fieldName) {
  if (!object) {
    return 0;
  }
  if (!Number.isFinite(Number(record[fieldName]))) {
    record[fieldName] = Number.isFinite(Number(object.renderOrder)) ? Number(object.renderOrder) : 0;
  }
  return record[fieldName];
}

function syncHighlightRenderOrder(record, object, fieldName, highlighted, highlightRenderOrder) {
  if (!object) {
    return;
  }
  const baseRenderOrder = baseObjectRenderOrder(record, object, fieldName);
  object.renderOrder = highlighted ? highlightRenderOrder : baseRenderOrder;
}

function syncSurfaceTransparency(record, forceTransparent, opacity, {
  writeTransparentDepth = true
} = {}) {
  const material = record?.material;
  if (!material) {
    return;
  }
  if (!Object.hasOwn(record, "baseDepthWrite")) {
    record.baseDepthWrite = material.depthWrite !== false;
  }
  const nextTransparent = forceTransparent || opacity < 0.999;
  if (material.transparent !== nextTransparent) {
    material.transparent = nextTransparent;
    material.needsUpdate = true;
  }
  material.depthWrite = nextTransparent && !writeTransparentDepth ? false : record.baseDepthWrite;
}

export function applyPartVisualState(THREE, records, {
  viewerTheme,
  edgeSettings,
  hiddenPartIds,
  hoveredPartId,
  focusedPartId,
  selectedPartIds,
  showEdges
}) {
  const hidden = new Set(Array.isArray(hiddenPartIds) ? hiddenPartIds : []);
  const selected = new Set(Array.isArray(selectedPartIds) ? selectedPartIds : []);
  const hovered = new Set(
    (Array.isArray(hoveredPartId) ? hoveredPartId : [hoveredPartId])
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  );
  const baseEdgeColor = edgeSettings?.color || viewerTheme?.edge || BASE_VIEWER_THEME.edge;
  const defaultSurfaceOpacity = Number.isFinite(Number(viewerTheme?.surfaceOpacity))
    ? Number(viewerTheme.surfaceOpacity)
    : 1;
  const focusIds = new Set(normalizePartIdList(focusedPartId));
  const hasFocus = focusIds.size > 0;
  const baseEdgeOpacity = Number.isFinite(Number(edgeSettings?.opacity))
    ? clamp(Number(edgeSettings.opacity), 0, 1)
    : (viewerTheme?.edgeOpacity ?? BASE_VIEWER_THEME.edgeOpacity ?? CAD_EDGE_OPACITY);
  const {
    hoveredSurfaceColor,
    hoveredEdgeColor,
    selectedSurfaceColor,
    selectedEdgeColor
  } = getPartHighlightColors(THREE);

  for (const record of Array.isArray(records) ? records : []) {
    const effectStyle = record.effectStyle && typeof record.effectStyle === "object" ? record.effectStyle : {};
    const effectHidden = record.effectVisible === false;
    const effectColor = readSourceColor(THREE, effectStyle.color);
    const effectEdgeColor = readSourceColor(THREE, effectStyle.edgeColor);
    const effectEmissive = readSourceColor(THREE, effectStyle.emissive);
    const isHidden = hidden.has(record.partId);
    const isSelected = selected.has(record.partId) || record.effectHighlighted === true;
    const isHovered = !isHidden && !effectHidden && hovered.has(record.partId);
    const isFocused = !isHidden && !effectHidden && hasFocus && focusIds.has(record.partId);
    const isDimmed = !isHidden && !effectHidden && hasFocus && !isFocused;
    const isHighlighted = isSelected || isHovered;

    record.mesh.visible = !isHidden && !effectHidden;
    if (record.edges) {
      record.edges.visible = showEdges && !isHidden && !effectHidden;
    }
    syncHighlightRenderOrder(record, record.mesh, "baseMeshRenderOrder", isHighlighted, PART_HIGHLIGHT_SURFACE_RENDER_ORDER);
    syncHighlightRenderOrder(record, record.edges, "baseEdgeRenderOrder", isHighlighted, PART_HIGHLIGHT_EDGE_RENDER_ORDER);

    const baseSurfaceOpacity = Number.isFinite(Number(record.baseOpacity))
      ? Number(record.baseOpacity)
      : defaultSurfaceOpacity;
    const effectOpacity = Number.isFinite(Number(effectStyle.opacity))
      ? clamp(Number(effectStyle.opacity), 0, 1)
      : 1;
    const effectEdgeOpacity = Number.isFinite(Number(effectStyle.edgeOpacity))
      ? clamp(Number(effectStyle.edgeOpacity), 0, 1)
      : effectOpacity;
    const dimmedSurfaceOpacity = hasFocus
      ? Math.min(baseSurfaceOpacity * effectOpacity, FOCUSED_DIMMED_SURFACE_OPACITY)
      : baseSurfaceOpacity * effectOpacity;
    const highlightedSurfaceOpacity = isSelected
      ? clamp((baseSurfaceOpacity * effectOpacity) + PART_SELECTED_OPACITY_BOOST, 0, 1)
      : isHovered
        ? clamp((baseSurfaceOpacity * effectOpacity) + PART_HOVER_OPACITY_BOOST, 0, 1)
        : baseSurfaceOpacity * effectOpacity;
    const nextSurfaceOpacity = isDimmed ? dimmedSurfaceOpacity : highlightedSurfaceOpacity;
    syncSurfaceTransparency(record, isDimmed || isHighlighted, nextSurfaceOpacity, {
      writeTransparentDepth: !isDimmed
    });
    record.material.opacity = nextSurfaceOpacity;

    if (record.baseColor && record.material.color) {
      record.material.color.copy(
        isSelected
          ? selectedSurfaceColor
          : isHovered
            ? hoveredSurfaceColor
            : effectColor || record.baseColor
      );
    }

    if ("emissive" in record.material && record.material.emissive) {
      if (isSelected) {
        record.material.emissive.set(REFERENCE_SELECTED_COLOR);
      } else if (isHovered) {
        record.material.emissive.set(REFERENCE_HOVER_COLOR);
      } else if (record.baseEmissiveColor && record.baseEmissiveIntensity > 0) {
        record.material.emissive.copy(record.baseEmissiveColor);
      } else {
        record.material.emissive.set(0x000000);
      }
      record.material.emissiveIntensity = isSelected
        ? 0.08
        : isHovered
          ? 0.12
          : effectEmissive
            ? clamp(Number(effectStyle.emissiveIntensity) || 0.22, 0, 2)
            : clamp(Number(record.baseEmissiveIntensity) || 0, 0, 2);
      if (!isSelected && !isHovered && effectEmissive) {
        record.material.emissive.copy(effectEmissive);
      }
    }

    if (record.edgeMaterial) {
      record.edgeMaterial.color.set(
        isSelected
          ? selectedEdgeColor
          : isHovered
            ? hoveredEdgeColor
            : effectEdgeColor || baseEdgeColor
      );
      syncLineMaterialOpacity(record.edgeMaterial, isSelected
        ? baseEdgeOpacity * effectEdgeOpacity
        : isHovered
          ? baseEdgeOpacity * effectEdgeOpacity
          : isDimmed
            ? nextSurfaceOpacity
            : baseEdgeOpacity * effectEdgeOpacity);
    }
  }
}
