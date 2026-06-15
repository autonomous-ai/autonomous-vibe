"""Tests for ``cadpy.checks`` — the deterministic geometry sanity checks that
flag floating bodies, slivers, and invalid B-reps after generation.

Two layers:
  * unit tests on ``count_solids`` / ``check_part`` with hand-built CadQuery
    shapes (fast, no STEP export),
  * end-to-end tests through ``generate_step`` proving warnings reach the
    result dict and the ``.step.json`` sidecar.
"""

from __future__ import annotations

import json
import math
import sys
import tempfile
import unittest
from pathlib import Path
from textwrap import dedent

PACKAGE_SRC = Path(__file__).resolve().parents[1] / "src"
if str(PACKAGE_SRC) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SRC))

import cadquery as cq

from cadpy import checks, generation


def _blocking(warnings: list) -> list:
    """Warnings that are real defects (error/warning), not advisory info."""
    return [w for w in warnings if w["severity"] != "info"]


class CheckUnitTests(unittest.TestCase):
    def test_single_box_is_one_solid_no_blocking_warnings(self) -> None:
        shape = cq.Workplane("XY").box(10, 10, 10).val().wrapped
        self.assertEqual(checks.count_solids(shape), 1)
        # A bare box is geometrically clean (no defects) but now carries the
        # advisory sharp_edges hint — its 12 raw arrises.
        self.assertEqual(_blocking(checks.check_part(shape, "box")), [])

    def test_bare_box_flags_twelve_sharp_convex_edges(self) -> None:
        shape = cq.Workplane("XY").box(10, 10, 10).val().wrapped
        self.assertEqual(checks.count_sharp_convex_edges(shape), 12)
        warnings = checks.check_part(shape, "box")
        sharp = [w for w in warnings if w["kind"] == "sharp_edges"]
        self.assertEqual(len(sharp), 1)
        self.assertEqual(sharp[0]["severity"], "info")
        self.assertEqual(sharp[0]["part"], "box")

    def test_partially_filleted_box_counts_only_remaining_arrises(self) -> None:
        # Softening only the 4 vertical arrises leaves the 8 horizontal
        # top/bottom arrises (planar top/bottom meeting planar sides at 90°).
        shape = (
            cq.Workplane("XY").box(20, 20, 10).edges("|Z").fillet(2.0).val().wrapped
        )
        self.assertEqual(checks.count_sharp_convex_edges(shape), 8)

    def test_fully_filleted_box_has_no_sharp_convex_edges(self) -> None:
        shape = cq.Workplane("XY").box(20, 20, 10).edges().fillet(1.5).val().wrapped
        self.assertEqual(checks.count_sharp_convex_edges(shape), 0)
        self.assertEqual(
            [w for w in checks.check_part(shape, "rounded") if w["kind"] == "sharp_edges"],
            [],
        )

    def test_concave_inner_corner_is_not_counted(self) -> None:
        # An L-shaped solid has interior (concave) arrises; those are not the
        # outer arrises a premium finish softens, so they must not be counted.
        l_shape = (
            cq.Workplane("XY")
            .box(20, 20, 10)
            .faces(">Z")
            .workplane()
            .center(5, 5)
            .rect(10, 10)
            .cutBlind(-10)
            .val()
            .wrapped
        )
        # The cut introduces concave arrises; the count reflects only convex
        # outer edges, so it must be strictly fewer than the total edge count.
        from OCP.TopAbs import TopAbs_EDGE
        from OCP.TopExp import TopExp
        from OCP.TopTools import TopTools_IndexedMapOfShape

        edge_map = TopTools_IndexedMapOfShape()
        TopExp.MapShapes_s(l_shape, TopAbs_EDGE, edge_map)
        self.assertLess(checks.count_sharp_convex_edges(l_shape), edge_map.Extent())

    def test_disjoint_union_flags_disconnected_bodies(self) -> None:
        a = cq.Workplane("XY").box(5, 5, 5)
        b = cq.Workplane("XY").box(5, 5, 5).translate((20, 0, 0))
        shape = a.union(b).val().wrapped
        self.assertEqual(checks.count_solids(shape), 2)
        warnings = checks.check_part(shape, "thing")
        kinds = {w["kind"] for w in warnings}
        self.assertIn("disconnected_bodies", kinds)
        disc = next(w for w in warnings if w["kind"] == "disconnected_bodies")
        self.assertEqual(disc["part"], "thing")
        self.assertEqual(disc["severity"], "error")

    def test_touching_union_fuses_to_one_solid(self) -> None:
        a = cq.Workplane("XY").box(5, 5, 5)
        c = cq.Workplane("XY").box(5, 5, 5).translate((4, 0, 0))
        shape = a.union(c).val().wrapped
        self.assertEqual(checks.count_solids(shape), 1)
        self.assertNotIn(
            "disconnected_bodies",
            {w["kind"] for w in checks.check_part(shape, "x")},
        )

    def test_tiny_solid_flags_sliver(self) -> None:
        # 0.5mm cube => 0.125 mm^3, below the 1.0 mm^3 sliver threshold.
        shape = cq.Workplane("XY").box(0.5, 0.5, 0.5).val().wrapped
        kinds = {w["kind"] for w in checks.check_part(shape, "tiny")}
        self.assertIn("sliver", kinds)


