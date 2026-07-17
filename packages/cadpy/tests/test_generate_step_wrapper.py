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

    @staticmethod
    def _stl_z_range(stl_path: Path) -> tuple[float, float]:
        """Min/max Z over all vertices of a binary STL — used to assert a part
        is exported in its own build frame (near origin), not in assembled
        position."""
        data = stl_path.read_bytes()
        count = struct.unpack_from("<I", data, 80)[0]
        zs: list[float] = []
        offset = 84
        for _ in range(count):
            offset += 12  # skip the facet normal
            for _vertex in range(3):
                _x, _y, z = struct.unpack_from("<fff", data, offset)
                offset += 12
                zs.append(z)
            offset += 2  # attribute byte count
        return min(zs), max(zs)

    def test_assembly_writes_per_part_stls_at_origin(self) -> None:
        """An assembly result also emits one STL per named part, each in its
        own build frame, plus a ``parts`` array in metadata and the return
        dict (contract §1/§3 additive)."""
        with tempfile.TemporaryDirectory(prefix="cadpy-parts-") as tempdir:
            tempdir_p = Path(tempdir)
            project_dir = tempdir_p / "project"
            out_dir = tempdir_p / "out"
            project_dir.mkdir()
            out_dir.mkdir()

            # Two named parts. The lid is *placed* 50mm up in the assembly, but
            # its per-part STL must come back at its build origin (z≈0..2), not
            # at the assembled z≈50.
            self._write_project(
                project_dir,
                """
                import cadquery as cq

                def gen_step():
                    base = cq.Workplane().box(20, 20, 4)
                    lid = cq.Workplane().box(20, 20, 2)
                    assy = cq.Assembly()
                    assy.add(base, name="base")
                    assy.add(lid, name="lid", loc=cq.Location(cq.Vector(0, 0, 50)))
                    return assy
                """,
            )

            output_path = out_dir / "widget.step"
            result = generation.generate_step(
                project_dir=project_dir,
                output_path=output_path,
            )

            parts_dir = out_dir / "widget_parts"
            base_stl = parts_dir / "base.stl"
            lid_stl = parts_dir / "lid.stl"
            self.assertTrue(base_stl.is_file(), "base part STL missing")
            self.assertTrue(lid_stl.is_file(), "lid part STL missing")
            # Integrated STL still written.
            self.assertTrue((out_dir / "widget.stl").is_file())

            # Return dict carries the per-part list (contract §3 additive).
            returned = {p["name"]: p["stl_path"] for p in result["parts"]}
            self.assertEqual({"base", "lid"}, set(returned))
            self.assertEqual(str(base_stl.resolve()), returned["base"])

            # Metadata sidecar lists parts with sidecar-relative paths.
            metadata = json.loads((out_dir / "widget.step.json").read_text(encoding="utf-8"))
            meta_parts = {p["name"]: p["stlPath"] for p in metadata["parts"]}
            self.assertEqual(meta_parts["base"], "widget_parts/base.stl")
            self.assertEqual(meta_parts["lid"], "widget_parts/lid.stl")
            meta_json = {p["name"]: p["jsonPath"] for p in metadata["parts"]}
            self.assertEqual(meta_json["base"], "widget_parts/base.stl.json")
            self.assertEqual(meta_json["lid"], "widget_parts/lid.stl.json")

            # Each per-part STL gets its own JSON metadata sidecar (contract §1).
            base_meta = json.loads((parts_dir / "base.stl.json").read_text(encoding="utf-8"))
            self.assertEqual(base_meta["generator"], "cadpy")
            self.assertEqual(base_meta["entryKind"], "part")
            self.assertEqual(base_meta["name"], "base")
            self.assertEqual(base_meta["index"], 0)
            self.assertEqual(base_meta["partOf"], "widget")
            self.assertEqual(base_meta["stl"]["path"], "base.stl")
            self.assertEqual(base_meta["source"]["kind"], "python")
            self.assertIn("hash", base_meta["source"])
            self.assertIn("angularTolerance", base_meta["mesh"])
            self.assertTrue(base_meta["validation"]["isSolid"])
            self.assertGreater(base_meta["validation"]["volumeMm3"], 0.0)
            # 20 x 20 x 4 box → bounding-box dimensions.
            dims = base_meta["dimensionsMm"]
            self.assertAlmostEqual(dims[0], 20.0, places=3)
            self.assertAlmostEqual(dims[1], 20.0, places=3)
            self.assertAlmostEqual(dims[2], 4.0, places=3)
            self.assertEqual(base_meta["description"], "")
            lid_meta = json.loads((parts_dir / "lid.stl.json").read_text(encoding="utf-8"))
            self.assertEqual(lid_meta["index"], 1)
            self.assertEqual(lid_meta["name"], "lid")

            # The lid part is exported at its build origin (centered ~0), not at
            # the assembled z≈50.
            lid_lo, lid_hi = self._stl_z_range(lid_stl)
            self.assertLess(lid_hi, 10.0, f"lid not at origin: z=[{lid_lo}, {lid_hi}]")
            self.assertGreater(lid_lo, -10.0, f"lid not at origin: z=[{lid_lo}, {lid_hi}]")

    def test_single_solid_writes_no_parts(self) -> None:
        """A single-solid project produces no ``_parts`` dir and an empty/absent
        parts list — per-part export is assembly-only."""
        with tempfile.TemporaryDirectory(prefix="cadpy-parts-") as tempdir:
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
                    return cq.Workplane().box(10, 10, 10)
                """,
            )

            result = generation.generate_step(
                project_dir=project_dir,
                output_path=out_dir / "solid.step",
            )
            self.assertFalse((out_dir / "solid_parts").exists(), "no _parts dir expected")
            self.assertEqual([], result["parts"])
            metadata = json.loads((out_dir / "solid.step.json").read_text(encoding="utf-8"))
            self.assertNotIn("parts", metadata)

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
