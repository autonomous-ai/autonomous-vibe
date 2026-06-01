# screw-boss

**Trigger:** load when the user asks for a screw boss, mounting post, M2/M3/M4
screw hole with a post, PCB standoff, "screw it into the base", or any
threaded fastener that needs a printed post for the screw to bite into.

## Why this exists (the mechanics)

A bare hole in a flat surface only has as much pull-out strength as one wall
thickness's worth of plastic. A boss extends the engagement length (typ 2-3x
screw diameter) and concentrates material around the fastener. For self-tap
into plastic the pilot hole equals the screw's minor diameter (smaller than the
clearance hole); for a machine-screw pass-through use the standard clearance
diameter. A counter-bored or countersunk top lets the head sit flush. Ribs
(3-4 fins at 45 degrees around the boss) prevent the post from snapping off
when side-loaded.

## CadQuery template

```python
import cadquery as cq

# Standard screw dimensions (M2 through M5).
SCREW_TABLE = {
    "M2":  {"clearance": 2.4, "self_tap": 1.7, "cap_head_dia": 3.8, "cap_head_h": 2.0},
    "M2.5":{"clearance": 2.9, "self_tap": 2.2, "cap_head_dia": 4.5, "cap_head_h": 2.5},
    "M3":  {"clearance": 3.4, "self_tap": 2.5, "cap_head_dia": 5.5, "cap_head_h": 3.0},
    "M4":  {"clearance": 4.5, "self_tap": 3.3, "cap_head_dia": 7.0, "cap_head_h": 4.0},
    "M5":  {"clearance": 5.5, "self_tap": 4.2, "cap_head_dia": 8.5, "cap_head_h": 5.0},
}

def make_screw_boss(part, p):
    """Add one or more screw bosses standing up from the current top face.
    Caller positions ``part`` so the boss base sits on +Z.

    Required params:
      screw_size        - "M2" | "M2.5" | "M3" | "M4" | "M5"
      boss_height       - how tall the post rises from the surface
      boss_od           - outer diameter (typ 2x screw clearance + 2 mm)
      hole_type         - "clearance" (for through-bolts) | "self_tap" (taps into plastic)
      countersink       - None | "cbore" (counter-bore) | "csink" (countersunk)
      cbore_depth       - when "cbore", how deep the head sits (typ 3-4 mm)
      rib_count         - 0 for no ribs, 4 for cross-pattern stiffening
      rib_height        - how tall the ribs are (typ 0.5x boss_height)
      rib_thickness     - typ 1.5-2 mm
      positions         - list of (x, y) tuples for boss centres
    """
    s = SCREW_TABLE[p.screw_size]
    hole_d = s["clearance"] if p.hole_type == "clearance" else s["self_tap"]

    # 1. Extrude the cylindrical bosses at each position.
    bosses = (
        part.faces(">Z").workplane()
        .pushPoints(p.positions)
        .circle(p.boss_od / 2.0)
        .extrude(p.boss_height)
    )

    # 2. Optionally add ribs as four thin boxes radiating from the boss.
    if p.rib_count:
        top_z = part.faces(">Z").val().Center().z
        for (x, y) in p.positions:
            for i in range(p.rib_count):
                angle = i * (360.0 / p.rib_count)
                rib = (
                    cq.Workplane("XY")
                    .box(p.boss_od / 2.0, p.rib_thickness, p.rib_height,
                         centered=(False, True, False))
                    .translate((x, y, top_z))
                    .rotate((x, y, 0), (x, y, 1), angle)
                )
                bosses = bosses.union(rib)

    # 3. Cut the hole and apply head treatment driven from the parent face
    #    (the original ``part`` top, now ``>Z[-2]`` since the bosses are
    #    higher). Selecting the boss tops directly would make ``pushPoints``
    #    re-apply world coordinates on every individual boss face.
    top = bosses.faces(">Z[-2]").workplane().pushPoints(p.positions)
    if p.countersink == "cbore":
        bosses = top.cboreHole(hole_d, s["cap_head_dia"] + 0.4, p.cbore_depth)
    elif p.countersink == "csink":
        bosses = top.cskHole(hole_d, s["cap_head_dia"] + 0.4, 90.0)
    else:
        bosses = top.hole(hole_d)

    return bosses
```

(Real CadQuery: ``.faces``, ``.workplane``, ``.pushPoints``, ``.circle``,
``.extrude``, ``.cboreHole``, ``.cskHole``, ``.hole``, ``.union``,
``.rotate`` for rib placement.)

## Boss diameter sizing rule

Outer diameter (OD) = `2 x screw_clearance + 2 x wall`, where `wall >= 1.5 mm`.

For M3 clearance (3.4 mm hole): OD >= 8.8 mm. Use **8-10 mm** in practice.
For M4 clearance (4.5 mm hole): OD >= 11.0 mm. Use **10-12 mm**.

## Pull-out strength rule

For self-tap into PLA/PETG, engagement length = `2 x screw_diameter`.

- M2: 4 mm engaged
- M2.5: 5 mm engaged
- M3: 6 mm engaged
- M4: 8 mm engaged
- M5: 10 mm engaged

If the boss is shorter than this, the screw strips on first fastening.

## Pitfalls

- Self-tap hole too big -> screw spins free; too small -> cracks the boss.
  Stick to the table.
- No ribs on tall bosses (height > 1.5x OD) -> boss snaps off when
  side-loaded.
- Cap-head counter-bore: cbore_depth must be deeper than cap_head_h or the
  screw sits proud.
- Print orientation: if the boss is parallel to layer lines, pull-out
  strength drops 50%. Orient so the screw axis is vertical (boss extrudes
  from the build plate upward).
- For PCB standoffs: separate the boss top from the PCB face by 0.5 mm
  using a tiny shoulder, so the screw clamps the PCB cleanly against the
  shoulder, not against a slightly-domed boss top.
- "Heat set insert" is a different pattern - see heat-set-insert-pocket.md.
