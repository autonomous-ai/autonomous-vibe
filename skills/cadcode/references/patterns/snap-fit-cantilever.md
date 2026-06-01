# snap-fit-cantilever

**Trigger:** load when the user asks for a snap-fit lid, clip-on enclosure,
"snap together", removable cover with built-in retention, or any
plastic-on-plastic engagement that should hold without screws.

## Why this exists (the mechanics)

A cantilever snap is a beam fixed at one end with a catch nub at the free end.
Tip deflection under load: `y = (F * L^3) / (3 * E * I)`, with rectangular
`I = (b * h^3) / 12`. Stress at the root: `sigma = (3 * E * h * y) / (2 * L^2)`, so
strain `epsilon = (3 * h * y) / (2 * L^2)`. Material `E`: PLA ~3.5 GPa,
PETG ~2.0 GPa, ABS ~2.3 GPa, TPU ~0.05 GPa. Keep strain under ~1% for filled
PLA, ~2% for PETG/ABS, or the root crazes after a few insertions. Practical
rule: deflection-to-length ratio `y / L <= 0.1`, root thickness `h >= 1.5 mm`
for FDM, and the catch must protrude no more than the beam can clear within
that ratio (typically 0.5–1.5 mm).

## CadQuery template

```python
import cadquery as cq

def make_snap_cantilever(part, p):
    """Cut two relief slots to free a cantilever arm on the +Y face of
    ``part``, then add a catch nub at the tip. Caller must orient the
    workpiece so the engagement face is normal to +Y and the arm runs
    along +Z (root at the bottom, tip at the top).

    Required params (mm, on dict ``p``):
      snap_length        L  arm length from root to catch tip
      snap_thickness     h  arm thickness at the root (Y direction)
      snap_width         b  arm width (X direction)
      snap_catch_height     how proud the catch nub stands in +Y
      snap_catch_depth      Z-length of the catch nub itself
      snap_relief_width     slot width either side of the arm
      snap_relief_depth     how deep the relief slot cuts into the wall
      snap_lead_angle       degrees of lead-in chamfer (insertion side)
      snap_root_fillet      fillet radius at the root (stress relief)
    """
    L  = p.snap_length
    h  = p.snap_thickness
    b  = p.snap_width
    ch = p.snap_catch_height
    cd = p.snap_catch_depth
    rw = p.snap_relief_width
    rd = p.snap_relief_depth
    lead = p.snap_lead_angle
    fr = getattr(p, "snap_root_fillet", 0.5)

    # 1. Cut two vertical relief slots that bracket the arm.
    #    Workplane sits on the +Y face; X is across the wall, Z is up.
    slot_total_w = b + 2 * rw
    relief = (
        part.faces(">Y").workplane(centerOption="CenterOfBoundBox")
        .pushPoints([(-(b/2 + rw/2), L/2), ((b/2 + rw/2), L/2)])
        .rect(rw, L)
        .cutBlind(-rd)
    )

    # 2. Build the catch nub as a small box on the tip, then chamfer
    #    the insertion (top) edge for a soft lead-in and leave the
    #    retention (bottom) edge square for a positive bite.
    nub = (
        cq.Workplane("XZ")
        .box(b, cd, ch, centered=(True, False, False))
        .translate((0, 0, L - cd))
        # Move the nub out onto the +Y face of the wall.
        .translate((0, _wall_y(part) + ch / 2, 0))
    )
    # Lead-in chamfer: shave the top +Y edge of the nub.
    nub = nub.faces(">Z").edges(">Y").chamfer(ch * 0.9 / max(0.1,
        (1.0 / max(0.1, _tan_deg(lead)))))

    result = relief.union(nub)

    # 3. Fillet the inside corner where the arm meets the parent wall
    #    (both relief slot bottoms) to spread root stress.
    try:
        result = (
            result.faces("<Y[-2]")  # the slot floor
            .edges("|X")
            .edges("<Z")
            .fillet(fr)
        )
    except Exception:
        pass  # filleting tight inside corners can fail; skip if so

    return result


def _wall_y(part):
    """Return the +Y coordinate of the wall the snap is being cut into."""
    return part.faces(">Y").val().Center().y


def _tan_deg(deg):
    import math
    return math.tan(math.radians(deg))
```

## Parameter ranges

| Param | Reasonable range | Notes |
|---|---|---|
| snap_length | 8–15 mm | longer = lower insertion force, fatigues less |
| snap_thickness | 1.5–2.5 mm | base thickness; taper tip thinner for softer click |
| snap_width | 4–10 mm | wider = stiffer, scales force linearly |
| snap_catch_height | 0.5–1.5 mm | engagement depth; > 1.5 mm needs longer arm |
| snap_catch_depth | 1.0–2.0 mm | Z-length of the nub itself |
| snap_relief_width | 0.8–1.5 mm | must exceed printer XY tolerance + clearance |
| snap_relief_depth | wall_thickness | cut fully through or arm won't flex |
| snap_lead_angle | 25–35° | lead-in for one-handed insertion |
| snap_root_fillet | 0.3–1.0 mm | bigger is stronger but eats into clearance |

## Pitfalls

- Brittle materials (carbon-filled PLA, dry PETG, old ABS) fatigue in 5–20
  cycles. Double `snap_length` or switch the arm to PETG/PP only.
- Sharp inside corner at the root is the #1 failure site. Always add at
  least a 0.5 mm fillet; raise to 1.0 mm if the part will see >50 cycles.
- Relief slot too narrow (< 0.8 mm) fuses shut on an FDM printer and the
  arm becomes rigid — the snap then either won't insert or shears off.
- Catch on a non-removable face means the lid is permanent. If geometry
  is symmetric, emboss "PRESS" or an arrow on the release side.
- Print orientation: the bending axis (the `h` dimension) must lie in the
  XY plane. If `h` is vertical, layer lines run across the bend and the
  arm snaps clean off on first flex.
- For a sliding lid, a single snap lets the lid walk off the other end.
  Pair the snap with a hard stop, a second snap, or a captive rib.
- Don't put the catch nub right at the very tip; leave ~1 mm of beam past
  it or the lead-in chamfer eats the structural cross-section.
- Forgetting clearance: the mating pocket needs `snap_catch_height + 0.2 mm`
  of depth or the catch bottoms out before the nub engages.
- snap_catch_height MUST be less than the beam's max deflection y_max ≈ 0.1·L. With L=8 mm, a catch_height of 1.5 mm exceeds 0.8 mm clearance → insertion impossible without forcing.
