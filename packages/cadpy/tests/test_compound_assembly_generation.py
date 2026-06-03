from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


PACKAGE_SRC = Path(__file__).resolve().parents[1] / "src"
if str(PACKAGE_SRC) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SRC))

from cadpy import generation
from cadpy.metadata import parse_generator_metadata
from cadpy.step_export_cadquery import export_cadquery_step_scene
from cadpy.step_scene import LoadedStepScene, _bbox_from_shape, scene_leaf_occurrences, scene_occurrence_shape


class CompoundAssemblyGenerationTests(unittest.TestCase):
    def test_assembly_via_local_name_is_discovered_as_assembly(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cadpy-asm-") as tempdir:
            script_path = Path(tempdir) / "robot_arm.py"
            script_path.write_text(
                "\n".join(
                    [
                        "import cadquery as cq",
                        "",
                        "def gen_step():",
                        "    asm = cq.Assembly(name='robot_arm')",
                        "    asm.add(cq.Workplane().box(1, 1, 1), name='a')",
                        "    return asm",
                        "",
                    ]
                ),
                encoding="utf-8",
            )

            metadata = parse_generator_metadata(script_path)

        self.assertIsNotNone(metadata)
        self.assertEqual("assembly", metadata.kind)

    def test_assembly_returned_directly_is_discovered_as_assembly(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cadpy-asm-") as tempdir:
            script_path = Path(tempdir) / "compound_arm.py"
            script_path.write_text(
                "\n".join(
                    [
                        "import cadquery as cq",
                        "",
                        "def gen_step():",
                        "    return cq.Assembly(name='compound_arm')",
                        "",
                    ]
                ),
                encoding="utf-8",
            )

            metadata = parse_generator_metadata(script_path)

        self.assertIsNotNone(metadata)
        self.assertEqual("assembly", metadata.kind)

    def test_cq_assembly_is_runtime_assembly(self) -> None:
        import cadquery as cq

        asm = cq.Assembly(name="compound_arm")
        asm.add(cq.Workplane().box(1, 1, 1), name="left")
        asm.add(cq.Workplane().box(1, 1, 1), name="right", loc=cq.Location((2, 0, 0)))

        self.assertEqual("assembly", generation._shape_payload_entry_kind(asm, fallback="part"))

    def test_colored_child_shapes_survive_assembly_export(self) -> None:
        import cadquery as cq

        with tempfile.TemporaryDirectory(prefix="cadpy-asm-") as tempdir:
            asm = cq.Assembly(name="colored_assembly")
            asm.add(cq.Workplane().box(1, 1, 1), name="red_child", color=cq.Color(1, 0, 0))
            asm.add(
                cq.Workplane().box(1, 1, 1),
                name="blue_child",
                loc=cq.Location((2, 0, 0)),
                color=cq.Color(0, 0, 1),
            )

            scene = export_cadquery_step_scene(
                asm,
                Path(tempdir) / "colored_assembly.step",
                text_to_cad_entry_kind="assembly",
            )

        colors = {
            tuple(round(component, 3) for component in color)
            for color in scene.prototype_colors.values()
        }
        colors.update(
            tuple(round(component, 3) for component in node.color)
            for root in scene.roots
            for node in root.children
            if node.color is not None
        )

        self.assertEqual(1, len(scene.roots))
        self.assertEqual(2, len(scene.roots[0].children))
        self.assertTrue(
            any(round(r, 1) == 1.0 and round(g, 1) == 0.0 for r, g, _, _ in colors),
            f"expected a red-ish color in {colors}",
        )
        self.assertTrue(
            any(round(r, 1) == 0.0 and round(b, 1) == 1.0 for r, _, b, _ in colors),
            f"expected a blue-ish color in {colors}",
        )

    def test_nested_assembly_keeps_parent_transform(self) -> None:
        import cadquery as cq

        with tempfile.TemporaryDirectory(prefix="cadpy-asm-") as tempdir:
            motor = cq.Assembly(name="imported_motor")
            motor.add(cq.Workplane().box(1, 1, 1), name="motor_body", color=cq.Color(0.1, 0.2, 0.3))
            root = cq.Assembly(name="arm")
            root.add(motor, name="placed_motor", loc=cq.Location((20, 0, 0)))

            scene = export_cadquery_step_scene(
                root,
                Path(tempdir) / "arm.step",
                text_to_cad_entry_kind="assembly",
            )

        leaves = scene_leaf_occurrences(scene)
        self.assertEqual(1, len(leaves))
        bbox = _bbox_from_shape(scene_occurrence_shape(scene, leaves[0]))
        self.assertGreater(bbox["min"][0], 19.0)
        self.assertLess(bbox["max"][0], 21.0)

    def test_shape_payload_can_export_with_assembly_entry_kind(self) -> None:
        import cadquery as cq

        with tempfile.TemporaryDirectory(prefix="cadpy-asm-") as tempdir:
            script_path = Path(tempdir) / "robot_arm.py"
            script_path.write_text("def gen_step():\n    return None\n", encoding="utf-8")
            output_path = script_path.with_suffix(".step")
            scene = LoadedStepScene(step_path=output_path.resolve(), roots=[], prototype_shapes={})
            asm = cq.Assembly(name="robot_arm")
            asm.add(cq.Workplane().box(1, 1, 1), name="left")
            asm.add(cq.Workplane().box(1, 1, 1), name="right")

            with (
                mock.patch.object(
                    generation,
                    "python_source_hash",
                    return_value=SimpleNamespace(
                        source_hash="hash-123",
                        source_fingerprint="fingerprint-123",
                    ),
                ),
                mock.patch(
                    "cadpy.step_export_cadquery.export_cadquery_step_scene",
                    return_value=scene,
                ) as export_scene,
            ):
                result = generation._write_shape_step_payload(
                    {"shape": asm},
                    output_path=output_path,
                    script_path=script_path,
                    logger=generation.CliLogger("test"),
                    entry_kind="assembly",
                )

        self.assertIs(result, scene)
        self.assertEqual("assembly", export_scene.call_args.kwargs["text_to_cad_entry_kind"])
        self.assertEqual("assembly", getattr(scene, "text_to_cad_entry_kind", None))
        self.assertEqual("shape", getattr(scene, "step_payload_kind", None))

    def test_effective_spec_follows_runtime_shape_entry_kind(self) -> None:
        step_path = Path("/tmp/compound.step")
        scene = LoadedStepScene(step_path=step_path, roots=[], prototype_shapes={})
        scene.text_to_cad_entry_kind = "assembly"
        spec = generation.EntrySpec(
            source_ref="compound.py",
            cad_ref="compound",
            kind="part",
            source_path=Path("/tmp/compound.py"),
            display_name="compound",
            source="generated",
            step_path=step_path,
            script_path=Path("/tmp/compound.py"),
        )

        effective = generation._effective_step_spec_for_scene(spec, scene)

        self.assertEqual("assembly", effective.kind)
        self.assertEqual("part", spec.kind)


if __name__ == "__main__":
    unittest.main()
