# cable-channel

**Trigger:** load when the user asks for cable routing, wire channel,
cable management, USB / power / sensor cable, strain relief, or
"hide the wires" inside an enclosure.

## Why this exists (the mechanics)

Cables need a routed path that keeps them off moving parts and provides
strain relief at entry/exit points. A simple U-channel cut into a
surface holds the cable by friction (if sized right) or with a flexible
snap-over cap. Strain relief is the spot where the cable jacket is
gripped — without it, repeated flexing at the channel mouth fatigues
the conductors and the wire breaks inside the jacket invisibly. Common
cable diameters: ribbon ~3 mm, USB-A ~4.5 mm, USB-C ~3.2 mm, micro-USB
~3 mm, JST-XH 2-pin ~2.5 mm, mains ~6 mm, ethernet (cat6) ~6.5 mm.

## CadQuery template

```python
import cadquery as cq

# Common cable / wire jacket diameters (mm).
CABLE_TABLE = {
    "JST-XH-2":         2.5,
    "JST-XH-4":         3.5,
    "ribbon-flat":      3.0,
    "dupont":           1.0,
    "USB-A-cable":      4.5,
    "USB-A-connector":  4.5,    # height of plug shell (width 12 mm — rectangular, see note)
    "USB-C-cable":      4.0,    # was 3.2 — most USB-C charging cables are 3.5–4.5 mm
    "USB-C-connector":  3.0,    # plug shell height (width 9 mm — rectangular)
    "micro-USB-cable":  3.5,    # was 3.0
    "DC-barrel":        3.5,
    "ethernet-cable":   6.0,    # cat6 jacket
    "ethernet-boot":    9.0,    # the rubber RJ45 boot — what actually has to pass through
    "mains-2c":         6.0,
}

def make_cable_channel(part, p):
    """Cut a U-shaped cable channel into the surface of ``part``.
    Caller positions so the open top of the channel is at +Z.

    Required params (mm):
      cable_id        — key into CABLE_TABLE or a numeric diameter
      channel_path    — list of (x, y) points forming the centreline
      channel_depth   — depth of the U (>= cable_d * 0.7 to retain)
      channel_width   — width of the U (cable_d + 0.4 for slip, cable_d for press)
      strain_relief   — True/False — add narrowed grippy section at each end
    """
    d = CABLE_TABLE[p.cable_id] if isinstance(p.cable_id, str) else p.cable_id
    w = p.channel_width
    depth = p.channel_depth

    # Straight run — single rect cut from the top face.
    if len(p.channel_path) == 2:
        (x0, y0), (x1, y1) = p.channel_path
        length = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        part = (
            part.faces(">Z").workplane()
                .center(cx, cy)
                .rect(length, w)
                .cutBlind(-depth)
        )
        return part

    # Curved / multi-segment run — sweep a rect profile along the polyline.
    path = cq.Workplane("XY").polyline(p.channel_path)
    profile = cq.Workplane("YZ").center(0, -depth / 2).rect(w, depth)
    cutter = profile.sweep(path)
    return part.cut(cutter)
```

(Real CadQuery APIs. The robust approach: `.polyline([...]).sweep(profile)`
or for straight runs `.rect(L, w).cutBlind(-depth)`.)

> **Connector vs cable:** USB-A / USB-C / micro-USB / RJ45 connectors are RECTANGULAR with a height ≪ width. A round channel that fits the cable will NOT fit the connector. Size for whichever piece is supposed to pass through the channel; route the connector entry separately.

## Channel sizing

| Cable type | Channel width | Channel depth | Notes |
|---|---|---|---|
| USB-A cable | 4.9 mm (4.5 + 0.4 clearance) | 4.5 mm | full depth, snap-on lid |
| USB-C cable | 4.4 mm | 4.0 mm | full depth, snap-on lid |
| micro-USB cable | 3.9 mm | 3.5 mm | snug |
| ribbon (4-wire) | 3.4 mm | 1.5 mm | shallow ok; ribbon is flat |
| ethernet (cat6) cable | 6.5 mm | 6.0 mm | full depth, lid required |
| ethernet RJ45 boot | 9.5 mm | 9.0 mm | size for the boot if the plug passes through |
| mains 2-conductor | 6.4 mm | 6.0 mm | full depth, lid required + clamp |
| JST-XH 2-pin | 2.9 mm | 2.5 mm | open channel ok |
| dupont jumpers | 1.4 mm | 1.0 mm | tight; press fit retains |

## Strain relief

At the entry / exit, narrow the channel to ~80% of nominal width over a
3 mm stretch. The cable jacket squeezes here, taking strain off the
conductors. CadQuery: cut the main channel full-width, then add small
pinch bumps on each side of the entry.

```python
def add_strain_relief(part, p):
    """Narrow each end of the channel by adding two pinch bumps.
    Bumps are short cylinders straddling the channel entry; the cable
    jacket deforms slightly as it passes between them.
    """
    d = CABLE_TABLE[p.cable_id] if isinstance(p.cable_id, str) else p.cable_id
    pinch_r = 1.0                       # 2 mm diameter bumps
    offset  = (p.channel_width / 2)     # bump centres sit at channel wall
    h       = p.channel_depth

    for (x, y) in (p.channel_path[0], p.channel_path[-1]):
        for side in (+1, -1):
            part = (
                part.faces(">Z").workplane()
                    .center(x, y + side * offset)
                    .circle(pinch_r)
                    .extrude(h)
            )
    return part
```

## Closing the channel

Three options:

1. **Open channel + press-fit**: works for cables <= 4 mm; cable snaps
   over the lip. Lip is 0.4 mm thick at the rim.
2. **Snap-on printed lid**: thin separate lid that clips over the
   channel via a cantilever snap each ~30 mm. See snap-fit-cantilever.md.
3. **Hot glue / silicone**: pour over the cable. Not parametric but
   common.

## Pitfalls

- Channel too narrow: cable won't lay flat, bulges out of the surface.
- Channel too wide: cable rattles, no strain relief — worse than nothing.
- No strain relief: cable flexes at the same point every time; conductor
  cracks invisibly inside the jacket after 100-1000 cycles. The user
  thinks the cable is fine until it stops working.
- Sharp 90 deg corners in the channel: stress concentrator on the cable.
  Use a turning radius >= 3x cable diameter (e.g., a USB-C cable needs
  >=10 mm corner radius).
- Channel routed past a heat source (motor, regulator) without
  insulation: cable jacket melts. Keep >= 3 mm from hot components or
  route around.
- Print orientation: channels printed with the open top facing UP have
  perfect surface finish on the channel floor (bed side); printed
  upside-down they'll be rough and the cable wears. Keep channels open-up.
- Bridging the channel: if you intend to print a roof over the channel
  (closed conduit), span > 5 mm needs supports or the roof sags into
  the cable.
- Don't cut a circular cable hole exactly the cable diameter — cable
  jacket has compliance + thermal expansion. Add 0.4 mm clearance.
