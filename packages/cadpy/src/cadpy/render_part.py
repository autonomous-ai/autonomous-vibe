"""Headless STL → PNG renderer for QA review of generated parts.

Uses matplotlib's Agg backend with a 3D ``Poly3DCollection`` built straight from
the STL triangle mesh — no GL context, so it runs reliably headless (CI, the
bundled python sidecar, a packaged `.app`). The render is deliberately matte and
multi-view so a human-or-model reviewer can spot the defects geometry counting
misses: a strut poking through a plate, a part floating disconnected, wrong
proportions.

Two primitives:
- ``render_stl_to_png`` renders one STL from the default exterior viewpoints
  (a 3/4 isometric plus all six axis-aligned faces), laid out as a grid.
- ``render_stl_section_to_png`` cuts the mesh with an axis-aligned plane and
  renders the capped half so *interior* engagement reads — a peg seated in a
  socket, a tooth sitting on solid disc, a lip inside its groove. Exterior views
  cannot show these.

Orchestration (which parts/sections to render for a generated project) lives in
`skills/cadcode/scripts/review`.
"""

from __future__ import annotations

from pathlib import Path

# Default viewpoints: a 3/4 isometric (reveals protrusions and depth) plus the
# six axis-aligned faces (top/bottom/front/back/left/right) so a part is checked
# from every direction — a defect that hides behind the body on one view (a spike
# under the floor, a feature off the back face) shows on another. Laid out as a
# grid by ``_render_tris``.
DEFAULT_VIEWS = (
    ("iso", 24.0, -58.0),
    ("top", 89.0, -90.0),
    ("bottom", -89.0, -90.0),
    ("front", 0.0, -90.0),
    ("back", 0.0, 90.0),
    ("right", 0.0, 0.0),
    ("left", 0.0, 180.0),
)

# Cut-plane normals and the view that looks roughly down each normal so the
# exposed cross-section face dominates the frame (a small elev tilt keeps depth
# readable). Keyed by axis letter.
_AXIS_INDEX = {"x": 0, "y": 1, "z": 2}
_SECTION_VIEWS = {
    "x": ("section: X-cut", 12.0, 0.0),
    "y": ("section: Y-cut", 12.0, -90.0),
    "z": ("section: Z-cut", 89.0, -90.0),
}

# Drawing per-triangle edges is the slow part of mplot3d; skip it above this
# face count (the matte shading alone still reads clearly on dense meshes).
_EDGE_FACE_LIMIT = 4000


def _render_tris(tris, png_path, *, views, size: int):
    """Shade and render a triangle array ``(F, 3, 3)`` to a multi-view PNG.

    Returns the PNG path, or ``None`` if there is nothing to draw. May raise on a
    matplotlib failure — callers wrap this so QA rendering never breaks a build.
    """
    import matplotlib

    matplotlib.use("Agg")  # headless, no display/GL — must precede pyplot
    import numpy as np
    from matplotlib import pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection

    tris = np.asarray(tris, dtype=float)
    if tris.size == 0:
        return None
    png_path = Path(png_path)

    # Lambert shading from a fixed light so faceted detail and protrusions read
    # clearly instead of flattening into one silhouette.
    normals = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    nlen = np.linalg.norm(normals, axis=1, keepdims=True)
    nlen[nlen == 0] = 1.0
    normals = normals / nlen
    light = np.array([0.3, 0.4, 0.85])
    light = light / np.linalg.norm(light)
    shade = np.clip(np.abs(normals @ light), 0.18, 1.0)
    base = np.array([0.55, 0.62, 0.72])
    rgb = np.clip(shade[:, None] * base[None, :], 0.0, 1.0)
    facecolors = np.concatenate([rgb, np.ones((len(rgb), 1))], axis=1)

    draw_edges = len(tris) <= _EDGE_FACE_LIMIT

    pts = tris.reshape(-1, 3)
    lo = pts.min(axis=0)
    hi = pts.max(axis=0)
    center = (lo + hi) / 2.0
    half = (float((hi - lo).max()) or 1.0) * 0.55

    n = len(views)
    # Lay the views out in a near-square grid rather than one wide strip, so a
    # 7-view montage stays readable instead of becoming an ultra-wide band.
    cols = int(np.ceil(np.sqrt(n)))
    rows = int(np.ceil(n / cols))
    fig = plt.figure(figsize=(size / 100.0 * cols, size / 100.0 * rows), dpi=100)
    for i, (label, elev, azim) in enumerate(views):
        ax = fig.add_subplot(rows, cols, i + 1, projection="3d")
        coll = Poly3DCollection(
            tris,
            facecolors=facecolors,
            edgecolors=(0, 0, 0, 0.10) if draw_edges else "none",
            linewidths=0.2 if draw_edges else 0.0,
        )
        ax.add_collection3d(coll)
        ax.set_xlim(center[0] - half, center[0] + half)
        ax.set_ylim(center[1] - half, center[1] + half)
        ax.set_zlim(center[2] - half, center[2] + half)
        ax.set_box_aspect((1, 1, 1))
        ax.view_init(elev=elev, azim=azim)
        ax.set_title(label, fontsize=9)
        ax.set_axis_off()
    fig.tight_layout()
    png_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(str(png_path), facecolor="white", bbox_inches="tight", pad_inches=0.1)
    plt.close(fig)
    return png_path


