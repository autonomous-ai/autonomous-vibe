"""Tests for the headless STL QA renderer (``cadpy.render_part``).

Covers the exterior multi-view render and the new interior cross-section render
used by ``scripts/review --section`` to see whether mating features actually
engage (peg in socket, tooth on solid, lip in groove). Geometry is built with
trimesh primitives so the test needs no cadquery kernel.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from cadpy.render_part import render_stl_section_to_png, render_stl_to_png


def _box_stl(tmp: Path) -> Path:
    trimesh = pytest.importorskip("trimesh")
    mesh = trimesh.creation.box(extents=(20.0, 10.0, 6.0))
    stl = tmp / "box.stl"
    mesh.export(str(stl))
    return stl


def test_render_exterior_png(tmp_path):
    out = render_stl_to_png(_box_stl(tmp_path), tmp_path / "box.png")
    assert out is not None
    assert Path(out).is_file() and Path(out).stat().st_size > 0


def test_render_section_png(tmp_path):
    out = render_stl_section_to_png(_box_stl(tmp_path), tmp_path / "sec.png", axis="x")
    assert out is not None
    assert Path(out).is_file() and Path(out).stat().st_size > 0


def test_render_section_each_axis(tmp_path):
    stl = _box_stl(tmp_path)
    for axis in ("x", "y", "z"):
        out = render_stl_section_to_png(stl, tmp_path / f"s_{axis}.png", axis=axis)
        assert out is not None, axis
        assert Path(out).is_file(), axis


def test_render_section_offset_outside_body_does_not_raise(tmp_path):
    # An offset far outside the body must not raise; it falls back to the other
    # half or yields None — never an exception.
    out = render_stl_section_to_png(
        _box_stl(tmp_path), tmp_path / "far.png", axis="z", offset=1000.0
    )
    assert out is None or Path(out).is_file()


def test_render_section_bad_axis_returns_none(tmp_path):
    assert (
        render_stl_section_to_png(_box_stl(tmp_path), tmp_path / "bad.png", axis="w")
        is None
    )


def test_render_missing_file_returns_none(tmp_path):
    assert render_stl_to_png(tmp_path / "nope.stl", tmp_path / "a.png") is None
    assert (
        render_stl_section_to_png(tmp_path / "nope.stl", tmp_path / "b.png", axis="x")
        is None
    )
