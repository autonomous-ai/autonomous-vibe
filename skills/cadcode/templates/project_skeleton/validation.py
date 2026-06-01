"""Runtime checks on Params before any geometry is built.

Catches bad dimensions before paying a render cycle. Edit when you add
new constraints; do not silence failures.
"""

from __future__ import annotations

from params import Params


def validate_params(p: Params) -> None:
    # FDM printability
    assert p.wall >= 1.6, f"wall too thin for FDM: {p.wall} mm < 1.6 mm"
    assert p.fillet_radius < p.wall, (
        f"fillet {p.fillet_radius} would erode wall {p.wall}"
    )

    # Fastener spacing
    assert p.screw_margin > p.screw_boss_diameter / 2, (
        "screw_margin must clear the boss"
    )
    assert p.screw_boss_diameter > p.screw_diameter, (
        "screw boss must be wider than the screw"
    )

    # Footprint sanity
    assert p.width > 0 and p.depth > 0 and p.height > 0, "all dims positive"
    assert p.width >= 4 * p.wall, "width must clear two walls + margin"
    assert p.depth >= 4 * p.wall, "depth must clear two walls + margin"
