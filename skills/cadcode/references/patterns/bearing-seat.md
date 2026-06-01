# bearing-seat

**Trigger:** load when the user asks for a bearing seat, "press a 608 in",
"holds an inline skate bearing", pulley, wheel bearing, motor mount with
bearing, 688 / 6800 / 6900-series, or any "rotating shaft needs a bearing".

## Why this exists (the mechanics)

Ball bearings have a strictly toleranced outer race that needs a
snug-but-not-crushing fit in its pocket. Too loose and the bearing wobbles
or the race spins in the pocket under load; too tight and the outer race
deforms inward, the balls bind, and the bearing is destroyed. For FDM the
working interference range is roughly +0.05 to +0.15 mm undersize on the
pocket diameter (i.e. pocket ~0.10 mm smaller than nominal OD). A small
shoulder (a lip beneath the outer race) supports the bearing so axial load
on the shaft doesn't push it through the part. Print orientation matters:
XY tolerance is tighter than Z because layer height quantises vertical
features, so always seat the bearing with its axis along Z — that puts the
circular pocket in the XY plane where the printer is most accurate.

## CadQuery template

```python
import cadquery as cq

# Standard radial ball bearings (outer Ø x inner Ø x thickness).
# Plus the FDM-tested press-fit pocket diameter and a recommended axial
# shoulder (lip beneath the outer race that prevents pass-through).
BEARING_TABLE = {
    # name   OD     ID    H     pocket_d   shoulder_id   shoulder_h
    "608":   {"od": 22.0, "id":  8.0, "h": 7.0, "pocket": 21.95, "shoulder_id": 12.0, "shoulder_h": 1.0},
    "608ZZ": {"od": 22.0, "id":  8.0, "h": 7.0, "pocket": 21.95, "shoulder_id": 12.0, "shoulder_h": 1.0},
    "624":   {"od": 13.0, "id":  4.0, "h": 5.0, "pocket": 12.95, "shoulder_id":  7.0, "shoulder_h": 0.8},
    "625":   {"od": 16.0, "id":  5.0, "h": 5.0, "pocket": 15.95, "shoulder_id":  9.0, "shoulder_h": 0.8},
    "688":   {"od": 16.0, "id":  8.0, "h": 5.0, "pocket": 15.95, "shoulder_id": 11.0, "shoulder_h": 0.8},
    "6800":  {"od": 19.0, "id": 10.0, "h": 5.0, "pocket": 18.95, "shoulder_id": 13.5, "shoulder_h": 0.8},
    "6803":  {"od": 26.0, "id": 17.0, "h": 5.0, "pocket": 25.95, "shoulder_id": 20.0, "shoulder_h": 0.8},
    "6900":  {"od": 22.0, "id": 10.0, "h": 6.0, "pocket": 21.95, "shoulder_id": 14.0, "shoulder_h": 1.0},
    "6901":  {"od": 24.0, "id": 12.0, "h": 6.0, "pocket": 23.95, "shoulder_id": 16.0, "shoulder_h": 1.0},
}

def make_bearing_seat(part, p):
    """Cut a bearing seat into ``part``. Caller positions so the bearing
    enters from +Z.

    Required params:
      bearing      - key into BEARING_TABLE (e.g. "608")
      lead_chamfer - chamfer on the rim to guide bearing in (typ 0.4-0.6)
      open_back    - True = bearing visible from -Z; False = closed back
      positions    - list of (x, y) tuples for seat centres
    """
    b = BEARING_TABLE[p.bearing]
    pocket_d   = b["pocket"]
    pocket_h   = b["h"] + 0.1            # 0.1 mm axial clearance
    shoulder_d = b["shoulder_id"]
    shoulder_h = b["shoulder_h"]

    for (x, y) in p.positions:
        # 1) Main pocket: pocket_d wide, depth = bearing height + 0.1
        part = (
            part.faces(">Z").workplane()
                .center(x, y)
                .circle(pocket_d / 2.0)
                .cutBlind(-pocket_h)
        )

        # 2) Shoulder relief BELOW the seat: a smaller through-cut so the
        #    outer race rests on the ledge while the inner race spins free.
        if p.open_back:
            # All the way through — caller's part must be thick enough.
            part = (
                part.faces(">Z").workplane()
                    .center(x, y)
                    .circle(shoulder_d / 2.0)
                    .cutThruAll()
            )
        else:
            # Closed back: relief is only shoulder_h deep past the pocket.
            part = (
                part.faces(">Z").workplane(offset=-pocket_h)
                    .center(x, y)
                    .circle(shoulder_d / 2.0)
                    .cutBlind(-shoulder_h)
            )

        # 3) Lead chamfer at the +Z opening so the bearing starts square.
        part = (
            part.faces(">Z").edges(
                cq.selectors.NearestToPointSelector((x, y, 0))
            ).chamfer(p.lead_chamfer)
        )

    return part
```

(Real CadQuery APIs: `workplane`, `circle`, `cutBlind`, `cutThruAll`,
`chamfer`, `NearestToPointSelector`.)

> **Calibration note:** these assume an XY-calibrated printer. Stock i3-class printers often over-extrude ~0.10 mm — print a 20 mm test cube, measure, and adjust slicer XY compensation if seats come out tight. If still loose, glue with CA or anaerobic retaining compound (Loctite 638).

## Why the shoulder matters

A bearing pressed into a flat-bottomed pocket has its inner AND outer race
both touching the bottom. The inner race can't rotate -> the whole bearing
spins in the pocket -> defeats the bearing. The shoulder MUST be smaller
than the outer race seat AND larger than the inner race (typically
OD - 8 to OD - 10 mm — use the table), sized to clear the seal/dust shield
but not touch the inner race, so it only contacts the outer race; the
inner race floats in the relief and can rotate freely.

## Pull-through prevention

For axial load (shaft pushing on the bearing), the shoulder holds the
bearing. shoulder_h >= 0.8 mm or it shears off under load. For higher
loads (skateboard wheels, e-bike hubs) use 1.5-2.0 mm and add a wall
thickness of at least 2.0 mm around the pocket OD.

## Pitfalls

- Forgot the shoulder -> both races contact the seat bottom -> bearing
  spins as one unit, no rotation between shaft and pocket.
- Shoulder ID too large (touches the outer race too) -> still binds.
- Pocket too tight (>0.15 mm undersize) -> bearing deforms -> balls bind
  -> bearing seized / destroyed.
- Pocket too loose (>0.05 mm oversize) -> bearing rattles -> race spins
  under load -> pocket wears out and the seat is permanently sloppy.
- No lead chamfer -> can't start the bearing into the pocket without
  forcing it crooked, which gouges the pocket wall.
- Wrong axis: print with bearing seat axis VERTICAL (along Z). Sideways
  printing makes the pocket oval because layer lines stack into visible
  ridges; Z-up keeps the circle in the XY plane where the printer is
  accurate.
- Press-fit bearings warm up during heavy use — leave at least 0.3 mm
  radial clearance around the OUTSIDE of the seat (between seat wall and
  the outer wall of the part) so the part doesn't crack from heat
  expansion.
- Don't use press fit if you need to disassemble the bearing — use a snap
  ring groove or a thru-hole + retaining washer + screws instead.
- Sealed bearings (608ZZ, 688-2RS) don't need lubrication; open bearings
  do, and they collect dust quickly in a printed seat.
- Stacking two bearings on one shaft: leave a >=0.5 mm gap between them
  (a spacer washer or a printed step) so they don't fight each other if
  the shaft isn't perfectly straight.
