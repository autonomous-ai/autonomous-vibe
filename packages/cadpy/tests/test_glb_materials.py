from __future__ import annotations

import sys
import unittest
from pathlib import Path


PACKAGE_SRC = Path(__file__).resolve().parents[1] / "src"
if str(PACKAGE_SRC) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SRC))

from cadpy.glb import _GlbBuilder


class GlbMaterialTests(unittest.TestCase):
    def test_materials_record_source_color_hint(self) -> None:
        builder = _GlbBuilder()

        source_index = builder.add_material((0.1, 0.1, 0.1, 1.0), source_color=True)
        fallback_index = builder.add_material((0.72, 0.72, 0.72, 1.0), source_color=False)

        materials = builder.json["materials"]
        self.assertEqual({"cadSourceColor": True}, materials[source_index]["extras"])
        self.assertEqual({"cadSourceColor": False}, materials[fallback_index]["extras"])


if __name__ == "__main__":
    unittest.main()
