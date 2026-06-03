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

## Use the helper

`cadlib` owns the geometry — don't re-derive it. The helper cuts the
press-fit pocket, the shoulder relief (open or closed back), and the lead
chamfer in one call:

```python
from cadlib.cutouts import add_bearing_seat

part = add_bearing_seat(
    part,
    positions=[(0, 0)],   # seat centres in the open_face plane
    bearing="608",        # key into BEARING_TABLE
    lead_chamfer=0.5,     # rim chamfer to start the bearing square (0.4–0.6)
    open_back=False,      # True → bearing visible from the back
    open_face=">Z",       # face the bearing presses in from
)
```

Bearing dimensions + the FDM-tested pocket/shoulder values live in
`cadlib/tables.py::BEARING_TABLE` (`608`, `608ZZ`, `624`, `625`, `688`,
`6800`, `6803`, `6900`). `Read` that file for the exact numbers; the helper
raises `ValueError` for an unknown bearing key.

## Why the shoulder matters

A bearing pressed into a flat-bottomed pocket has its inner AND outer race
both touching the bottom. The inner race can't rotate → the whole bearing
spins in the pocket → defeats the bearing. The shoulder MUST be smaller
than the outer race seat AND larger than the inner race (typically
OD − 8 to OD − 10 mm — the table's `shoulder_id`), sized to clear the
seal/dust shield but not touch the inner race, so it only contacts the
outer race; the inner race floats in the relief and can rotate freely.

## Pull-through prevention

For axial load (shaft pushing on the bearing), the shoulder holds the
bearing. `shoulder_h >= 0.8 mm` or it shears off under load. For higher
loads (skateboard wheels, e-bike hubs) the table's larger seats use
1.0 mm; add a wall thickness of at least 2.0 mm around the pocket OD.

## Pitfalls

- Forgot the shoulder → both races contact the seat bottom → bearing
  spins as one unit, no rotation between shaft and pocket. (The helper
  always cuts the shoulder — this is the failure mode of a hand-rolled
  flat pocket.)
- Pocket too tight (>0.15 mm undersize) → bearing deforms → balls bind
  → bearing seized / destroyed.
- Pocket too loose (>0.05 mm oversize) → bearing rattles → race spins
  under load → pocket wears out and the seat is permanently sloppy.
- Wrong axis: print with the bearing-seat axis VERTICAL (along Z). Sideways
  printing makes the pocket oval because layer lines stack into visible
  ridges; Z-up keeps the circle in the XY plane where the printer is
  accurate. (See `print-orientation.md`.)
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

> **Calibration note:** the pocket values assume an XY-calibrated printer.
> Stock i3-class printers often over-extrude ~0.10 mm — print a 20 mm test
> cube, measure, and adjust slicer XY compensation if seats come out tight.
> If still loose, glue with CA or anaerobic retaining compound (Loctite 638).
