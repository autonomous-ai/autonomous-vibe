"""STEP + STL export helpers.

The runner (``scripts/cad``) auto-exports the ``result`` to STEP + STL +
PNG, so for SINGLE-PART designs you do NOT need these helpers — just
assign ``result``. Use these in two cases:

1. **Multi-part designs** (Assembly): the runner only renders the
   compound preview. Call ``export_part_stl(part, "lid.stl")`` etc.
   for each printable part so the user gets per-part STLs.
2. **Manual control** of mesh tolerance for a single part (rare).
"""

from __future__ import annotations

from pathlib import Path

import cadquery as cq


def export_step_stl(
    obj: cq.Workplane,
    basename: str | Path,
    *,
    stl_tolerance: float = 0.1,
    stl_angular_tolerance: float = 5.0,
) -> tuple[Path, Path]:
    """Write ``basename.step`` and ``basename.stl`` next to each other.

    Returns the two written paths. ``basename`` may be absolute or relative.
    """
    p = Path(basename)
    step_path = p.with_suffix(".step")
    stl_path = p.with_suffix(".stl")
    cq.exporters.export(obj, str(step_path))
    cq.exporters.export(
        obj,
        str(stl_path),
        tolerance=stl_tolerance,
        angularTolerance=stl_angular_tolerance,
    )
    return step_path, stl_path


def export_part_stl(
    obj: cq.Workplane,
    path: str | Path,
    *,
    tolerance: float = 0.1,
    angular_tolerance: float = 5.0,
) -> Path:
    """Write a single STL. Use this for each printable part in a
    multi-part design, in the part-local frame (no assembly Location).
    """
    p = Path(path)
    cq.exporters.export(
        obj, str(p), tolerance=tolerance, angularTolerance=angular_tolerance,
    )
    return p
