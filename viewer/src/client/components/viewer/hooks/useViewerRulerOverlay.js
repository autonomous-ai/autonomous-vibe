import { useEffect, useRef } from "react";
import { RULER_TOOL } from "../../../workbench/constants";
import { pointVisibleByClipPlane } from "cadjs/lib/viewer/clipPlane";
import {
  angleAtVertex,
  boundingBoxDims,
  diameterFromSurface,
  distanceWithDeltas,
  nearestVertex,
  wallThickness
} from "cadjs/lib/viewer/rulerGeometry";

const FINE_TAP_SLOP_PX = 4;
const COARSE_TAP_SLOP_PX = 12;

// How many clicks each tool needs before it produces a measurement. Single-click
// tools (diameter, wall-thickness, bounding-box) resolve immediately.
const REQUIRED_POINTS = {
  [RULER_TOOL.DISTANCE]: 2,
  [RULER_TOOL.ANGLE]: 3,
  [RULER_TOOL.DIAMETER]: 1,
  [RULER_TOOL.WALL_THICKNESS]: 1,
  [RULER_TOOL.BOUNDING_BOX]: 1
};

function createMeasurementId() {
  return `measure-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function toArray(point) {
  return [point.x, point.y, point.z];
}

// Tap-based measurement input modelled on useViewerPicking: it shares the host
// element with the selection picker and distinguishes a click from an orbit drag
// via tap-slop, so free-tumble rotation keeps working while measuring. All hit
// points are world-space; the viewer stores them and re-derives values on reload.
export function useViewerRulerOverlay({
  runtimeRef,
  hostRef,
  sceneMountRef,
  rulerEnabled,
  rulerTool,
  previewMode,
  selectorRuntime,
  rulerMeasurementsRef,
  rulerChangeRef,
  rulerDraftChangeRef,
  viewerReadyTick
}) {
  const rulerToolRef = useRef(rulerTool);
  const selectorRuntimeRef = useRef(selectorRuntime);
  rulerToolRef.current = rulerTool;
  selectorRuntimeRef.current = selectorRuntime;

  useEffect(() => {
    const runtime = runtimeRef.current;
    const host = hostRef?.current;
    if (!runtime || !host || !rulerEnabled || previewMode) {
      rulerDraftChangeRef.current?.(null);
      return undefined;
    }

    const THREE = runtime.THREE;
    const sceneMount = sceneMountRef?.current || null;
    const coarsePointer = typeof window.matchMedia === "function"
      ? (window.matchMedia("(pointer: coarse)")?.matches ?? false)
      : false;
    const draft = { points: [] };
    const pointerDown = { active: false, x: 0, y: 0, pointerType: "" };

    function isSceneTarget(target) {
      if (!(target instanceof Node)) {
        return false;
      }
      if (target === runtime.renderer?.domElement) {
        return true;
      }
      return sceneMount ? sceneMount === target || sceneMount.contains(target) : true;
    }

    function visibleMeshes() {
      return (Array.isArray(runtime.displayRecords) ? runtime.displayRecords : [])
        .filter((record) => record?.mesh?.visible)
        .map((record) => record.mesh);
    }

    function clipVisibleHits(hits) {
      if (!runtime.activeClipPlane) {
        return hits;
      }
      return hits.filter((hit) => pointVisibleByClipPlane(runtime.activeClipPlane, hit.point));
    }

    function hitsAtPosition(clientX, clientY) {
      const rect = host.getBoundingClientRect();
      runtime.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      runtime.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      runtime.raycaster.setFromCamera(runtime.pointer, runtime.camera);
      const meshes = visibleMeshes();
      if (!meshes.length) {
        return [];
      }
      return clipVisibleHits(runtime.raycaster.intersectObjects(meshes, false));
    }

    // Light snap to the nearest corner of the hit triangle — helps at real model
    // vertices/edges and stays out of the way mid-face thanks to a tight radius.
    function snapPoint(hit) {
      const world = toArray(hit.point);
      const face = hit.face;
      const position = hit.object?.geometry?.attributes?.position;
      if (!face || !position) {
        return world;
      }
      const corners = [face.a, face.b, face.c].map((index) => {
        const vertex = new THREE.Vector3().fromBufferAttribute(position, index);
        hit.object.localToWorld(vertex);
        return toArray(vertex);
      });
      const threshold = Math.max(Number(runtime.modelRadius || 1) * 0.01, 0.2);
      return nearestVertex(world, corners, threshold) || world;
    }

    function faceReferenceFromHit(hit) {
      const faceIds = hit?.object?.userData?.faceIds;
      const triangleIndex = Number(hit?.faceIndex);
      const rowIndex = Number.isInteger(triangleIndex) ? Number(faceIds?.[triangleIndex]) : NaN;
      if (!Number.isInteger(rowIndex)) {
        return null;
      }
      return selectorRuntimeRef.current?.faceReferenceByRowIndex?.get?.(rowIndex) || null;
    }

    function emitMeasurement(measurement) {
      const current = Array.isArray(rulerMeasurementsRef.current) ? rulerMeasurementsRef.current : [];
      rulerChangeRef.current?.([...current, measurement]);
    }

    function emitDraft() {
      rulerDraftChangeRef.current?.(
        draft.points.length ? { tool: rulerToolRef.current, points: draft.points.slice() } : null
      );
    }

    function commitMultiPoint(tool, points) {
      if (tool === RULER_TOOL.ANGLE) {
        const degrees = angleAtVertex(points[0], points[1], points[2]);
        emitMeasurement({
          id: createMeasurementId(),
          tool: RULER_TOOL.ANGLE,
          points,
          value: degrees,
          components: [degrees],
          partId: ""
        });
        return;
      }
      const { distance, dx, dy, dz } = distanceWithDeltas(points[0], points[1]);
      emitMeasurement({
        id: createMeasurementId(),
        tool: RULER_TOOL.DISTANCE,
        points,
        value: distance,
        components: [dx, dy, dz],
        partId: ""
      });
    }

    function commitDiameter(hit) {
      const reference = faceReferenceFromHit(hit);
      const surface = reference?.pickData?.surface;
      const dimensions = diameterFromSurface(surface);
      if (!dimensions) {
        return;
      }
      const localPoint = hit.object.worldToLocal(hit.point.clone());
      const origin = new THREE.Vector3(...(surface.origin || [0, 0, 0]));
      const axis = new THREE.Vector3(...(surface.axis || [0, 0, 1]));
      if (axis.lengthSq() < 1e-9) {
        return;
      }
      axis.normalize();
      const axial = localPoint.clone().sub(origin).dot(axis);
      const center = origin.clone().add(axis.clone().multiplyScalar(axial));
      const radial = localPoint.clone().sub(center);
      if (radial.lengthSq() < 1e-9) {
        return;
      }
      radial.normalize();
      const endA = hit.object.localToWorld(center.clone().add(radial.clone().multiplyScalar(dimensions.radius)));
      const endB = hit.object.localToWorld(center.clone().add(radial.clone().multiplyScalar(-dimensions.radius)));
      emitMeasurement({
        id: createMeasurementId(),
        tool: RULER_TOOL.DIAMETER,
        points: [toArray(endA), toArray(endB)],
        value: dimensions.diameter,
        components: [dimensions.radius, dimensions.diameter],
        partId: String(reference?.partId || "")
      });
    }

    function commitWallThickness(hit) {
      const entry = hit.point.clone();
      if (!hit.face) {
        return;
      }
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
      const outward = hit.face.normal.clone().applyMatrix3(normalMatrix).normalize();
      const eps = Math.max(Number(runtime.modelRadius || 1) * 1e-3, 1e-3);
      const far = Math.max(Number(runtime.modelRadius || 1) * 4, 1);
      const meshes = visibleMeshes();

      const castAlong = (direction) => {
        const origin = entry.clone().add(direction.clone().multiplyScalar(eps));
        const ray = new THREE.Raycaster(origin, direction.clone().normalize(), 0, far);
        const hits = clipVisibleHits(ray.intersectObjects(meshes, false));
        return hits.find((candidate) => candidate.distance > eps) || null;
      };

      const inward = outward.clone().multiplyScalar(-1);
      const exit = castAlong(inward) || castAlong(outward);
      if (!exit) {
        return;
      }
      const entryArr = toArray(entry);
      const exitArr = toArray(exit.point);
      emitMeasurement({
        id: createMeasurementId(),
        tool: RULER_TOOL.WALL_THICKNESS,
        points: [entryArr, exitArr],
        value: wallThickness(entryArr, exitArr),
        components: [wallThickness(entryArr, exitArr)],
        partId: String(hit.object?.userData?.partId || "")
      });
    }

    function commitBoundingBox() {
      const bounds = runtime.modelBounds;
      if (!bounds) {
        return;
      }
      const current = Array.isArray(rulerMeasurementsRef.current) ? rulerMeasurementsRef.current : [];
      if (current.some((measurement) => measurement?.tool === RULER_TOOL.BOUNDING_BOX)) {
        return;
      }
      const offset = runtime.modelGroup?.position
        ? [runtime.modelGroup.position.x, runtime.modelGroup.position.y, runtime.modelGroup.position.z]
        : [0, 0, 0];
      const { width, depth, height, corners } = boundingBoxDims(bounds, offset);
      emitMeasurement({
        id: createMeasurementId(),
        tool: RULER_TOOL.BOUNDING_BOX,
        points: corners,
        value: 0,
        components: [width, depth, height],
        partId: ""
      });
    }

    function placePoint(clientX, clientY) {
      const tool = rulerToolRef.current;
      if (tool === RULER_TOOL.BOUNDING_BOX) {
        commitBoundingBox();
        return;
      }
      const hits = hitsAtPosition(clientX, clientY);
      if (!hits.length) {
        return;
      }
      const hit = hits[0];
      if (tool === RULER_TOOL.DIAMETER) {
        commitDiameter(hit);
        return;
      }
      if (tool === RULER_TOOL.WALL_THICKNESS) {
        commitWallThickness(hit);
        return;
      }
      draft.points.push(snapPoint(hit));
      if (draft.points.length >= (REQUIRED_POINTS[tool] || 2)) {
        commitMultiPoint(tool, draft.points.slice());
        draft.points = [];
      }
      emitDraft();
    }

    function handlePointerDown(event) {
      if (event.button !== 0 || !isSceneTarget(event.target)) {
        return;
      }
      pointerDown.active = true;
      pointerDown.x = event.clientX;
      pointerDown.y = event.clientY;
      pointerDown.pointerType = event.pointerType || "";
    }

    function handlePointerUp(event) {
      if (event.button !== 0) {
        return;
      }
      const wasActive = pointerDown.active;
      pointerDown.active = false;
      if (!wasActive || !isSceneTarget(event.target)) {
        return;
      }
      const slop = pointerDown.pointerType === "touch" || coarsePointer
        ? COARSE_TAP_SLOP_PX
        : FINE_TAP_SLOP_PX;
      if (Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > slop) {
        return;
      }
      placePoint(event.clientX, event.clientY);
    }

    function handleKeyDown(event) {
      if (event.key !== "Escape" || !draft.points.length) {
        return;
      }
      draft.points = [];
      emitDraft();
    }

    host.addEventListener("pointerdown", handlePointerDown);
    host.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      host.removeEventListener("pointerdown", handlePointerDown);
      host.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("keydown", handleKeyDown);
      draft.points = [];
      rulerDraftChangeRef.current?.(null);
    };
  }, [
    hostRef,
    previewMode,
    rulerDraftChangeRef,
    rulerEnabled,
    rulerMeasurementsRef,
    rulerChangeRef,
    runtimeRef,
    sceneMountRef,
    viewerReadyTick
  ]);
}
