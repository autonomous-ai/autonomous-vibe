# fillet-stress-relief

**Trigger:** load when the user reports a part broke at a corner, asks
about "making it stronger", asks for fillets, mentions stress
concentration, fatigue, or cracking under load.

## Why this exists (the mechanics)

A sharp internal corner concentrates stress by a factor Kt that diverges
as the corner radius goes to zero (Kt -> infinity for a perfect knife
edge). For a fillet of radius r at a step of width h, a useful estimate
is Kt ~ 1 + sqrt(h / r) for small r/h. Practically: a fillet with
r >= 0.5 * feature_width drops Kt below ~1.5 — most of the available
benefit. Going from r = 0.1 mm to r = 1 mm on a 4 mm step roughly halves
the peak stress (Kt drops from ~7 to ~3), which on a brittle FDM part
often means the difference between snapping on first use and surviving
hundreds of load cycles.

## Where fillets matter most (high priority)

1. **Junction of a cantilever to its mount** — boss/clip root. This is
   where every snap-fit, hook, or lever fails first.
2. **L-shaped intersections** where load runs around the corner —
   bracket inside corner, gusset roots.
3. **Holes near edges** — bone-shape relief or just a generous fillet
   around the hole rim, especially on the loaded side.
4. **Where a thin rib meets a thicker panel** — see `rib-stiffener.md`.
5. **Wherever a thread or hole runs out** of a feature — the run-out is
   a crack starter and almost always the failure point under repeated
   tightening.

## Where fillets are wasteful

- Top edges of external faces — purely cosmetic, no strength gain.
- Inside corners of pockets that never see load (e.g. decorative cavities,
  cable channels).
- Every-edge `.edges().fillet(1)` — blows part complexity, slows export,
  fragile to selector breakage on small geometry changes, and often
  triggers OCCT failures on tiny chamfer-adjacent edges.

## CadQuery template

```python
import cadquery as cq

def add_stress_relief_fillets(part, p):
    """Apply fillets only where mechanics suggest it matters. Caller
    supplies the part; selectors target specific edge sets.

    Required params:
      root_fillet_r       — radius at high-stress roots (typ 1.0-2.0 mm)
      hole_rim_fillet_r   — radius at hole edges (typ 0.4-0.8 mm)
      cosmetic_fillet_r   — optional, top edges (typ 0.3-0.5 mm or None)
    """
    # Internal corners visible from a known face — cantilever root, etc:
    part = part.faces(">Y").edges("|Z").fillet(p.root_fillet_r)
    # Hole rims (all circular edges):
    part = part.edges("%CIRCLE").fillet(p.hole_rim_fillet_r)
    if p.cosmetic_fillet_r:
        # Top face's perimeter only — exclude hole rims and other inner edges.
        part = part.faces(">Z").edges("not %CIRCLE").fillet(p.cosmetic_fillet_r)
    return part
```

Use real CadQuery selectors: `|Z` (edges parallel to Z, i.e. vertical),
`%CIRCLE` (circular edges), face selectors like `>Z` / `<Z` / `>Y` for
the face with the max/min coordinate along that axis. The kernel will
reject `fillet()` calls whose selector returns no edges or returns edges
too short for the requested radius — wrap calls in
`.faces(...).edges(...)` chains you have verified return what you expect.

## Sizing rule

For a high-stress corner where two features meet (h = thinner feature
thickness at that junction):

| Feature size (h) | Min fillet (r) | Best fillet (r) |
|---|---|---|
| 1 mm | 0.3 mm | 0.5 mm |
| 2 mm | 0.5 mm | 1.0 mm |
| 4 mm | 1.0 mm | 2.0 mm |
| 8 mm | 1.5 mm | 3.0 mm |

Past r = 0.5 * h, returns diminish quickly. Going larger mostly costs
material and print time without lowering Kt much further.

## Pitfalls

- **Fillet larger than the feature it sits on** -> CadQuery throws an
  OCCT error and the whole operation fails. If your wall is 2 mm thick,
  max fillet ~ 0.9 mm (you cannot fillet more than half the wall).
- **"Fillet everything"** — `.edges().fillet(r)` will hit an edge you
  did not mean to touch (a tiny chamfer edge, a sliver from a boolean)
  and the operation fails non-obviously. Prefer targeted selectors.
- **Filleting after a difference / cut** can crash when the cut produced
  tangent or zero-length edges. Fillet BEFORE the cut where possible,
  or fillet the cutting tool's edges first.
- **Sharp corners are not always wrong** — convex (outward) corners
  barely concentrate stress. Save fillet operations for concave
  (internal) corners where tension actually builds.
- **Print orientation matters**: a filleted internal corner can require
  support. If the fillet is at the root of an overhang, leave it sharp
  on the bottom side or add a 45-degree chamfer instead — chamfers
  print self-supporting and recover most of the Kt benefit.
- **Filleted edge across layer lines is still weak**: FDM parts crack
  along the layer interface regardless of fillet. Reorient the part so
  the load runs along filaments, not across them, before tuning radii.
- **Reread your part name**: corner cracks BEHIND the load face are the
  usual failure — the fillet must be on the LOADED (tension) side. A
  fillet on the compression face wastes material and does nothing.
