# nut-trap

**Trigger:** load when the user asks for a nut trap, embedded nut, captive nut,
hex pocket, "trap an M3 nut", or any "screws threading into a standard nut
that's hidden inside the print".

## Why this exists (the mechanics)

A standard hex nut is dropped into a hex-shaped pocket inside the print, then a
screw inserted from the opposite side threads into the nut. The pocket walls
prevent the nut from spinning while the screw is tightened, so torque transfers
into the captured nut instead of stripping the plastic. Way cheaper than
heat-set inserts (a 100-pack of M3 nuts is around $3), no soldering iron
needed, and it works in any plastic since no heat is applied. Common in printer
parts, drone frames, modular hardware, and any joint that will be assembled and
disassembled repeatedly.

## CadQuery template

```python
import cadquery as cq

# Standard ISO hex nut dimensions: flat-to-flat (s) and thickness (m).
# Pocket flats are sized 0.2 mm wider than nominal for FDM clearance.
NUT_TABLE = {
    "M2":  {"flat": 4.0, "thick": 1.6, "pocket_flat": 4.2, "pocket_h": 1.8, "screw_clear": 2.4},
    "M2.5":{"flat": 5.0, "thick": 2.0, "pocket_flat": 5.2, "pocket_h": 2.2, "screw_clear": 2.9},
    "M3":  {"flat": 5.5, "thick": 2.4, "pocket_flat": 5.7, "pocket_h": 2.6, "screw_clear": 3.4},
    "M4":  {"flat": 7.0, "thick": 3.2, "pocket_flat": 7.2, "pocket_h": 3.4, "screw_clear": 4.5},
    "M5":  {"flat": 8.0, "thick": 4.0, "pocket_flat": 8.2, "pocket_h": 4.2, "screw_clear": 5.5},
    "M6":  {"flat": 10.0,"thick": 5.0, "pocket_flat": 10.2,"pocket_h": 5.2, "screw_clear": 6.5},
}

def make_nut_trap(part, p):
    """Cut a hex nut trap + matching screw clearance hole. Caller positions
    so the screw enters from +Y face and the nut is dropped in from +Z.

    Required params:
      nut_size       — "M2" | "M3" | "M4" | "M5" | "M6"
      open_face      — "top" (insert from +Z, requires bridging) | "side" (slide-in slot)
      screw_axis     — axis along which the screw enters: "X" | "Y" | "Z"
      total_thread_d — total depth the screw can engage past the nut
      part_depth     — span of the part along the slide-in axis (+X), used
                       to size the side-slide slot.
      positions      — list of nut centre coordinates (cx, cy) in the
                       part's local frame; cy here is the height up the
                       +Y screw face.
    """
    n = NUT_TABLE[p.nut_size]
    # Side-slide slot is the cleanest of the three insertion modes: no
    # bridging over the nut and no print pause -- the user just pushes
    # each nut in from the +X face after the print finishes.
    for (cx, cy) in p.positions:
        # 1. Coaxial screw clearance through the full thickness along the
        #    screw axis. Caller has oriented the part so the screw enters
        #    the +Y face.
        part = (
            part.faces(">Y").workplane(origin=(cx, 0, cy))
            .circle(n["screw_clear"] / 2)
            .cutThruAll()
        )
        # 2. Hex pocket: drop in from +Z, recessed by nut thickness so the
        #    nut sits flush below the +Z surface once captured.
        part = (
            part.faces(">Z").workplane(origin=(cx, cy, 0))
            .polygon(6, n["pocket_flat"], circumscribed=False)
            .cutBlind(-n["pocket_h"])
        )
        # 3. Slide-in slot from the +X face across to the hex pocket so the
        #    nut can be pushed in horizontally instead of dropped from
        #    above. Slot width = pocket flat-to-flat; slot length spans the
        #    full part depth along X (caller passes ``p.part_depth``).
        part = (
            part.faces(">X").workplane(origin=(0, cy, -n["pocket_h"] / 2))
            .rect(p.part_depth, n["pocket_flat"])
            .cutThruAll()
        )
    return part
```

(Real CadQuery: use `polygon(6, diameter, circumscribed=False)` for the
hex; `cutBlind` for the pocket depth; coaxial `hole` for the screw
clearance.)

## Insertion approaches

There are three ways to get the nut into the pocket:

1. **Top-drop with bridging**: pocket opens to +Z, screw enters from -Z.
   Requires the slicer to bridge over the nut after it's inserted. **Pause
   the print** at the right layer, drop in the nut, resume. Reliable but
   manual.
2. **Side-slide slot**: pocket opens to a side face via a slot. Slide the
   nut in horizontally. No print pause needed. Slot adds visual seam.
3. **Below-the-pocket roof**: pocket opens to -Z (down). Layers BRIDGE over
   the empty pocket. Drop the nut in from below before screwing. Works but
   the roof of the pocket needs good bridging settings.

## Pitfalls

- Pocket too tight: nut won't seat without forcing — risks splitting walls.
  Stick to `pocket_flat = nominal + 0.2 mm`.
- Pocket too loose: nut spins under torque, screw turns forever. Tighten
  by 0.1 mm if spinning.
- Pocket too shallow: nut sits proud, mating surface doesn't sit flat. Use
  pocket_h = nut_thick + 0.2 mm.
- Forgot the screw clearance hole: nut traps, screw can't reach. Drill the
  through-hole using .hole() through the nut centre, full depth.
- For top-drop: slicer must bridge ≥ pocket_flat distance. PETG bridges
  worse than PLA — make the pocket wider (1 extra mm) for PETG.
- Print orientation: hex pocket walls are nice and vertical, no overhang
  issues from the pocket itself. The screw hole through it may have a
  bridging step depending on orientation.
- Don't use a wing nut or square nut here — the hex pocket is sized for ISO
  metric hex only. For other shapes, build a custom pocket.
