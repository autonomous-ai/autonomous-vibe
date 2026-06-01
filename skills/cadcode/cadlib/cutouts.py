"""Press-fit pockets, magnet pockets, bearing seats, cable channels.

All helpers cut FROM an existing ``part``. They do not produce solids on
their own — pass the body to be modified as the first arg.
"""

from __future__ import annotations

import cadquery as cq

from cadlib.tables import BEARING_TABLE, MAGNET_TABLE


def add_press_fit_pocket(
    part: cq.Workplane,
    *,
    positions: list[tuple[float, float]],
    insert_diameter: float,
    insert_depth: float,
    interference: float = 0.05,
    lead_in_chamfer: float = 0.4,
    bottom_clearance: float = 0.3,
    open_face: str = ">Z",
) -> cq.Workplane:
    """Cut press-fit pockets sized for an insert (shaft, dowel, etc.).

    ``interference`` is undersize per nominal — default 0.05 mm matches
    a stock i3-class printer with ~0.10 mm horizontal-expansion. Tighten
    only after you've measured the printer.

    The pocket is ``insert_depth + bottom_clearance`` deep so the insert
    can fully seat without bottoming on plastic dust.
    """
    pocket_d = insert_diameter - interference
    depth = insert_depth + bottom_clearance
    part = (
        part.faces(open_face).workplane()
        .pushPoints(positions)
        .hole(pocket_d, depth=depth)
    )
    if lead_in_chamfer > 0:
        # Chamfer the rim of the pocket on each pocket. Use a circle-edge
        # filter so we don't chamfer the rest of the top face.
        part = part.faces(open_face).edges("%CIRCLE").chamfer(lead_in_chamfer)
    return part


def add_magnet_pocket(
    part: cq.Workplane,
    *,
    positions: list[tuple[float, float]],
    magnet_size: str = "10x3",
    fit_type: str = "slip",
    top_wall: float = 0.4,
    open_face: str = ">Z",
) -> cq.Workplane:
    """Cut neodymium-disc-magnet pockets, recessed by ``top_wall`` from
    ``open_face`` so the magnet sits hidden beneath a thin plastic skin.

    ``fit_type``: "slip" (+0.2 mm dia, glue with CA) | "press" (-0.1 mm,
    friction-only). Print orientation must keep ``top_wall`` as a bridge
    that prints well — see references/patterns/magnet-pocket.md.
    """
    if magnet_size not in MAGNET_TABLE:
        raise ValueError(
            f"unknown magnet_size {magnet_size!r}; use one of {sorted(MAGNET_TABLE)}"
        )
    if fit_type not in ("slip", "press"):
        raise ValueError(f"fit_type must be 'slip' or 'press', got {fit_type!r}")
    m = MAGNET_TABLE[magnet_size]
    pocket_d = m["d"] + (0.2 if fit_type == "slip" else -0.1)
    # Workplane offset INTO the body by top_wall, then hole the magnet depth.
    part = (
        part.faces(open_face).workplane(offset=-top_wall)
        .pushPoints(positions)
        .hole(pocket_d, depth=m["h"] + 0.1)
    )
    return part


def add_bearing_seat(
    part: cq.Workplane,
    *,
    positions: list[tuple[float, float]],
    bearing: str = "608",
    lead_chamfer: float = 0.5,
    open_back: bool = False,
    open_face: str = ">Z",
) -> cq.Workplane:
    """Cut a bearing seat (outer race press-fit + inner race relief
    shoulder) at each (x, y).

    ``open_back=True`` cuts the shoulder all the way through (for a
    shaft passing entirely through the part). ``open_back=False`` keeps a
    closed back behind the bearing — useful for end caps.
    """
    if bearing not in BEARING_TABLE:
        raise ValueError(
            f"unknown bearing {bearing!r}; use one of {sorted(BEARING_TABLE)}"
        )
    b = BEARING_TABLE[bearing]
    # Outer pocket (press fit on outer race)
    part = (
        part.faces(open_face).workplane()
        .pushPoints(positions)
        .hole(b["pocket"], depth=b["h"] + 0.1)
    )
    # Inner relief — keeps inner race spinning free
    if open_back:
        part = (
            part.faces(open_face).workplane()
            .pushPoints(positions)
            .hole(b["shoulder_id"])  # through-hole
        )
    else:
        part = (
            part.faces(open_face).workplane(offset=-(b["h"] + 0.1))
            .pushPoints(positions)
            .hole(b["shoulder_id"], depth=b["shoulder_h"])
        )
    if lead_chamfer > 0:
        part = part.faces(open_face).edges("%CIRCLE").chamfer(lead_chamfer)
    return part


def add_cable_channel(
    part: cq.Workplane,
    *,
    centerline: list[tuple[float, float]],
    cable_diameter: float = 4.5,
    channel_depth: float | None = None,
    channel_clearance: float = 0.4,
    open_face: str = ">Z",
) -> cq.Workplane:
    """Cut a U-shaped cable channel along ``centerline`` on ``open_face``.

    Channel is open-top (no lid). Phase-1 only supports STRAIGHT
    (two-point) centerlines; multi-segment polyline + sweep is phase 2.

    For a press-retained cable, use ``channel_clearance`` near 0. For a
    slip-fit, use 0.4 mm clearance and plan a lid separately.
    """
    import math
    if len(centerline) != 2:
        raise NotImplementedError(
            "add_cable_channel currently only supports a straight 2-point "
            f"centerline, got {len(centerline)} points"
        )
    depth = channel_depth if channel_depth is not None else cable_diameter * 0.9
    width = cable_diameter + channel_clearance
    (x1, y1), (x2, y2) = centerline
    length = math.hypot(x2 - x1, y2 - y1)
    if length <= 0:
        raise ValueError("centerline endpoints coincide")
    angle = math.degrees(math.atan2(y2 - y1, x2 - x1))
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    cutter = (
        cq.Workplane("XY")
        .rect(length, width)
        .extrude(depth + 1)              # +1 overcut to pierce cleanly
        .translate((cx, cy, 0))
        .rotate((cx, cy, 0), (cx, cy, 1), angle)
    )
    # Lift cutter to sit at the open_face top so it cuts downward from
    # the surface. For the default ">Z" we cut from the part's max Z.
    if open_face == ">Z":
        z_top = part.val().BoundingBox().zmax
        cutter = cutter.translate((0, 0, z_top - depth))
    elif open_face == "<Z":
        z_bot = part.val().BoundingBox().zmin
        cutter = cutter.translate((0, 0, z_bot - 1))
    return part.cut(cutter)
