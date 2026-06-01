# press-fit-pocket

**Trigger:** load when the user asks for a press fit, interference fit, "tight
fit", shaft hole, bearing seat, magnet pocket, or any "press the part in and
have it stay" feature.

## Why this exists (the mechanics)

An interference fit retains the insert by elastic deformation: the printed
pocket is 0.05-0.2 mm smaller than the insert, and the plastic squeezes
around it on insertion. The FDM dimensional-accuracy floor is roughly 0.1 mm
(varies by printer, slicer, and shrinkage), so the working interference
range sits at +0.05 to +0.2 mm depending on insert size and material
stiffness. Larger inserts need proportionally LESS interference — a 22 mm
bearing seats happily at +0.10 mm, while an 8 mm shaft wants +0.20 mm.
Insertion force scales steeply with interference: over-shoot and the pocket
splits rather than seats.

## CadQuery template

```python
import cadquery as cq

def make_press_fit_pocket(part, p):
    """Cut a press-fit cavity into ``part``. Caller positions ``part`` so
    the face that receives the insert is at +Z, with the pocket center at
    the workplane origin.

    Required params (mm):
      insert_diameter    - nominal diameter of the thing going in
      insert_depth       - how deep the insert sits in the pocket
      interference       - undersize amount (NEGATIVE clearance, typ 0.05-0.2)
      lead_in_chamfer    - chamfer the rim to guide the insert (0.3-0.5)
      bottom_clearance   - extra hole depth so insert doesn't bottom-out (0.2-0.5)
    """
    hole_d = p.insert_diameter - p.interference
    hole_depth = p.insert_depth + p.bottom_clearance

    part = (
        part.faces(">Z")
        .workplane()
        .hole(hole_d, depth=hole_depth)
    )

    # Lead-in chamfer on the rim of the new hole. Select the circular edge
    # on the top face whose radius matches the pocket.
    part = (
        part.faces(">Z")
        .edges(cq.selectors.RadiusNthSelector(0))
        .chamfer(p.lead_in_chamfer)
    )
    return part


# Example: 608 bearing seat in a PLA bracket
bracket = cq.Workplane("XY").box(40, 40, 10)
bracket = make_press_fit_pocket(bracket, P(
    insert_diameter  = 22.0,   # 608 OD
    insert_depth     = 7.0,    # 608 width
    interference     = 0.05,   # PLA, large insert — see calibration note
    lead_in_chamfer  = 0.4,
    bottom_clearance = 0.3,
))
```

## Interference table

| Insert | Material | Interference | Notes |
|---|---|---|---|
| 3 mm steel pin / shaft | PLA / PETG | 0.15 mm | hole = 2.85 mm |
| 5 mm steel shaft | PLA / PETG | 0.20 mm | hole = 4.80 mm |
| 6 mm steel shaft | PLA / PETG | 0.20 mm | hole = 5.80 mm |
| 8 mm steel shaft | PLA / PETG | 0.20 mm | hole = 7.80 mm |
| 10 mm steel shaft | PLA / PETG | 0.15 mm | hole = 9.85 mm |
| 13 mm 624 bearing OD | PLA / PETG | 0.10 mm | hole = 12.90 mm |
| 19 mm 626 bearing OD | PLA | 0.10 mm | hole = 18.90 mm |
| 22 mm 608 bearing OD | PLA | 0.05 mm | hole = 21.95 mm |
| 22 mm 608 bearing OD | PETG (more flex) | 0.15 mm | hole = 21.85 mm |
| 26 mm 6000 bearing OD | PLA | 0.10 mm | hole = 25.90 mm |
| 6 mm x 3 mm magnet | PLA | 0.05 mm | hole = 5.95 mm dia x 3.05 mm deep |
| 8 mm x 3 mm magnet | PLA | 0.05 mm | hole = 7.95 mm dia x 3.05 mm deep |
| 10 mm x 3 mm magnet | PLA | 0.10 mm | hole = 9.90 mm dia x 3.05 mm deep |
| 6 mm x 2 mm magnet | PETG | 0.05 mm | hole = 5.95 mm dia x 2.05 mm deep |
| M3 heat-set insert | PLA / PETG | -0.1 (loose) | melts in - see heat-set-insert-pocket.md |
| M4 heat-set insert | PLA / PETG | -0.1 (loose) | melts in - see heat-set-insert-pocket.md |

> **Calibration note:** these assume an XY-calibrated printer (±0.05 mm). Stock i3-style printers often over-extrude 0.10–0.15 mm; print a 20 mm test cube and adjust slicer XY compensation if seats come out tight.

## Parameter ranges

| Param | Reasonable range | Notes |
|---|---|---|
| interference | 0.05-0.2 mm | smaller for big parts, larger for small parts |
| lead_in_chamfer | 0.3-0.6 mm | required - without it parts snag on the rim |
| bottom_clearance | 0.2-0.5 mm | so the part can fully seat without bottoming |
| wall thickness around pocket | >= 2 mm (>= 3 mm preferred) | thinner walls bulge and the fit loosens |
| insert_depth | >= 0.5 * insert_diameter | shorter pockets let the insert cock and pop out |

## Pitfalls

- Forgetting the lead-in chamfer - without it the part catches the rim
  and you cannot start insertion. 0.4 mm at 45 deg is the safe default.
- No bottom clearance - the part bottoms before fully seating, leaving a
  visible gap at the rim and a wobbly fit.
- Hex / square / D-shaft inserts: pocket needs the matching polygon
  (use `.polygon(n, dia)` or a custom 2D sketch), not a circle. Add the
  interference to the across-flats dimension, not the across-corners.
- PLA cracks at high interference on small features (>0.25 mm interference
  on a <10 mm pocket usually splits). Switch to PETG when you need a
  springier press-fit, or scale interference down.
- Tolerance drifts +-0.1 mm between printers and even between filament
  spools. Print a calibration coupon (a small block with the exact pocket)
  before committing to a large part if the fit is critical.
- Lateral wall thickness around the pocket must be >= 2 mm or the walls
  bulge outward during insertion and the fit goes loose after one
  insert/remove cycle.
- Layer-line anisotropy: holes printed vertically (axis along Z) come out
  slightly smaller than holes printed horizontally because of layer
  squish. If the bearing axis lies in the print plane, drop interference
  by ~0.05 mm.
- Do not press metal bearings into bare PLA pockets that will see heat
  (motor mounts, sunlit parts) - PLA creeps above 50 C and the fit loosens
  permanently. Use PETG, ABS, or a heat-set/glued metal sleeve.
- Re-inserting the same part repeatedly wears the pocket: each cycle
  shaves ~0.02 mm off the walls. Design for one-shot assembly, or use a
  threaded retainer / heat-set insert for serviceable joints.
