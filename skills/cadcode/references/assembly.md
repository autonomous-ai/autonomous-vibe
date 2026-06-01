# Multi-part designs with `cq.Assembly`

**Trigger:** load when the design has **physically separate parts** —
lid + base, hinge halves, removable cover, screw-on cap, robot chassis +
wheels, PCB + enclosure, body + button + dial. Anything the user prints
as multiple pieces and assembles after.

For a single-piece print (one solid that comes off the bed in one go), do
NOT use Assembly — just `.union()` everything into a single `result`.
Assembly is for parts that should ship as separate STLs.

## Why `cq.Assembly`, not `union` for these

A unioned multi-part model:

- exports as one fused STL that the user must split in the slicer (lossy,
  loses tolerance, breaks parametric clearances);
- can't have **interference fits, clearances, or motion** between parts
  because they're literally one solid;
- buries the per-part logic in a single chain.

`cq.Assembly` keeps each part as its own solid with its own placement,
exports each piece separately (or together), preserves color/material
metadata, and renders the assembled view for visual QC.

## Canonical pattern

```python
import cadquery as cq

# --- Parts: each is a plain Workplane built around its own origin ---

def make_base(p):
    """Box with floor, screw bosses, port cutouts. Built at origin, lid
    side at +Z."""
    base = (
        cq.Workplane("XY")
        .box(p.length, p.width, p.height)
        .faces(">Z").shell(-p.wall)
    )
    base = add_screw_bosses(base, p)
    base = add_port_cutouts(base, p)
    return base

def make_lid(p):
    """Matching lid. Built at origin, mating side at -Z."""
    lid = (
        cq.Workplane("XY")
        .box(p.length, p.width, p.lid_thickness)
    )
    lid = add_lid_lip(lid, p)            # tongue that fits the base shell
    lid = add_lid_screw_holes(lid, p)
    return lid

# --- Assembly: place parts in the assembled-product frame ---

def make_assembly(p):
    assy = cq.Assembly()
    assy.add(make_base(p), name="base", color=cq.Color("gray"))
    assy.add(
        make_lid(p),
        name="lid",
        loc=cq.Location(cq.Vector(0, 0, p.height + p.lid_gap)),
        color=cq.Color("steelblue"),
    )
    return assy

# --- Required runner contract + per-part exports ---

p = Params()
assy = make_assembly(p)

# scripts/cad reads `result` and only knows how to render a Workplane.
# Hand it the assembled view as a single compound so the preview PNG and
# the canonical STL show the product as assembled.
result = cq.Workplane().add(assy.toCompound())

# scripts/cad does NOT auto-split Assemblies into per-part STLs. Export
# each part to its own STL yourself, in the part-local frame (no Location),
# so the user can drop them straight into a slicer.
import os
out_dir = os.path.dirname(__file__)
cq.exporters.export(make_base(p), os.path.join(out_dir, "base.stl"))
cq.exporters.export(make_lid(p),  os.path.join(out_dir, "lid.stl"))
# Assembled STEP (preserves the placement metadata for FreeCAD / Fusion):
assy.save(os.path.join(out_dir, "assembly.step"))
```

What you actually get on disk after `scripts/cad`:

- `<project>.stl` — assembled view (good for sanity-check preview, NOT for
  printing the lid + base together — they're fused at this stage).
- `<project>.png` — assembled preview render.
- `<project>.step` — the runner's STEP of the fused compound.
- `base.stl`, `lid.stl` — your per-part exports, **these are what the
  user prints**.
- `assembly.step` — your separate assembly STEP with per-part metadata.

Tell the user in your handoff which STLs to print, not the assembled
preview STL.

## `cq.Location` placement

```python
cq.Location(cq.Vector(x, y, z))                       # translate only
cq.Location(cq.Vector(x, y, z), cq.Vector(0, 0, 1), 90)  # translate + rotate 90° about Z
```

The lid sits `p.lid_gap` above the base in the assembled view (typically
0.3–0.5 mm for FDM clearance). The exported lid STL is at the origin,
*not* at `z = height + gap` — the user only sees the assembled position in
the preview.

## When to split into separate parts (decision rule)

| Situation | Single solid (`union`) | Assembly |
|---|---|---|
| Part has no moving / removable pieces | ✓ | |
| Lid that opens / removes | | ✓ |
| Hinge with two halves | | ✓ |
| Snap-fit cover | | ✓ |
| Press-fit insert (printed) | | ✓ |
| Wheels / gears on a shaft | | ✓ |
| Decorative attached features | ✓ | |
| Robot chassis + motors + arms | | ✓ |

The rule: **if the user expects to print, hold, and assemble two pieces in
their hands, those are two parts.** If the model comes off the bed and is
done, it's one solid.

## Mating clearances are non-negotiable

When the design has parts that touch, plug in, or slide into each other,
the gap must be parameterised:

```python
class Params:
    lid_gap         = 0.4       # vertical clearance (lid sits this far above base rim)
    lid_lip_clear   = 0.3       # horizontal clearance (lip-to-shell on each side)
    shaft_clear     = 0.2       # for printed shafts in printed holes
    snap_clear      = 0.15      # snap-fit cantilever / catch
```

Each clearance gets bigger as the parts get bigger and on softer materials
(PETG, TPU). See `references/hobbyist-defaults.md` and the relevant
`references/patterns/*.md` for fit-specific values.

## Coordinate-frame discipline

Two frames coexist and getting them mixed is the #1 Assembly bug:

1. **Part-local frame** — each `make_*` builds at the origin with a clear
   convention (e.g., base sits with floor at -Z, mating face at +Z; lid
   sits with mating face at -Z). The exported STL uses this frame.
2. **Assembly frame** — `cq.Location(...)` places each part in the
   assembled product. The preview render and the assembled-STEP use this
   frame.

Never do "build the lid in assembled position then move it back to the
origin." Always build in the part-local frame; let the Assembly do the
placement.

## Per-part orientation for printing

The same part may want a different orientation in the assembled view vs.
on the print bed. Conventionally:

- The Assembly view shows the **assembled** orientation (lid on top, hinge
  pin axis horizontal, etc.).
- Each exported STL is in the **part-local** frame the `make_*` returned.
  The user re-orients in their slicer.

If a part has a strongly-preferred print orientation (e.g., threaded boss
axis must be vertical — see `references/patterns/print-orientation.md`),
build it in *that* frame so the exported STL is print-ready. The Assembly
then rotates it into the assembled view.

## Pitfalls

- **Forgetting clearances** → printed parts won't mate. Always parameterise
  the gap, never bake in 0.
- **Mating two parts whose mating faces are both at +Z** → they collide in
  the assembled view. One part's mating face needs to be at -Z, or
  rotate it 180° in the Assembly `Location`.
- **Putting hardware (M3 nuts, bearings) in the Assembly** as separate
  parts → useful for visual reference but they won't print. Mark them
  clearly: `assy.add(nut, name="m3_nut_REFERENCE_ONLY", color=cq.Color("gold"))`.
- **Asymmetric parts that look symmetric** (e.g., a lid with a single
  notch) → user can install them backwards. Add a visual cue (asymmetric
  chamfer, embossed arrow) or break the symmetry geometrically.
- **Exploded view ≠ assembly position.** If you want an exploded view for
  the user, render that separately; the canonical Assembly should always
  be in the *assembled* position so a sanity-check render shows the
  product as it will be.