class CollisionUnitTests(unittest.TestCase):
    """``intersection_volume`` measures how much two placed solids interpenetrate.

    Zero for parts that merely touch at a shared mating face (a lid on a lip);
    positive only when one part's body sits inside another's.
    """

    def test_overlapping_boxes_report_intersection_volume(self) -> None:
        # Two 10mm cubes offset 5mm in X overlap in a 5x10x10 slab => 500 mm^3.
        a = cq.Workplane("XY").box(10, 10, 10).val().wrapped
        b = cq.Workplane("XY").box(10, 10, 10).translate((5, 0, 0)).val().wrapped
        self.assertAlmostEqual(checks.intersection_volume(a, b), 500.0, delta=1.0)

    def test_face_touching_boxes_have_negligible_intersection(self) -> None:
        # Offset exactly 10mm => the two cubes share a face but no volume.
        a = cq.Workplane("XY").box(10, 10, 10).val().wrapped
        b = cq.Workplane("XY").box(10, 10, 10).translate((10, 0, 0)).val().wrapped
        self.assertLess(
            checks.intersection_volume(a, b), checks.COLLISION_MIN_VOLUME_MM3
        )

    def test_disjoint_boxes_have_zero_intersection(self) -> None:
        a = cq.Workplane("XY").box(10, 10, 10).val().wrapped
        b = cq.Workplane("XY").box(10, 10, 10).translate((50, 0, 0)).val().wrapped
        self.assertEqual(checks.intersection_volume(a, b), 0.0)


