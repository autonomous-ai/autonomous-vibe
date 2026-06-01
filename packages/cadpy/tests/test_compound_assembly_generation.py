from __future__ import annotations

import sys
import tempfile
import unittest
import warnings
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


PACKAGE_SRC = Path(__file__).resolve().parents[1] / "src"
if str(PACKAGE_SRC) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SRC))

from cadpy import generation
from cadpy.metadata import parse_generator_metadata
from cadpy.step_export import _create_bin_xcaf_doc, export_build123d_step_scene
from cadpy.step_scene import LoadedStepScene, _bbox_from_shape, scene_leaf_occurrences, scene_occurrence_shape


class CompoundAssemblyGenerationTests(unittest.TestCase):
    def test_compound_with_explicit_children_is_discovered_as_assembly(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cadpy-compound-") as tempdir:
            script_path = Path(tempdir) / "robot_arm.py"
            script_path.write_text(
                "\n".join(
                    [
                        "from build123d import Compound",
                        "",
                        "def gen_step():",
                        "    parts = []",
                        "    assembly = Compound(",
                        "        obj=parts,",
                        "        children=parts,",
                        "        label='robot_arm_static_display_pose',",
                        "    )",
                        "    return assembly",
                        "",
                    ]
                ),
                encoding="utf-8",
            )

            metadata = parse_generator_metadata(script_path)

        self.assertIsNotNone(metadata)
        self.assertEqual("assembly", metadata.kind)

    def test_compound_with_literal_obj_sequence_is_discovered_as_assembly(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cadpy-compound-") as tempdir:
            script_path = Path(tempdir) / "compound_arm.py"
            script_path.write_text(
                "\n".join(
                    [
                        "from build123d import Box, Compound",
                        "",
                        "def gen_step():",
                        "    left = Box(1, 1, 1)",
                        "    right = Box(1, 1, 1)",
                        "    return Compound(obj=[left, right], label='compound_arm')",
                        "",
                    ]
                ),
                encoding="utf-8",
            )

            metadata = parse_generator_metadata(script_path)

        self.assertIsNotNone(metadata)
        self.assertEqual("assembly", metadata.kind)

    def test_childless_compound_obj_sequence_is_runtime_assembly(self) -> None:
        import build123d

        left = build123d.Box(1, 1, 1)
        right = build123d.Box(1, 1, 1)
        shape = build123d.Compound(obj=[left, right], label="compound_arm")

        self.assertEqual("assembly", generation._shape_payload_entry_kind(shape, fallback="part"))

    def test_labeled_childless_compound_does_not_warn_without_color(self) -> None:
        import build123d

        left = build123d.Box(1, 1, 1)
        right = build123d.Box(1, 1, 1)
        shape = build123d.Compound(obj=[left, right], label="compound_arm")

        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            _create_bin_xcaf_doc(shape)

        messages = [str(item.message) for item in caught]
        self.assertNotIn("Unknown Compound type, color not set", messages)

    def test_colored_child_shapes_survive_compound_assembly_export(self) -> None:
        import build123d

        with tempfile.TemporaryDirectory(prefix="cadpy-compound-") as tempdir:
            left = build123d.Box(1, 1, 1)
            left.label = "red_child"
            left.color = build123d.Color(1, 0, 0)
            right = build123d.Pos(2, 0, 0) * build123d.Box(1, 1, 1)
            right.label = "blue_child"
            right.color = build123d.Color(0, 0, 1)
            shape = build123d.Compound(children=[left, right], label="colored_assembly")

            scene = export_build123d_step_scene(
                shape,
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
        self.assertIn((1.0, 0.0, 0.0, 1.0), colors)
        self.assertIn((0.0, 0.0, 1.0, 1.0), colors)

    def test_nested_colored_compound_keeps_parent_transform(self) -> None:
        import build123d

        with tempfile.TemporaryDirectory(prefix="cadpy-compound-") as tempdir:
            child = build123d.Box(1, 1, 1)
            child.label = "motor_body"
            child.color = build123d.Color(0.1, 0.2, 0.3)
            nested = build123d.Compound(children=[child], label="imported_motor")
            placed = build123d.Pos(20, 0, 0) * nested
            placed.label = "placed_motor"
            root = build123d.Compound(children=[placed], label="arm")

            scene = export_build123d_step_scene(
                root,
                Path(tempdir) / "arm.step",
                text_to_cad_entry_kind="assembly",
            )

        leaves = scene_leaf_occurrences(scene)
        self.assertEqual(1, len(leaves))
        bbox = _bbox_from_shape(scene_occurrence_shape(scene, leaves[0]))
        self.assertGreater(bbox["min"][0], 19.0)
        self.assertLess(bbox["max"][0], 21.0)
        self.assertEqual(
            (0.1, 0.2, 0.3, 1.0),
            tuple(round(component, 3) for component in leaves[0].color),
        )

    def test_shape_payload_can_export_with_assembly_entry_kind(self) -> None:
        import build123d

        with tempfile.TemporaryDirectory(prefix="cadpy-compound-") as tempdir:
            script_path = Path(tempdir) / "robot_arm.py"
            script_path.write_text("def gen_step():\n    return None\n", encoding="utf-8")
            output_path = script_path.with_suffix(".step")
            scene = LoadedStepScene(step_path=output_path.resolve(), roots=[], prototype_shapes={})
            left = build123d.Box(1, 1, 1)
            right = build123d.Box(1, 1, 1)
            shape = build123d.Compound(children=[left, right], label="robot_arm")

            with (
                mock.patch.object(
                    generation,
                    "python_source_hash",
                    return_value=SimpleNamespace(
                        source_hash="hash-123",
                        source_fingerprint="fingerprint-123",
                    ),
                ),
                mock.patch.object(generation, "export_build123d_step_scene", return_value=scene) as export_scene,
            ):
                result = generation._write_shape_step_payload(
                    {"shape": shape},
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

    def test_artifact_outputs_use_runtime_shape_entry_kind(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cadpy-compound-") as tempdir:
            step_path = Path(tempdir) / "compound.step"
            script_path = Path(tempdir) / "compound.py"
            scene = LoadedStepScene(step_path=step_path.resolve(), roots=[], prototype_shapes={})
            scene.text_to_cad_entry_kind = "assembly"
            scene.source_kind = "python"
            scene.source_path = "compound.py"
            scene.source_hash = "source-hash"
            scene.source_fingerprint = "source-fingerprint"
            spec = generation.EntrySpec(
                source_ref="compound.py",
                cad_ref="compound",
                kind="part",
                source_path=script_path,
                display_name="compound",
                source="generated",
                step_path=step_path,
                script_path=script_path,
            )
            selector_bundle = generation.SelectorBundle(manifest={"stats": {}})

            with (
                mock.patch.object(generation, "_existing_topology_artifact_matches_spec_without_scene", return_value=False),
                mock.patch.object(generation, "_existing_topology_artifact_matches_options", return_value=False),
                mock.patch.object(generation, "_selector_options_for_part", return_value=generation.SelectorOptions()),
                mock.patch.object(generation, "mesh_step_scene"),
                mock.patch.object(generation, "scene_export_shape"),
                mock.patch.object(generation, "_reset_step_artifact_dir"),
                mock.patch.object(generation, "_run_artifact_jobs", return_value={"GLB/topology": selector_bundle}),
            ):
                result = generation._generate_part_outputs(
                    spec,
                    entries_by_step_path={step_path.resolve(): spec},
                    preloaded_scene=scene,
                    require_step_file=False,
                    force=True,
                )

        self.assertEqual("assembly", result.spec.kind)
        self.assertIs(result.selector_bundle, selector_bundle)


if __name__ == "__main__":
    unittest.main()
