"""Track A regression suite — CadQuery shapes through the cadpy pipeline.

Tempdirs, real STEP generation, no mocks. These tests validate the
:mod:`cadpy.step_export_cadquery` module and the duck-typed dispatch in
:func:`cadpy.generation._normalize_step_payload`.

See ``docs/panda-interfaces.md`` §1 for the contract.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path


PACKAGE_SRC = Path(__file__).resolve().parents[1] / "src"
if str(PACKAGE_SRC) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SRC))

from cadpy import generation
from cadpy.step_export_cadquery import (
    build_cadquery_step_scene,
    export_cadquery_step_scene,
    is_cadquery_shape,
)
from cadpy.step_scene import LoadedStepScene


# --- helpers ----------------------------------------------------------------


def _face_center_table(wrapped) -> dict[int, tuple[float, float, float]]:
    """Return {face_ordinal → (cx, cy, cz)} for the OCCT shape.

    Face ordinals come from ``TopExp.MapShapes_s`` over ``TopAbs_FACE``
    (the same source the cadpy topology pipeline uses for `@cad[...#f<n>]`
    refs).
    """
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp
    from OCP.TopoDS import TopoDS
    from OCP.TopTools import TopTools_IndexedMapOfShape

    face_map = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(wrapped, TopAbs_FACE, face_map)
    table: dict[int, tuple[float, float, float]] = {}
    for i in range(1, face_map.Extent() + 1):
        face = TopoDS.Face_s(face_map.FindKey(i))
        props = GProp_GProps()
        BRepGProp.SurfaceProperties_s(face, props)
        com = props.CentreOfMass()
        table[i] = (round(com.X(), 6), round(com.Y(), 6), round(com.Z(), 6))
    return table


def _top_face_ordinal(face_table: dict[int, tuple[float, float, float]]) -> int:
    """Return the ordinal of the face whose centroid has the largest +Z."""
    return max(face_table.items(), key=lambda kv: kv[1][2])[0]


# --- tests ------------------------------------------------------------------


class CadqueryShapeNormalizationTests(unittest.TestCase):
    """Contract §1: library-agnostic resolution via duck-typing."""

    def test_normalize_step_payload_accepts_cq_workplane(self) -> None:
        import cadquery as cq

        box = cq.Workplane().box(20, 20, 5)
        envelope = generation._normalize_step_payload(box, script_path=Path("/tmp/x.py"))
        self.assertIn("shape", envelope)
        self.assertIs(envelope["shape"], box)

    def test_normalize_step_payload_accepts_cq_assembly(self) -> None:
        import cadquery as cq

        asm = cq.Assembly(name="root")
        asm.add(cq.Workplane().box(5, 5, 5), name="a")
        envelope = generation._normalize_step_payload(asm, script_path=Path("/tmp/x.py"))
        self.assertIn("shape", envelope)
        self.assertIs(envelope["shape"], asm)

    def test_normalize_step_payload_accepts_cq_shape(self) -> None:
        import cadquery as cq

        solid = cq.Workplane().box(5, 5, 5).val()  # cq.Solid (subclass of cq.Shape)
        self.assertTrue(hasattr(solid, "wrapped"))
        envelope = generation._normalize_step_payload(solid, script_path=Path("/tmp/x.py"))
        self.assertIn("shape", envelope)
        self.assertIs(envelope["shape"], solid)

    def test_normalize_step_payload_rejects_garbage(self) -> None:
        with self.assertRaises(TypeError):
            generation._normalize_step_payload("not a shape", script_path=Path("/tmp/x.py"))

    def test_is_cadquery_shape_predicate(self) -> None:
        import cadquery as cq

        self.assertTrue(is_cadquery_shape(cq.Workplane().box(1, 1, 1)))
        self.assertTrue(is_cadquery_shape(cq.Assembly(name="a")))
        self.assertFalse(is_cadquery_shape("not a shape"))
        self.assertFalse(is_cadquery_shape(object()))


class CadqueryStepExportTests(unittest.TestCase):
    """Round-trip: cq.Workplane → STEP + LoadedStepScene."""

    def test_simple_box_writes_step_and_scene(self) -> None:
        import cadquery as cq

        with tempfile.TemporaryDirectory(prefix="cadpy-cq-") as tempdir:
            output_path = Path(tempdir) / "box.step"
            box = cq.Workplane().box(20, 20, 5)
            scene = export_cadquery_step_scene(box, output_path)

            self.assertIsInstance(scene, LoadedStepScene)
            self.assertTrue(output_path.is_file())
            self.assertGreater(output_path.stat().st_size, 100)
            # The OCCT pipeline records the single solid as one root.
            self.assertEqual(1, len(scene.roots))
            self.assertEqual(1, len(scene.prototype_shapes))

    def test_box_with_hole_writes_step(self) -> None:
        import cadquery as cq

        with tempfile.TemporaryDirectory(prefix="cadpy-cq-") as tempdir:
            output_path = Path(tempdir) / "plate.step"
            part = cq.Workplane().box(20, 20, 5).faces(">Z").workplane().hole(8)
            scene = export_cadquery_step_scene(part, output_path)

            self.assertIsInstance(scene, LoadedStepScene)
            self.assertTrue(output_path.is_file())
            # Box-with-hole has 7 faces (4 sides + bottom + top + cylinder).
            face_table = _face_center_table(part.val().wrapped)
            self.assertEqual(7, len(face_table))

    def test_build_step_scene_without_writing_file(self) -> None:
        import cadquery as cq

        with tempfile.TemporaryDirectory(prefix="cadpy-cq-") as tempdir:
            output_path = Path(tempdir) / "box.step"
            box = cq.Workplane().box(20, 20, 5)
            scene = build_cadquery_step_scene(box, output_path, source_kind="python")

            # Scene is built from XCAF doc directly; no STEP file written.
            self.assertIsInstance(scene, LoadedStepScene)
            self.assertFalse(output_path.exists())
            self.assertEqual("python", scene.source_kind)


class CadqueryFaceIdStabilityTests(unittest.TestCase):
    """Contract §1: face-ID ordinals come from ``TopExp.MapShapes_s`` over the
    OCCT topology tree and are deterministic for a given CadQuery shape.
    """

    def test_box_top_face_ordinal_is_stable(self) -> None:
        import cadquery as cq

        cq_box = cq.Workplane().box(20, 20, 5)
        faces = _face_center_table(cq_box.val().wrapped)

        # A solid box has six faces; the top face (largest +Z centroid) is the
        # 6th ordinal in OCCT's traversal order.
        self.assertEqual(6, len(faces))
        self.assertEqual(6, _top_face_ordinal(faces))
        self.assertAlmostEqual(2.5, faces[_top_face_ordinal(faces)][2], places=4)

    def test_box_with_hole_top_face_ordinal_is_stable(self) -> None:
        """Box-with-hole — the top face (the one carrying the hole) has a
        stable ordinal derived purely from the OCCT topology tree.
        """
        import cadquery as cq

        cq_part = cq.Workplane().box(20, 20, 5).faces(">Z").workplane().hole(8)
        faces = _face_center_table(cq_part.val().wrapped)

        # Box-with-hole has 7 faces (4 sides + bottom + top + cylinder).
        self.assertEqual(7, len(faces))
        self.assertEqual(3, _top_face_ordinal(faces))


class CadqueryAssemblyExportTests(unittest.TestCase):
    """cq.Assembly walker produces a scene whose children carry the names
    we set, and the names survive into the STEP labels (XCAF).
    """

    def test_two_part_assembly_preserves_child_names(self) -> None:
        import cadquery as cq

        with tempfile.TemporaryDirectory(prefix="cadpy-cq-asm-") as tempdir:
            output_path = Path(tempdir) / "assembly.step"
            asm = cq.Assembly(name="dual")
            asm.add(
                cq.Workplane().box(5, 5, 5),
                name="left_box",
                loc=cq.Location((10, 0, 0)),
                color=cq.Color("red"),
            )
            asm.add(
                cq.Workplane().sphere(2.5),
                name="right_ball",
                loc=cq.Location((-10, 0, 0)),
                color=cq.Color("blue"),
            )

            scene = export_cadquery_step_scene(asm, output_path)

            self.assertTrue(output_path.is_file())
            self.assertIsInstance(scene, LoadedStepScene)

            # The cq.Assembly root walks into one root with two children.
            self.assertEqual(1, len(scene.roots))
            self.assertEqual(2, len(scene.roots[0].children))

            child_names = {str(c.name) for c in scene.roots[0].children}
            self.assertIn("left_box", child_names)
            self.assertIn("right_ball", child_names)

    def test_assembly_child_colors_round_trip(self) -> None:
        import cadquery as cq

        with tempfile.TemporaryDirectory(prefix="cadpy-cq-asm-") as tempdir:
            output_path = Path(tempdir) / "colored.step"
            asm = cq.Assembly(name="colored")
            asm.add(
                cq.Workplane().box(5, 5, 5),
                name="red_box",
                color=cq.Color("red"),
            )
            asm.add(
                cq.Workplane().box(5, 5, 5),
                name="blue_box",
                loc=cq.Location((10, 0, 0)),
                color=cq.Color("blue"),
            )

            scene = export_cadquery_step_scene(asm, output_path)

            # Colors land on prototype labels (or component labels — either
            # is acceptable for "colors survive").
            colors_seen: set[tuple[float, float, float, float]] = set()
            colors_seen.update(
                tuple(round(component, 3) for component in color)
                for color in scene.prototype_colors.values()
            )
            for root in scene.roots:
                for node in root.children:
                    if node.color is not None:
                        colors_seen.add(tuple(round(component, 3) for component in node.color))

            # Red and blue both wired through.
            self.assertTrue(
                any(round(r, 1) == 1.0 and round(g, 1) == 0.0 for r, g, _, _ in colors_seen),
                f"expected a red-ish color in {colors_seen}",
            )
            self.assertTrue(
                any(round(r, 1) == 0.0 and round(b, 1) == 1.0 for r, _, b, _ in colors_seen),
                f"expected a blue-ish color in {colors_seen}",
            )


class CadqueryGenerationDispatchTests(unittest.TestCase):
    """End-to-end through `_write_shape_step_payload`: a CadQuery shape
    routes through the new export path and the scene is marked as a python-
    backed shape payload.
    """

    def test_write_shape_step_payload_dispatches_to_cadquery_path(self) -> None:
        import cadquery as cq

        from cadpy.render import REPO_ROOT

        # The metadata writer requires `source_path` to be repo-relative
        # (no leading "/"). Place the temp script under REPO_ROOT so
        # `relative_to_repo()` yields a relative path.
        with tempfile.TemporaryDirectory(prefix="cadpy-cq-disp-", dir=REPO_ROOT) as tempdir:
            script_path = Path(tempdir) / "plate.py"
            script_path.write_text(
                "import cadquery as cq\n"
                "def gen_step():\n"
                "    return cq.Workplane().box(20, 20, 5)\n",
                encoding="utf-8",
            )
            output_path = script_path.with_suffix(".step")
            box = cq.Workplane().box(20, 20, 5)

            scene = generation._write_shape_step_payload(
                {"shape": box},
                output_path=output_path,
                script_path=script_path,
                logger=generation.CliLogger("test"),
                entry_kind="part",
            )

            self.assertIsInstance(scene, LoadedStepScene)
            self.assertEqual("part", getattr(scene, "text_to_cad_entry_kind", None))
            self.assertEqual("shape", getattr(scene, "step_payload_kind", None))
            self.assertEqual("python", getattr(scene, "source_kind", None))
            self.assertTrue(output_path.is_file())


if __name__ == "__main__":
    unittest.main()