class GenerateStepWarningTests(unittest.TestCase):
    def _run(self, project_dir: Path, out_dir: Path, body: str) -> dict:
        (project_dir / "main.py").write_text(dedent(body).lstrip(), encoding="utf-8")
        return generation.generate_step(
            project_dir=project_dir,
            output_path=out_dir / "model.step",
            mesh_tolerance=0.1,
            mesh_angular_tolerance=math.radians(3.0),
        )

    def test_clean_part_has_no_warnings(self) -> None:
        # A fully-softened part: no defects AND no sharp_edges hint, so the
        # warnings array stays empty end-to-end.
        with tempfile.TemporaryDirectory(prefix="cadpy-checks-") as td:
            tp = Path(td)
            (tp / "project").mkdir()
            (tp / "out").mkdir()
            result = self._run(
                tp / "project",
                tp / "out",
                """
                import cadquery as cq

                def gen_step():
                    return cq.Workplane("XY").box(20, 20, 10).edges().fillet(1.5)
                """,
            )
            self.assertEqual(result.get("warnings", []), [])
            meta = json.loads((tp / "out" / "model.step.json").read_text())
            self.assertNotIn("warnings", meta["validation"])

    def test_sharp_box_info_warning_persists_to_sidecar(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cadpy-checks-") as td:
            tp = Path(td)
            (tp / "project").mkdir()
            (tp / "out").mkdir()
            result = self._run(
                tp / "project",
                tp / "out",
                """
                import cadquery as cq

                def gen_step():
                    return cq.Workplane("XY").box(20, 20, 10)
                """,
            )
            sharp = [w for w in result.get("warnings", []) if w["kind"] == "sharp_edges"]
            self.assertEqual(len(sharp), 1)
            self.assertEqual(sharp[0]["severity"], "info")
            meta = json.loads((tp / "out" / "model.step.json").read_text())
            sidecar_kinds = {
                w["kind"] for w in meta["validation"].get("warnings", [])
            }
            self.assertIn("sharp_edges", sidecar_kinds)

    def test_floating_body_part_flags_and_persists_to_sidecar(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cadpy-checks-") as td:
            tp = Path(td)
            (tp / "project").mkdir()
            (tp / "out").mkdir()
            result = self._run(
                tp / "project",
                tp / "out",
                """
                import cadquery as cq

                def gen_step():
                    body = cq.Workplane("XY").box(20, 20, 10)
                    floater = cq.Workplane("XY").box(4, 4, 4).translate((40, 0, 0))
                    return body.union(floater)
                """,
            )
            kinds = {w["kind"] for w in result.get("warnings", [])}
            self.assertIn("disconnected_bodies", kinds)
            meta = json.loads((tp / "out" / "model.step.json").read_text())
            sidecar_kinds = {
                w["kind"] for w in meta["validation"].get("warnings", [])
            }
            self.assertIn("disconnected_bodies", sidecar_kinds)


class CollisionSceneTests(unittest.TestCase):
    """End-to-end: a ``cq.Assembly`` whose placed parts interpenetrate must
    surface a blocking ``collision`` warning; parts that mate (touch) or sit at a
    clearance gap must not."""

    def _run(self, project_dir: Path, out_dir: Path, body: str) -> dict:
        (project_dir / "main.py").write_text(dedent(body).lstrip(), encoding="utf-8")
        return generation.generate_step(
            project_dir=project_dir,
            output_path=out_dir / "model.step",
            mesh_tolerance=0.1,
            mesh_angular_tolerance=math.radians(3.0),
        )

    _ASSEMBLY = """
        import cadquery as cq

        def gen_step():
            base = cq.Workplane("XY").box(20, 20, 10)   # z in [-5, 5]
            lid = cq.Workplane("XY").box(20, 20, 10)
            asm = cq.Assembly()
            asm.add(base, name="base")
            asm.add(lid, name="lid", loc=cq.Location((0, 0, {dz})))
            return asm
    """

    def test_overlapping_parts_flag_blocking_collision(self) -> None:
        # lid dropped to z in [0, 10] => overlaps base by a 20x20x5 slab.
        with tempfile.TemporaryDirectory(prefix="cadpy-collide-") as td:
            tp = Path(td)
            (tp / "project").mkdir()
            (tp / "out").mkdir()
            result = self._run(
                tp / "project", tp / "out", self._ASSEMBLY.format(dz=5)
            )
            coll = [w for w in result.get("warnings", []) if w["kind"] == "collision"]
            self.assertEqual(len(coll), 1, result.get("warnings"))
            self.assertEqual(coll[0]["severity"], "error")
            meta = json.loads((tp / "out" / "model.step.json").read_text())
            self.assertIn(
                "collision",
                {w["kind"] for w in meta["validation"].get("warnings", [])},
            )

    def test_face_touching_parts_do_not_flag_collision(self) -> None:
        # lid at z in [5, 15] => rests on the base's top face (a real mate).
        with tempfile.TemporaryDirectory(prefix="cadpy-collide-") as td:
            tp = Path(td)
            (tp / "project").mkdir()
            (tp / "out").mkdir()
            result = self._run(
                tp / "project", tp / "out", self._ASSEMBLY.format(dz=10)
            )
            coll = [w for w in result.get("warnings", []) if w["kind"] == "collision"]
            self.assertEqual(coll, [], result.get("warnings"))

    def test_clearance_gap_parts_do_not_flag_collision(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cadpy-collide-") as td:
            tp = Path(td)
            (tp / "project").mkdir()
            (tp / "out").mkdir()
            result = self._run(
                tp / "project", tp / "out", self._ASSEMBLY.format(dz=10.4)
            )
            coll = [w for w in result.get("warnings", []) if w["kind"] == "collision"]
            self.assertEqual(coll, [], result.get("warnings"))


class ProjectDeclaredWarningTests(unittest.TestCase):
    """A project may return ``{"shape": ..., "warnings": [...]}`` to declare its
    own functional/assembly checks alongside the deterministic geometry ones."""

    def _run(self, project_dir: Path, out_dir: Path, body: str) -> dict:
        (project_dir / "main.py").write_text(dedent(body).lstrip(), encoding="utf-8")
        return generation.generate_step(
            project_dir=project_dir,
            output_path=out_dir / "model.step",
            mesh_tolerance=0.1,
            mesh_angular_tolerance=math.radians(3.0),
        )

    def test_functional_warning_reaches_result_and_sidecar(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cadpy-fnwarn-") as td:
            tp = Path(td)
            (tp / "project").mkdir()
            (tp / "out").mkdir()
            result = self._run(
                tp / "project",
                tp / "out",
                """
                import cadquery as cq

                def gen_step():
                    body = cq.Workplane("XY").box(20, 20, 10)
                    return {"shape": body, "warnings": [
                        {"part": "stand", "kind": "functional",
                         "detail": "puck connector won't fit the opening",
                         "severity": "warning"},
                    ]}
                """,
            )
            fn = [w for w in result.get("warnings", []) if w["kind"] == "functional"]
            self.assertEqual(len(fn), 1)
            self.assertEqual(fn[0]["part"], "stand")
            self.assertEqual(fn[0]["severity"], "warning")
            # Merged with — not replacing — the geometry checks (raw box → sharp_edges).
            kinds = {w["kind"] for w in result["warnings"]}
            self.assertIn("sharp_edges", kinds)
            meta = json.loads((tp / "out" / "model.step.json").read_text())
            sidecar_kinds = {w["kind"] for w in meta["validation"]["warnings"]}
            self.assertIn("functional", sidecar_kinds)

    def test_malformed_warnings_are_skipped_not_fatal(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cadpy-fnwarn-") as td:
            tp = Path(td)
            (tp / "project").mkdir()
            (tp / "out").mkdir()
            result = self._run(
                tp / "project",
                tp / "out",
                """
                import cadquery as cq

                def gen_step():
                    return {"shape": cq.Workplane("XY").box(20, 20, 10).edges().fillet(1.5),
                            "warnings": [
                                "not a dict",
                                {"kind": "functional"},                 # missing detail
                                {"detail": "no kind"},                  # missing kind
                                {"kind": "functional", "detail": "ok"}, # valid, defaults applied
                            ]}
                """,
            )
            fn = [w for w in result.get("warnings", []) if w["kind"] == "functional"]
            self.assertEqual(len(fn), 1)
            self.assertEqual(fn[0]["part"], "model")       # default
            self.assertEqual(fn[0]["severity"], "warning") # default

    def test_validate_assertion_surfaces_as_validation_failed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cadpy-fnwarn-") as td:
            tp = Path(td)
            (tp / "project").mkdir()
            (tp / "out").mkdir()
            (tp / "project" / "main.py").write_text(
                dedent(
                    """
                    import cadquery as cq

                    def gen_step():
                        assert 1.2 >= 2.0, "back wall 1.2 mm < 2.0 mm structural min"
                        return cq.Workplane("XY").box(10, 10, 10)
                    """
                ).lstrip(),
                encoding="utf-8",
            )
            with self.assertRaises(generation.ProjectShapeError) as ctx:
                generation.generate_step(
                    project_dir=tp / "project",
                    output_path=tp / "out" / "model.step",
                    mesh_tolerance=0.1,
                    mesh_angular_tolerance=math.radians(3.0),
                )
            self.assertIn("back wall 1.2 mm", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
