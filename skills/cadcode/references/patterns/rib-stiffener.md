# rib-stiffener

**Trigger:** load when the user asks for ribs, stiffeners, gussets, "make
this stronger without making it thicker", reinforced wall, braced boss,
or any "panel is too flexible / too weak" complaint.

## Why this exists (the mechanics)

Bending stiffness scales with the SECOND MOMENT OF AREA: for a thin plate
of thickness h, `I ∝ h³`. Doubling the wall thickness gives 8x the
stiffness but 2x the weight (and 2x the print time). A rib added
perpendicular to the bending axis raises the effective I by moving
material away from the neutral axis — same stiffness as a much thicker
wall for a fraction of the plastic. Rule of thumb: a rib of height
`= 4 x wall_thickness` gives roughly 10x the panel's bending stiffness.

## CadQuery template

```python
import cadquery as cq

def make_ribs(part, p):
    """Add vertical ribs perpendicular to a flat face of ``part``.
    Caller positions ``part`` so the ribs grow from its +Z face along +Z.

    Required params (mm):
      rib_count        - how many ribs to place
      rib_pitch        - centre-to-centre spacing along the panel
      rib_length       - rib length along the panel (X axis here)
      rib_height       - how far the rib stands proud (4x wall is good)
      rib_thickness    - rib width (0.6x wall is the sweet spot)
      rib_fillet       - fillet at the panel/rib junction (typ 0.5-1 mm)
      rib_taper        - degrees of taper, top narrower than base (0 = none)
      origin           - (x, y) of the first rib's centre on the +Z face
    """
    # Total span the ribs occupy, used to centre the group on ``origin``.
    span = (p.rib_count - 1) * p.rib_pitch
    x0, y0 = p.origin
    y_start = y0 - span / 2.0

    ribs = part
    for i in range(p.rib_count):
        yc = y_start + i * p.rib_pitch

        if p.rib_taper > 0:
            # Tapered rib (narrower top): chain two rectangles on stacked
            # workplanes so both wires land in the same pendingWires queue.
            import math
            shrink = p.rib_height * math.tan(math.radians(p.rib_taper))
            top_t = max(p.rib_thickness - 2.0 * shrink, 0.4)
            rib = (
                cq.Workplane("XY")
                .rect(p.rib_length, p.rib_thickness)
                .workplane(offset=p.rib_height)
                .rect(p.rib_length, top_t)
                .loft(combine=True)
            )
        else:
            rib = (
                cq.Workplane("XY")
                .rect(p.rib_length, p.rib_thickness)
                .extrude(p.rib_height)
            )

        # Position the rib so its base sits on the panel's +Z face.
        top_z = part.faces(">Z").val().Center().z
        rib = rib.translate((x0, yc, top_z))
        ribs = ribs.union(rib)

    # Fillet the rib-to-panel root edges. Select edges that lie on the
    # panel top face and are shared with the new ribs.
    if p.rib_fillet > 0:
        ribs = (
            ribs.faces(">Z[-2]")  # the panel face (now the 2nd-highest)
            .edges()
            .fillet(p.rib_fillet)
        )

    return ribs
```

(Real CadQuery: `.rect`, `.extrude`, `.loft`, `.add`, `.translate`,
`.union`, `.faces`, `.edges`, `.fillet`, `.workplane(offset=)`.)

## Sizing rules

- **Rib thickness**: `0.5-0.6 x wall_thickness`. Thicker ribs sink-mark
  the opposite face during injection moulding; for FDM, thicker is fine
  but wasteful and prints slower.
- **Rib height**: `<= 3x rib_thickness` for moulded parts (sink marks);
  FDM can go to `4-6x` without issue. So for a 2 mm wall: ribs
  1.0-1.2 mm thick x 4-8 mm tall.
- **Rib pitch (spacing)**: typically `5-10x rib_thickness`. Less = closer
  to a solid plate (wastes plastic); more = panel buckles between ribs.
- **Rib fillet at root**: `>= 0.5 mm`. Without it, the panel cracks at
  the rib-to-panel junction under repeated load (stress concentration).
- **Taper**: 1-2 degrees makes injection moulding release easier and
  prints with marginally less material; not required for FDM.

## Two common configurations

1. **Parallel ribs**: ribs all aligned with one direction. Stiffens
   against bending around the perpendicular axis. Use when you know
   which way the panel will be loaded (e.g. a shelf bending down under
   weight — run ribs front-to-back).
2. **Cross-rib grid**: ribs in both X and Y. Stiffens against bending in
   any direction. Use when load direction is unknown. Roughly 1.6x the
   stiffness of parallel ribs for ~2x the material.

For a boss reinforcement: ribs should radiate FROM the boss outward at
3-4 equal angles (cross pattern). One rib only stiffens against one
load direction.

## Pitfalls

- Forgotten root fillet -> panel cracks at the rib root under cyclic
  load. The sharp inside corner is a textbook stress concentrator.
- Rib too tall and thin -> the rib itself buckles laterally before it
  does any work. Keep `rib_height <= 8 x rib_thickness`.
- Rib oriented PARALLEL to the bending axis -> does nothing. The rib has
  to cross the bending neutral axis to add I.
- Print orientation: print with the panel flat and ribs growing UP from
  the build plate. Ribs printed sideways are weak across layer lines and
  delaminate at the rib root under load.
- Don't fillet the TOP of the rib — looks nice but adds nothing
  structurally and wastes a fillet operation that can fail when edges
  are too short.
- Hidden trap: a tall rib near the edge of a thin panel shifts the
  panel's stiffness asymmetrically and warps it during cooling. Add
  ribs symmetrically about the panel centre, or expect bowing.
- Ribs spaced too tightly (`< 3 x thickness`) trap heat between them
  during FDM printing, causing the panel underneath to over-extrude and
  bulge. Honour the `5-10x` pitch rule.
