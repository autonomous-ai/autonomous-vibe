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


class CheckUnitTests(unittest.TestCase):
    def test_single_box_is_one_solid_no_warnings(self) -> None:
        shape = cq.Workplane("XY").box(10, 10, 10).val().wrapped
        self.assertEqual(checks.count_solids(shape), 1)
        self.assertEqual(checks.check_part(shape, "box"), [])

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
            self.assertEqual(result.get("warnings", []), [])
            meta = json.loads((tp / "out" / "model.step.json").read_text())
            self.assertNotIn("warnings", meta["validation"])

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


if __name__ == "__main__":
    unittest.main()