def render_stl_to_png(
    stl_path: str | Path,
    png_path: str | Path,
    *,
    views=DEFAULT_VIEWS,
    size: int = 760,
) -> Path | None:
    """Render an STL mesh to a multi-view PNG. Returns the PNG path, or ``None``
    if rendering failed (never raises — QA rendering must not break a build)."""
    try:
        import numpy as np
        import trimesh

        mesh = trimesh.load(str(stl_path), force="mesh")
        verts = np.asarray(mesh.vertices, dtype=float)
        faces = np.asarray(mesh.faces, dtype=int)
        if verts.size == 0 or faces.size == 0:
            return None
        return _render_tris(verts[faces], png_path, views=views, size=size)
    except Exception:
        return None


def render_stl_section_to_png(
    stl_path: str | Path,
    png_path: str | Path,
    *,
    axis: str = "x",
    offset: float | None = None,
    size: int = 760,
) -> Path | None:
    """Render an *interior* cross-section of an STL.

    Cuts the mesh with the axis-aligned plane ``coord[axis] = offset`` (default:
    the bounding-box center), keeps the capped half on the lower side, and views
    it straight onto the exposed cut face — so interior engagement is visible
    (peg seated in a socket, tooth on solid material, lip inside its groove).

    Returns the PNG path, or ``None`` on any failure (never raises)."""
    try:
        import numpy as np
        import trimesh
        from trimesh.intersections import slice_faces_plane

        axis = str(axis).lower()
        if axis not in _AXIS_INDEX:
            return None

        mesh = trimesh.load(str(stl_path), force="mesh")
        if getattr(mesh, "faces", None) is None or len(mesh.faces) == 0:
            return None

        ai = _AXIS_INDEX[axis]
        if offset is None:
            offset = float(mesh.bounds.mean(axis=0)[ai])  # bbox center on this axis
        origin = np.zeros(3)
        origin[ai] = float(offset)
        normal = np.zeros(3)
        normal[ai] = 1.0

        # Keep the lower half (coord <= offset) and view it from the +normal side
        # so the open cut faces the camera and we look straight into the cavity.
        # `slice_faces_plane` is the shapely-free primitive (no cap, which is what
        # we want — an open section reads the interior). Keeps the side the normal
        # points TO, so pass -normal. Fall back to the other half if the offset
        # landed outside the body.
        verts, faces = slice_faces_plane(
            mesh.vertices, mesh.faces, plane_normal=-normal, plane_origin=origin
        )[:2]
        if len(faces) == 0:
            verts, faces = slice_faces_plane(
                mesh.vertices, mesh.faces, plane_normal=normal, plane_origin=origin
            )[:2]
        verts = np.asarray(verts, dtype=float)
        faces = np.asarray(faces, dtype=int)
        if verts.size == 0 or faces.size == 0:
            return None
        return _render_tris(
            verts[faces], png_path, views=(_SECTION_VIEWS[axis],), size=size
        )
    except Exception:
        return None
