"""End-to-end test for ``cadpy.generation.generate_step`` — the high-level
wrapper that the cadcode skill runner calls. Mirrors what the runner does
in production: a project dir with ``main.py``, a ``.step`` output path,
and explicit mesh tolerances.

The wrapper writes the contract §1 file set — ``.step`` (B-rep), ``.stl``
(printable + preview mesh, always written) and ``.step.json`` (metadata) —
and returns the dict the runner's ``_build_success_payload`` expects
(contract §3).
"""

from __future__ import annotations

import json
import math
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from textwrap import dedent


def _stl_triangle_count(stl_path: Path) -> int:
    """Read the triangle count from a binary STL header.

    A coarse tessellation (large angular deflection) yields few triangles on
    curved faces; a fine one yields many. Binary STL stores the triangle count
    as a little-endian uint32 right after the 80-byte header — a robust proxy
    for "are the circles round?" without decoding geometry.
    """
    data = stl_path.read_bytes()
    assert len(data) >= 84, "not a binary STL file"
    return struct.unpack_from("<I", data, 80)[0]


PACKAGE_SRC = Path(__file__).resolve().parents[1] / "src"
if str(PACKAGE_SRC) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SRC))

from cadpy import generation


class GenerateStepWrapperTests(unittest.TestCase):
    def _write_project(self, project_dir: Path, body: str) -> Path:
        main_py = project_dir / "main.py"
        main_py.write_text(dedent(body).lstrip(), encoding="utf-8")
        return main_py

    def test_simple_box_produces_full_artifact_set(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cadpy-wrap-") as tempdir:
            tempdir_p = Path(tempdir)
            project_dir = tempdir_p / "project"
            out_dir = tempdir_p / "out"
            project_dir.mkdir()
            out_dir.mkdir()

            self._write_project(
                project_dir,
                """
                import cadquery as cq

                def gen_step():
                    return cq.Workplane().box(20, 20, 5)
                """,
            )

            output_path = out_dir / "model.step"
            result = generation.generate_step(
                project_dir=project_dir,
                output_path=output_path,
                mesh_tolerance=0.05,
                mesh_angular_tolerance=3.0,
            )

            # Contract §1: STEP + STL + metadata always written.
            self.assertTrue(output_path.is_file(), "STEP missing")
            self.assertGreater(output_path.stat().st_size, 200)

            stl_path = out_dir / "model.stl"
            self.assertTrue(stl_path.is_file(), "STL missing")
            self.assertGreater(stl_path.stat().st_size, 100)

            # GLB / topology.json are no longer produced.
            self.assertFalse((out_dir / "model.glb").exists(), "GLB should not be written")
            self.assertFalse(
                (out_dir / "model.topology.json").exists(),
                "topology.json should not be written",
            )

            metadata_path = out_dir / "model.step.json"
            self.assertTrue(metadata_path.is_file(), "step.json missing")
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            self.assertEqual("cadpy", metadata["generator"])
            self.assertEqual("part", metadata["entryKind"])
            self.assertEqual("python", metadata["source"]["kind"])
            self.assertTrue(metadata["validation"]["isSolid"])
            # 20 * 20 * 5 = 2000 mm^3, with some tolerance.
            self.assertAlmostEqual(
                metadata["validation"]["volumeMm3"], 2000.0, delta=1.0
            )

            # Return dict: contract §3 keys the runner's
            # _build_success_payload reads. Paths come back resolved
            # (canonical) — on macOS that prepends ``/private/`` to temp
            # paths, so compare against the resolved test paths.
            self.assertEqual(str(output_path.resolve()), result["step_path"])
            self.assertEqual(str(stl_path.resolve()), result["stl_path"])
            self.assertEqual(str(metadata_path.resolve()), result["metadata_path"])
            self.assertNotIn("glb_path", result)
            self.assertNotIn("topology_path", result)
            self.assertTrue(result["is_solid"])
            self.assertAlmostEqual(result["volume_mm3"], 2000.0, delta=1.0)
            self.assertEqual(set(result["bbox"]), {"min", "max"})
            self.assertEqual(len(result["bbox"]["min"]), 3)

    def test_angular_tolerance_controls_hole_tessellation(self) -> None:
        """A fine angular tolerance must produce visibly rounder holes than a
        coarse one. ``mesh_angular_tolerance`` is the OCCT BRepMesh angular
        deflection in RADIANS; segments per circle ~= 2*pi / deflection. The
        faceted-holes bug fed 3.0 (intended as 3 *degrees*) straight in as 3
        *radians* (~172 deg) => essentially no angular refinement. Here we
        compare 3.0 rad (the broken value) against radians(3.0) (the fix),
        measured via the STL triangle count."""
        body = """
            import cadquery as cq

            def gen_step():
                return (
                    cq.Workplane("XY").box(30, 30, 30)
                    .faces(">Z").workplane().hole(10.0)
                )
        """

        def triangle_count(angular: float) -> int:
            with tempfile.TemporaryDirectory(prefix="cadpy-mesh-") as tempdir:
                tempdir_p = Path(tempdir)
                project_dir = tempdir_p / "project"
                out_dir = tempdir_p / "out"
                project_dir.mkdir()
                out_dir.mkdir()
                self._write_project(project_dir, body)
                generation.generate_step(
                    project_dir=project_dir,
                    output_path=out_dir / "model.step",
                    mesh_tolerance=0.05,
                    mesh_angular_tolerance=angular,
                )
                return _stl_triangle_count(out_dir / "model.stl")

        coarse = triangle_count(3.0)                 # old broken value (radians)
        fine = triangle_count(math.radians(3.0))     # the fix: 3 deg -> ~0.0524 rad

        # Fine tessellation should produce many more triangles than coarse.
        self.assertGreater(fine, coarse * 4, f"coarse={coarse} fine={fine}")

    def test_legacy_result_module_binding(self) -> None:
        """Back-compat per contract §1: ``result = <shape>`` is accepted."""
        with tempfile.TemporaryDirectory(prefix="cadpy-wrap-") as tempdir:
            tempdir_p = Path(tempdir)
            project_dir = tempdir_p / "project"
            out_dir = tempdir_p / "out"
            project_dir.mkdir()
            out_dir.mkdir()

            self._write_project(
                project_dir,
                """
                import cadquery as cq

                result = cq.Workplane().box(10, 10, 10)
                """,
            )

            output_path = out_dir / "legacy.step"
            result = generation.generate_step(
                project_dir=project_dir,
                output_path=output_path,
            )
            self.assertTrue(output_path.is_file())
            self.assertTrue((out_dir / "legacy.stl").is_file())
            self.assertTrue((out_dir / "legacy.step.json").is_file())
            self.assertFalse((out_dir / "legacy.glb").exists())
            self.assertTrue(result["is_solid"])

    def test_stl_is_always_written(self) -> None:
        """STL is the printable + preview deliverable and is always written,
        with or without an explicit envelope."""
        with tempfile.TemporaryDirectory(prefix="cadpy-wrap-") as tempdir:
            tempdir_p = Path(tempdir)
            project_dir = tempdir_p / "project"
            out_dir = tempdir_p / "out"
            project_dir.mkdir()
            out_dir.mkdir()

            self._write_project(
                project_dir,
                """
                import cadquery as cq

                def gen_step():
                    return {"shape": cq.Workplane().box(5, 5, 5)}
                """,
            )

            output_path = out_dir / "model.step"
            result = generation.generate_step(
                project_dir=project_dir,
                output_path=output_path,
            )
            stl_path = out_dir / "model.stl"
            self.assertTrue(stl_path.is_file(), "STL missing")
            self.assertGreater(stl_path.stat().st_size, 100)
            self.assertEqual(str(stl_path.resolve()), result["stl_path"])

    def test_missing_main_py_raises_generation_error(self) -> None:
        """Contract §1: every error must subclass GenerationError."""
        with tempfile.TemporaryDirectory(prefix="cadpy-wrap-") as tempdir:
            tempdir_p = Path(tempdir)
            project_dir = tempdir_p / "empty"
            project_dir.mkdir()
            with self.assertRaises(generation.GenerationError):
                generation.generate_step(
                    project_dir=project_dir,
                    output_path=tempdir_p / "out.step",
                )

    def test_invalid_return_type_raises_validation_error(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cadpy-wrap-") as tempdir:
            tempdir_p = Path(tempdir)
            project_dir = tempdir_p / "project"
            project_dir.mkdir()
            self._write_project(
                project_dir,
                """
                def gen_step():
                    return 42
                """,
            )
            with self.assertRaises(generation.ShapeValidationError):
                generation.generate_step(
                    project_dir=project_dir,
                    output_path=tempdir_p / "out.step",
                )


if __name__ == "__main__":
    unittest.main()
