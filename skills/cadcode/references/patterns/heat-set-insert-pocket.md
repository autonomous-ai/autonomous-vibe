# heat-set-insert-pocket

**Trigger:** load when the user asks for heat-set inserts, brass inserts,
threaded inserts, McMaster/Ruthex/Voron inserts, or any "screw that goes
into plastic many times without stripping".

## Why this exists (the mechanics)

A knurled brass insert heated to ~240 C with a soldering iron locally melts
the plastic around its knurls; the plastic reflows into the knurl pattern
and solidifies, locking the insert mechanically and giving you real
machine-threaded engagement in a 3D-printed part. Pull-out strength is
roughly 5-10x a self-tap into PLA, and you can re-torque a screw hundreds
of times without stripping. The pocket is a plain cylinder slightly deeper
than the insert (so it can sit flush) with a small wider relief at the rim
to catch displaced plastic. Critically, the pocket diameter is the insert's
*body* diameter (between the knurls), NOT the maximum knurl OD — the
knurls themselves must bite into solid plastic.

## CadQuery template

```python
import cadquery as cq

# Common heat-set insert dimensions (Ruthex / standard M-series; pocket
# diameter is the *body* of the insert, NOT the max-knurl OD).
HEATSET_TABLE = {
    "M2":   {"pocket_d": 3.2, "insert_len": 4.0, "relief_d": 4.0, "relief_h": 0.6},
    "M2.5": {"pocket_d": 3.7, "insert_len": 4.0, "relief_d": 4.5, "relief_h": 0.6},
    "M3":   {"pocket_d": 4.0, "insert_len": 5.7, "relief_d": 5.0, "relief_h": 0.6},
    "M4":   {"pocket_d": 5.6, "insert_len": 8.1, "relief_d": 6.5, "relief_h": 0.6},
    "M5":   {"pocket_d": 6.4, "insert_len": 9.5, "relief_d": 7.5, "relief_h": 0.6},
}

def make_heatset_pocket(part, p):
    """Cut a heat-set insert pocket into ``part``. Caller positions ``part``
    so the open face (where the iron enters) is the +Z face.

    Required params on ``p``:
      insert_size    -- "M2" | "M2.5" | "M3" | "M4" | "M5"
      bottom_clear   -- extra depth past the insert length (typ 1-2 mm)
      positions      -- list of (x, y) tuples for pocket centres
    """
    s = HEATSET_TABLE[p.insert_size]
    pocket_depth = s["insert_len"] + p.bottom_clear

    # Main pocket + rim relief in one call: cboreHole cuts the body-diameter
    # pilot deeper than the insert (so it seats flush) AND a shallow rim
    # counterbore that catches plastic the iron pushes upward.
    part = (
        part.faces(">Z").workplane()
            .pushPoints(p.positions)
            .cboreHole(
                diameter=s["pocket_d"],
                cboreDiameter=s["relief_d"],
                cboreDepth=s["relief_h"],
                depth=pocket_depth,
            )
    )

    return part
```

## Insert dimension table (Ruthex / common knurled brass inserts)

| Thread | Pocket Ø | Insert Len | Body OD | Knurl OD (≠ pocket Ø) |
|--------|----------|------------|---------|------------------------|
| M2     | 3.2 mm   | 4.0 mm     | 3.2 mm  | 3.4 mm                 |
| M2.5   | 3.7 mm   | 4.0 mm     | 3.7 mm  | 4.0 mm                 |
| M3     | 4.0 mm   | 5.7 mm     | 4.0 mm  | 4.6 mm                 |
| M4     | 5.6 mm   | 8.1 mm     | 5.6 mm  | 6.3 mm                 |
| M5     | 6.4 mm   | 9.5 mm     | 6.4 mm  | 7.1 mm                 |

The pocket Ø is the body Ø (between knurls), NOT the max-knurl Ø — the
knurls themselves bite INTO the plastic.

## Boss sizing around the pocket

Outer boss diameter >= `pocket_d + 2 * wall`, where `wall >= 2.5 mm`
(>= 3 mm for PLA — bare 2 mm walls split in practice on PLA).

- M2 insert: boss OD >= 8.2 mm
- M2.5 insert: boss OD >= 8.7 mm
- M3 insert: boss OD >= 9.0 mm
- M4 insert: boss OD >= 10.6 mm
- M5 insert: boss OD >= 11.4 mm

Less wall and the boss splits when the iron pushes the insert in (the
softened plastic has nowhere to go and pressure cracks the cold ring around
it). For bosses near a part edge, add wall on the thin side or chamfer
the corner so the crack path is longer.

## Pitfalls

- Pocket Ø too tight (used max-knurl Ø by mistake): insert won't go in
  straight, ends up tilted, threads cock relative to the screw axis.
- Pocket Ø too loose: insert spins under torque, no thread engagement,
  whole part is scrap.
- Pocket too shallow: insert sits proud of the surface, the mating lid
  won't close flat and clamps on the brass instead of the plastic.
- No rim relief: displaced plastic mounds up around the insert, screw
  heads sit on a bump and can't pull the joint tight.
- Wall too thin around the boss: boss splits visibly when the insert is
  pressed in — usually a vertical crack along a layer line.
- Top face print quality matters: the insert seats on the top layer, and
  if it's rough or stringy the insert tilts. Use 5+ top layers and turn
  on ironing if your slicer supports it.
- Iron temperature too high: melts a halo of plastic around the insert
  and the insert sinks too deep or droops sideways. Target 220-240 C for
  PLA, 260-280 C for PETG.
- ABS / PC: heat-sets work even better (higher glass transition gives a
  stronger reflowed bond), but use 300-320 C.
- Don't put a heat-set insert in TPU or other flexible filament — there
  is no rigid plastic for the knurls to bite into, the insert just sinks
  and wallows.
- Insert installed crooked: don't try to correct it once cold. Reheat
  with the iron on top of the insert, let it sink, re-seat with a flat
  surface (back of a caliper) pressing straight down.
- Don't put pockets on a face that prints against the build plate unless
  you flip the part — the open end of the pocket needs to be on a top
  face for the iron to reach it cleanly.
