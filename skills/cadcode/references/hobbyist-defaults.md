# Hobbyist 3D printing defaults

Load this when you need real-world dimensions for fasteners, common
devices, bearings, or FDM print tolerances.

> SKILL.md's "Default assumptions" carries the quick headline numbers (M3/M4/M5
> clearance, 0.2/0.4 mm slop). **This file is the full canonical table** — the
> complete fastener / bearing / motor / phone / mount data lives here. When the
> two agree on a headline value, this file is the one to cite for anything
> device- or hardware-specific.

## FDM print tolerances (0.4mm nozzle, typical hobbyist printer)

(SKILL.md states the headline 0.2 mm press-fit / 0.4 mm hand-assembly slop;
this is the full table.)

| What | Slop to add to the hole | Notes |
|---|---|---|
| Press-fit hole (M3 screw) | +0.2 mm (so 3.4mm clearance) | Standard close-fit |
| Loose-fit hole (M3 bolt slips through) | +0.4 mm (3.6mm) | When you don't want any drag |
| Shaft press-fit (6mm shaft) | +0.2 mm (6.2mm) | Tight enough to stay; loose enough to insert by hand |
| Bearing seat (608, 22mm OD) | -0.05 mm (21.95mm) | press fit (interference) |
| Cable channel (USB-C connector) | +0.5 mm | Connector is ~9×3 mm; channel: 9.5×3.5 mm |
| Snap-fit lip | 0.3–0.5 mm interference | Plastic creep accommodates this |

## Wall thickness recommendations (FDM, 3 perimeters at 0.4mm)

| Use case | Min wall | Notes |
|---|---|---|
| Decorative / non-load-bearing | 1.2 mm | 3 perimeters |
| Functional enclosure | 2.0 mm | Stiff enough not to flex |
| Stressed bracket | 3.0 mm | Doubles as a print-time saver vs over-engineering |
| Vase / shell | 1.6–2.0 mm | Watertight, prints cleanly with spiral mode |
| Living hinge | 0.4–0.6 mm | Single perimeter, PETG/PP only |

## Fastener clearance holes (close-fit)

(SKILL.md carries the M3/M4/M5 quick defaults; this is the full table, incl.
heavy clearance, cap-head cbores, and imperial sizes.)

| Screw | Clearance hole | Heavy clearance | Notes |
|---|---|---|---|
| M3 | 3.4 mm | 3.6 mm | Cap-head: 6.0 mm cbore, 3.5 mm depth |
| M4 | 4.5 mm | 4.8 mm | Cap-head: 7.5 mm cbore, 4.5 mm depth |
| M5 | 5.5 mm | 5.8 mm | Cap-head: 9.5 mm cbore, 5.5 mm depth |
| M6 | 6.5 mm | 7.0 mm | |
| #4-40 | 3.2 mm | 3.5 mm | |
| #6-32 | 3.7 mm | 4.0 mm | |
| #8-32 | 4.4 mm | 4.7 mm | |

> Convention: cbore Ø = cap_head_Ø + 0.5 mm (rounded to nearest 0.5). The cadcode pattern docs match.

For *self-tap into plastic*: use a hole 0.3 mm smaller than the screw's
major thread diameter.

## Common bearings

| Bearing | OD × ID × thickness | Seat hole | Notes |
|---|---|---|---|
| 608ZZ (skate) | 22 × 8 × 7 mm | 21.95 mm | press fit (interference); cheap workhorse |
| 624ZZ | 13 × 4 × 5 mm | 13.1 mm | Small motor shafts |
| 6800 | 19 × 10 × 5 mm | 19.1 mm | Thin section |
| 6803 | 26 × 17 × 5 mm | 26.1 mm | Large hollow |

## Common motors

| Motor | Body | Shaft | Mount | Notes |
|---|---|---|---|---|
| NEMA17 | 42 × 42 × ~40 mm | 5 mm dia | 31 mm pattern, M3 | 3D-printer standard |
| NEMA23 | 56 × 56 × ~50 mm | 6.35 mm dia | 47 mm pattern, M5 | CNC stepper |
| BLDC 2204 | 28 mm dia × 14 mm | 5 mm thread | 16×19 mm | Drone motor |

## Phones (approximate body, no case)

| Model | H × W × D | Notes |
|---|---|---|
| iPhone 15 / 15 Pro | 147 × 71 × 8.25 mm | Pro has Camera Control button |
| iPhone 15 Plus | 161 × 78 × 7.8 mm | |
| iPhone 15 Pro Max | 160 × 77 × 8.25 mm | Heavier — stands need stable base |
| iPhone 16 family | similar to 15, ±0.5 mm | |
| Pixel 8 | 151 × 71 × 8.9 mm | |
| Pixel 8 Pro | 163 × 77 × 8.8 mm | |
| Samsung Galaxy S24 | 147 × 71 × 7.6 mm | |
| Samsung Galaxy S24 Ultra | 162 × 79 × 8.6 mm | |

Round to nearest 0.5 mm for printing; thinner phones are within FDM tolerance
of one another. The depth is the dimension that matters most for cradles.

**Add 4–6 mm to each dimension to accommodate a typical case.**

## Common mount patterns

| Standard | Pattern | Notes |
|---|---|---|
| GoPro 3-finger | 14 mm fingers, 5 mm gap, M5 bolt center | Universal action-cam mount |
| VESA 75 | 75 × 75 mm, M4 holes | Small monitors |
| VESA 100 | 100 × 100 mm, M4 holes | Mid-size monitors |
| ARCA Swiss | 38 mm wide, 45° dovetail flanks | Tripod plates |
| 1/4-20 tripod | 1/4" UNC thread | Cameras, lights |
| GridFinity baseplate | 42 × 42 mm cells, 7 mm tall | Workbench organization |

## Common doorbell / sensor bodies (approximate)

| Device | Body | Mount type |
|---|---|---|
| Eufy E340 doorbell | 135 × 47 × 26 mm | Standard wall plate |
| Ring Video Doorbell 4 | 127 × 62 × 28 mm | Two screws, ~70 mm apart |
| Wyze Cam v3 | 50 × 50 × 50 mm | Magnetic base |
| Nest Doorbell (battery) | 162 × 46 × 24 mm | Wall plate or chime mount |

## Sanity-check sizes

If your bbox dies dramatically outside these ranges for the part type, you
probably have a unit or radius/diameter mistake:

- Wall hook: 60–120 mm tall, 30–60 mm deep
- Phone stand: 100–150 mm tall, 70–100 mm deep, 100 g of plastic
- Drawer pull: 80–120 mm wide, 20–40 mm deep
- Cable clip: 20–40 mm
- Light switch cover: 70 × 115 mm (US single-gang) or 86 × 86 mm (UK)
- Light bulb shade: 60–150 mm dia
- Vase: 80–200 mm tall, 50–120 mm dia
- Hex tray cell: 15–30 mm flat-to-flat
- Drone arm: 80–200 mm long
- GoPro adapter plate: 40–60 × 20–40 × 4–6 mm

## Slicer XY compensation

Every fit in this doc assumes the printer is XY-calibrated within ±0.05 mm; stock i3-class printers measure +0.10 to +0.15 mm oversized. Use the slicer's "XY compensation" (PrusaSlicer / Bambu) or "horizontal expansion" (Orca / Cura) at −0.10 mm to land back at nominal.

## Elephant's foot

The first 2–3 layers squish wider on most FDM beds. For any press-fit, bearing, or magnet pocket whose open face is on the build plate, add a `0.4 × 45°` chamfer on the bottom edge so the wider layers don't crush the fit.
