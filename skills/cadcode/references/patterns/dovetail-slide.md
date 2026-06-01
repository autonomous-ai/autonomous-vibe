# dovetail-slide

**Trigger:** load when the user asks for a slide-on lid, dovetail joint,
sliding rail, T-slot mount, dovetail-mount drawer, modular mounting tab.

## Why this exists (the mechanics)

A dovetail is a trapezoidal cross-section: wider on the "inside" face,
narrower at the slot opening. The wedge angle (typically 7-15°) gives
lateral capture — the tab can only exit by sliding along the slot axis,
never by lifting perpendicular to it. Larger angle = stronger capture but
harder insertion and more stress on the slot walls; smaller angle = easier
to slide but the joint can lift under load. FDM printing requires generous
clearances (0.3-0.5 mm) because the trapezoidal walls are slanted and
slicer rounding plus elephant's-foot effects push the actual print fatter
than the model.

## CadQuery template

```python
import cadquery as cq
import math

def _trapezoid_points(width_base, height, angle_deg):
    """Return 4 points for a trapezoid centered on X, base on Y=0.

    width_base is the narrow side (slot opening / top of tab).
    The wide side sits at Y=height and is wider by 2*h*tan(angle).
    """
    half_base = width_base / 2.0
    overhang = height * math.tan(math.radians(angle_deg))
    half_top = half_base + overhang
    return [
        (-half_base, 0),
        ( half_base, 0),
        ( half_top,  height),
        (-half_top,  height),
    ]

def make_dovetail_male(p):
    """Build the male (tab) half: a trapezoid extruded along the slide axis.

    Required params (mm + degrees):
      dovetail_width_base   — narrow side of trapezoid (slot opening)
      dovetail_height       — depth of the trapezoid into the mating surface
      dovetail_length       — length along the slide axis
      dovetail_angle        — wedge angle (typ 10°)
      dovetail_clearance    — gap added to female slot (male stays nominal)
    """
    pts = _trapezoid_points(p.dovetail_width_base,
                            p.dovetail_height,
                            p.dovetail_angle)
    tab = (
        cq.Workplane("XY")
        .polyline(pts).close()
        .extrude(p.dovetail_length)
    )
    return tab

def make_dovetail_female(part, p, face=">Z"):
    """Cut the female (slot) into ``part`` on the selected face.

    The slot trapezoid is enlarged by ``dovetail_clearance`` on each face
    (both the slanted walls and the depth) so the male slides freely.
    """
    c = p.dovetail_clearance
    pts = _trapezoid_points(p.dovetail_width_base + 2 * c,
                            p.dovetail_height + c,
                            p.dovetail_angle)
    result = (
        part.faces(face).workplane()
        .polyline(pts).close()
        .cutBlind(-(p.dovetail_height + c))
    )
    return result
```

Real CadQuery APIs only: `polyline` + `close` + `extrude` is the canonical
way to build an arbitrary 2D profile and turn it into a solid. Use
`cutBlind` for a stopped slot (so the slide has a back wall) or
`cutThruAll` for a through-slot.

## Geometry rules

For a 10° dovetail with a 10 mm base (narrow / opening side):

- base (narrow, at the slot opening) = 10.0 mm
- top (wide, captured inside) = base + 2 × h × tan(angle)
- with h = 4 mm: top = 10.0 + 2 × 4 × tan(10°) = 10.0 + 2 × 4 × 0.1763 = **11.41 mm**
- the overhang on each side = h × tan(angle) = 4 × 0.1763 = **0.71 mm**

That 0.71 mm overhang per side is what mechanically captures the joint.
If clearance eats more than ~60% of it, the joint loses its lateral
capture — keep `dovetail_clearance < 0.4 × h × tan(angle)`.

## Parameter ranges

| Param | Reasonable range | Notes |
|---|---|---|
| dovetail_angle | 7–15° | 10° is the universal sweet spot |
| dovetail_height | 3–6 mm | depth into the surface |
| dovetail_width_base | 8–20 mm | smaller for compact mounts, bigger for load |
| dovetail_clearance | 0.3–0.5 mm | added to female slot on each face |
| dovetail_length | 10–100 mm | length along slide axis |

## Pitfalls

- Clearance too tight: tab won't slide in at all — slanted walls overshoot
  on FDM and the slot opening prints narrower than modeled. Start with
  0.4 mm clearance, sand or file only if needed; reprinting tighter is easy.
- Clearance too loose: tab rattles and the capture is weak. Better to aim
  for a tight fit plus a lead-in chamfer than to oversize the slot.
- Wedge angle below 5°: tab can pop out of the slot under load — the
  trapezoid is barely distinguishable from a rectangle and defeats the
  whole point of the dovetail.
- Wedge angle above 20°: tab requires excessive insertion force, concentrates
  stress at the sharp corners of the female slot, and can crack the slot
  walls — especially with low-infill or thin-wall prints.
- Print orientation matters: lay both parts so the slide axis is horizontal
  on the build plate and the trapezoidal cross-section faces up. Slanted
  walls steeper than 45° from vertical need supports — orient to avoid
  them on the visible faces.
- No end stop: without a stop feature, the tab slides straight through and
  out the other side. Add a pin, bump, or closed end to the female slot,
  or a shoulder on the male tab.
- No lead-in: square leading edges catch on the slot opening. Add a 1 mm ×
  45° chamfer (`.edges(">Y and >Z").chamfer(1.0)` on the male) to the
  leading edge of the tab so it self-aligns on insertion.
- Forgetting first-layer squish: the bottom 0.2 mm of both parts prints
  slightly wider (elephant's foot). If the slot opening is on the bottom
  face, add an extra 0.1-0.2 mm clearance or chamfer the bottom edge.
