from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from OCP.StlAPI import StlAPI_Writer

from cadpy.render import REPO_ROOT, part_stl_path
from cadpy.step_scene import (
    LoadedStepScene,
    scene_export_shape,
    scene_leaf_occurrences,
    scene_occurrence_prototype_shape,
)


def _display_path(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return resolved.as_posix()


def export_part_stl_from_scene(step_path: Path, scene: LoadedStepScene, *, target_path: Path | None = None) -> Path:
    target_path = target_path or part_stl_path(step_path)
    export_shape_stl(scene_export_shape(scene), target_path)
    return target_path

def export_shape_stl(shape: object, target_path: Path) -> Path:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    writer = StlAPI_Writer()
    writer.ASCIIMode = False
    if not writer.Write(shape, str(target_path)):
        raise RuntimeError(f"Failed to write STL output: {_display_path(target_path)}")
    return target_path


def _safe_part_name(raw: str | None, seen: dict[str, int], *, fallback: str) -> str:
    """Slugify an occurrence name to a filesystem-safe stem and de-duplicate.

    Collisions get a ``-2``/``-3`` suffix so every part maps to a distinct file.
    """
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", (raw or "").strip()).strip("._-")
    if not base:
        base = fallback
    count = seen.get(base, 0) + 1
    seen[base] = count
    return base if count == 1 else f"{base}-{count}"


@dataclass(frozen=True)
class PartExport:
    """One per-part STL written for an assembly.

    ``name`` is the filesystem-safe stem shared by the STL and its JSON sidecar.
    ``source_name`` is the original occurrence name as authored (the assembly
    ``.add(name=...)``), before slugging — used to look up an author-supplied
    description. ``shape`` is the un-located OCCT prototype shape written to
    ``path`` (handed back so the caller can compute per-part geometry facts).
    """

    name: str
    source_name: str
    path: Path
    shape: object


def export_part_stls_from_scene(
    scene: LoadedStepScene, out_dir: Path
) -> list[PartExport]:
    """Write one STL per leaf occurrence, each in its own build frame (at origin).

    Used for assemblies so every named part is individually reviewable/printable
    alongside the assembled ``<stem>.stl``. Returns one :class:`PartExport` per
    named part in scene order. The scene's prototype shapes must already be
    meshed.
    """
    results: list[PartExport] = []
    seen: dict[str, int] = {}
    for index, node in enumerate(scene_leaf_occurrences(scene)):
        if node.prototype_key is None or node.prototype_key not in scene.prototype_shapes:
            continue
        source_name = node.name or node.source_name or ""
        name = _safe_part_name(source_name, seen, fallback=f"part{index + 1}")
        # Prototype (un-located) shape → part sits at its own build origin, not in
        # assembled position, so it is ready to drop on the print bed.
        shape = scene_occurrence_prototype_shape(scene, node)
        target_path = out_dir / f"{name}.stl"
        export_shape_stl(shape, target_path)
        results.append(
            PartExport(name=name, source_name=source_name, path=target_path, shape=shape)
        )
    return results
