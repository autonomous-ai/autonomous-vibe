"""Headless STL → PNG renderer for QA review of generated parts.

Uses matplotlib's Agg backend with a 3D ``Poly3DCollection`` built straight from
the STL triangle mesh — no GL context, so it runs reliably headless (CI, the
bundled python sidecar, a packaged `.app`). The render is deliberately matte and
multi-view so a human-or-model reviewer can spot the defects geometry counting
misses: a strut poking through a plate, a part floating disconnected, wrong
proportions.

This is a *primitive*: `render_stl_to_png` renders one STL. Orchestration (which
parts to render for a generated project) lives in `skills/cadcode/scripts/review`.
"""

from __future__ import annotations

from pathlib import Path

# Default viewpoints: a 3/4 isometric (reveals protrusions and depth) and a
# top-down (reveals footprint / floating features beyond the body outline).
DEFAULT_VIEWS = (("iso", 24.0, -58.0), ("top", 89.0, -90.0))

# Drawing per-triangle edges is the slow part of mplot3d; skip it above this
# face count (the matte shading alone still reads clearly on dense meshes).
_EDGE_FACE_LIMIT = 4000


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
        import matplotlib

        matplotlib.use("Agg")  # headless, no display/GL — must precede pyplot
        import numpy as np
        import trimesh
        from matplotlib import pyplot as plt
        from mpl_toolkits.mplot3d.art3d import Poly3DCollection

        stl_path = Path(stl_path)
        png_path = Path(png_path)

        mesh = trimesh.load(str(stl_path), force="mesh")
        verts = np.asarray(mesh.vertices, dtype=float)
        faces = np.asarray(mesh.faces, dtype=int)
        if verts.size == 0 or faces.size == 0:
            return None
        tris = verts[faces]  # (F, 3, 3)

        # Lambert shading from a fixed light so faceted detail and protrusions
        # read clearly instead of flattening into one silhouette.
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

        draw_edges = len(faces) <= _EDGE_FACE_LIMIT

        lo = verts.min(axis=0)
        hi = verts.max(axis=0)
        center = (lo + hi) / 2.0
        half = (float((hi - lo).max()) or 1.0) * 0.55

        n = len(views)
        fig = plt.figure(figsize=(size / 100.0 * n, size / 100.0), dpi=100)
        for i, (label, elev, azim) in enumerate(views):
            ax = fig.add_subplot(1, n, i + 1, projection="3d")
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
    except Exception:
        return None
