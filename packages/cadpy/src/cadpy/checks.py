"""Deterministic geometry sanity checks for generated parts.

These run after ``generate_step`` has produced geometry and surface a list of
structured warnings (never raising) describing problems a human spots instantly
but the generator does not:

  * ``disconnected_bodies`` — a single printable part is more than one solid, so
    some feature never fused to the main body (e.g. a standoff placed off the
    tray edge floats in mid-air).
  * ``sliver`` — a near-zero-volume solid, usually a degenerate cut/union.
  * ``invalid_brep`` — OCCT considers the B-rep invalid (self-intersection,
    bad topology).
  * ``empty`` — the part has no solid bodies at all.
  * ``sharp_edges`` — advisory (``severity: "info"``): how many un-softened
    convex arrises (two planar faces meeting at a sharp ~90° angle) the part
    still carries. A premium design gives these a consistent fillet/chamfer
    radius language; this is a hint for the aesthetic-polish pass, never a
    defect — a part is free to keep functional arrises sharp.

A "part" here means one printable body. For an assembly each leaf occurrence is
checked against its own (un-located) prototype shape; the merged assembly shape
is *not* checked for solid count, since an assembly legitimately holds many
solids.

Warnings are advisory — generation still succeeds (``ok=true``). They are the
gate the cadcode skill loop and the harness Review phase use to decide whether
to keep fixing.
"""

from __future__ import annotations

# A solid smaller than this (mm^3) is almost certainly a sliver / degenerate
# body rather than intended printable geometry (a 1mm cube is 1 mm^3).
SLIVER_VOLUME_MM3 = 1.0

# A convex edge between two planar faces whose outward normals meet at an angle
# of at least this many degrees reads as a hard, un-softened arris. 90° is a raw
# box corner; a 45° chamfer transition stays below this and is treated as
# already softened (its two new edges turn ~45° each).
SHARP_EDGE_MIN_NORMAL_ANGLE_DEG = 50.0

Warning = dict  # {"part": str, "kind": str, "detail": str, "severity": str}


def _solids(shape: object) -> list:
    """Return the list of ``TopoDS_Solid`` sub-shapes of an OCCT shape."""
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp
    from OCP.TopTools import TopTools_IndexedMapOfShape

    solid_map = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(shape, TopAbs_SOLID, solid_map)
    return [solid_map.FindKey(i) for i in range(1, solid_map.Extent() + 1)]


def count_solids(shape: object) -> int:
    """Number of distinct ``TopAbs_SOLID`` bodies in an OCCT shape.

    A single printable part should be one connected solid. A count > 1 means a
    boolean union left bodies that never fused — i.e. detached/floating
    geometry (verified: a union of two disjoint boxes is 2 solids, two touching
    boxes fuse to 1).
    """
    return len(_solids(shape))


def _solid_volume(solid: object) -> float:
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(solid, props)
    return float(props.Mass())


def min_solid_volume(shape: object) -> float:
    """Smallest per-solid volume (mm^3), or ``0.0`` if there are no solids."""
    vols = [_solid_volume(s) for s in _solids(shape)]
    return min(vols) if vols else 0.0


def is_valid(shape: object) -> bool:
    """True if OCCT's ``BRepCheck_Analyzer`` reports the shape as valid."""
    from OCP.BRepCheck import BRepCheck_Analyzer

    return bool(BRepCheck_Analyzer(shape).IsValid())


def _planar_face_outward_normal(face: object):
    """Outward unit normal of a planar face as a ``gp_Dir``, or ``None``.

    Returns ``None`` for non-planar faces (a fillet's cylinder/torus face, a
    lofted surface): an edge bordering such a face is already a soft transition,
    not a hard arris, so the sharp-edge count skips it. The plane axis is flipped
    when the face is ``REVERSED`` so the result points out of the solid.
    """
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Plane
    from OCP.TopAbs import TopAbs_REVERSED
    from OCP.TopoDS import TopoDS

    surf = BRepAdaptor_Surface(TopoDS.Face_s(face))
    if surf.GetType() != GeomAbs_Plane:
        return None
    normal = surf.Plane().Axis().Direction()
    if face.Orientation() == TopAbs_REVERSED:
        normal.Reverse()
    return normal


def _edge_is_convex(
    edge: object, face: object, normal: object, other_normal: object
) -> bool:
    """True if ``edge`` is a convex arris of ``face`` (material bends away).

    Walks ``face``'s boundary to recover the edge's oriented tangent ``T`` (a
    face's interior lies to the left of its boundary travel, i.e. along
    ``normal × T``), then tests whether the mating face (``other_normal``) folds
    outward. Raises on degenerate tangents; callers treat any failure as
    "not counted".
    """
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_REVERSED
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS
    from OCP.gp import gp_Dir, gp_Pnt, gp_Vec

    explorer = TopExp_Explorer(face, TopAbs_EDGE)
    orientation = None
    while explorer.More():
        candidate = explorer.Current()
        if candidate.IsSame(edge):
            orientation = candidate.Orientation()
            break
        explorer.Next()

    curve = BRepAdaptor_Curve(TopoDS.Edge_s(edge))
    mid = (curve.FirstParameter() + curve.LastParameter()) / 2.0
    point = gp_Pnt()
    tangent_vec = gp_Vec()
    curve.D1(mid, point, tangent_vec)
    tangent = gp_Dir(tangent_vec)
    if orientation == TopAbs_REVERSED:
        tangent.Reverse()

    interior_dir = normal.Crossed(tangent)  # into this face, away from the edge
    return interior_dir.Dot(other_normal) < 0


def count_sharp_convex_edges(shape: object) -> int:
    """Number of un-softened convex arrises in an OCCT shape (advisory).

    An arris counts when it borders exactly two planar faces whose outward
    normals meet at >= ``SHARP_EDGE_MIN_NORMAL_ANGLE_DEG`` and the edge is convex
    (an outer corner, not an interior notch). Best-effort: any edge whose
    geometry can't be evaluated is skipped, never fatal.
    """
    import math

    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
    from OCP.TopExp import TopExp
    from OCP.TopTools import (
        TopTools_IndexedDataMapOfShapeListOfShape,
        TopTools_ListOfShape,
    )

    threshold = math.radians(SHARP_EDGE_MIN_NORMAL_ANGLE_DEG)
    edge_to_faces = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shape, TopAbs_EDGE, TopAbs_FACE, edge_to_faces)

    count = 0
    for i in range(1, edge_to_faces.Extent() + 1):
        faces: TopTools_ListOfShape = edge_to_faces.FindFromIndex(i)
        if faces.Extent() != 2:
            continue  # boundary/seam edge or non-manifold; not a clean arris
        face_a = faces.First()
        face_b = faces.Last()
        normal_a = _planar_face_outward_normal(face_a)
        normal_b = _planar_face_outward_normal(face_b)
        if normal_a is None or normal_b is None:
            continue  # at least one side already a curved/soft face
        if normal_a.Angle(normal_b) < threshold:
            continue  # faces nearly tangent — not a sharp corner
        edge = edge_to_faces.FindKey(i)
        try:
            if _edge_is_convex(edge, face_a, normal_a, normal_b):
                count += 1
        except Exception:
            continue
    return count


def _warning(part: str, kind: str, detail: str, severity: str = "warning") -> Warning:
    return {"part": part, "kind": kind, "detail": detail, "severity": severity}


def check_part(shape: object, name: str) -> list[Warning]:
    """Deterministic sanity checks on a single printable part.

    Never raises — a check that itself errors is reported as ``check_failed``
    so geometry validation can never break generation.
    """
    warnings: list[Warning] = []
    try:
        solids = _solids(shape)
        n = len(solids)
        if n == 0:
            warnings.append(
                _warning(name, "empty", "part contains no solid bodies", "error")
            )
            return warnings
        if n > 1:
            warnings.append(
                _warning(
                    name,
                    "disconnected_bodies",
                    f"part is {n} separate solids — some geometry is detached "
                    "from the main body (floating). Every feature must connect "
                    "to the body or sit within its footprint.",
                    "error",
                )
            )
        smallest = min(_solid_volume(s) for s in solids)
        if smallest < SLIVER_VOLUME_MM3:
            warnings.append(
                _warning(
                    name,
                    "sliver",
                    f"smallest solid is {smallest:.4f} mm^3 "
                    f"(< {SLIVER_VOLUME_MM3} mm^3) — likely a degenerate sliver "
                    "from an over-reaching cut or union.",
                )
            )
        if not is_valid(shape):
            warnings.append(
                _warning(
                    name,
                    "invalid_brep",
                    "OCCT reports the B-rep as invalid (self-intersection or "
                    "bad topology).",
                )
            )
        # Advisory aesthetic signal — only meaningful on a single clean solid;
        # on a disconnected/empty part the count would be noise during repair.
        if n == 1:
            sharp = count_sharp_convex_edges(shape)
            if sharp > 0:
                warnings.append(
                    _warning(
                        name,
                        "sharp_edges",
                        f"{sharp} un-softened convex arris(es) (~90 deg) — give "
                        "outer edges a consistent fillet/chamfer radius language "
                        "where it does not hurt strength or printability.",
                        "info",
                    )
                )
    except Exception as exc:  # never let checks break generation
        warnings.append(
            _warning(
                name,
                "check_failed",
                f"geometry check raised {type(exc).__name__}: {exc}",
            )
        )
    return warnings


def collect_scene_warnings(export_shape: object, scene: object) -> list[Warning]:
    """Run per-part checks across a generated scene.

    For an assembly (more than one leaf occurrence) each part is checked against
    its own un-located prototype shape, so a floating standoff is caught even
    though the merged assembly has many solids by design. For a single-part
    project the merged ``export_shape`` is the part.
    """
    from cadpy.step_scene import (
        scene_leaf_occurrences,
        scene_occurrence_prototype_shape,
    )

    try:
        leaves = list(scene_leaf_occurrences(scene))
    except Exception:
        leaves = []

    warnings: list[Warning] = []
    if len(leaves) > 1:
        for index, node in enumerate(leaves):
            if (
                getattr(node, "prototype_key", None) is None
                or node.prototype_key not in scene.prototype_shapes
            ):
                continue
            name = node.name or node.source_name or f"part{index + 1}"
            try:
                shape = scene_occurrence_prototype_shape(scene, node)
            except Exception:
                continue
            warnings.extend(check_part(shape, name))
    else:
        warnings.extend(check_part(export_shape, "model"))
    return warnings
