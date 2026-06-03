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
cable diameters: ribbon ~3 mm, USB-A ~4.5 mm, USB-C ~4 mm, micro-USB
~3.5 mm, JST-XH 2-pin ~2.5 mm, mains ~6 mm, ethernet (cat6) ~6.5 mm.

## Use the helper

`cadlib` owns the geometry — don't re-derive it. The helper cuts a
straight, open-top U-channel along the centerline:

```python
from cadlib.cutouts import add_cable_channel

part = add_cable_channel(
    part,
    centerline=[(-20, 0), (20, 0)],   # STRAIGHT two-point centerline only
    cable_diameter=4.5,               # jacket diameter (USB-A cable)
    channel_depth=None,               # None → cable_diameter * 0.9
    channel_clearance=0.4,            # slip fit; near 0 for press-retain
    open_face=">Z",                   # open top — keep facing up at print time
)
```

Channel width is computed as `cable_diameter + channel_clearance`; depth
defaults to `cable_diameter * 0.9`. Common jacket diameters live in
`cadlib/tables.py::CABLE_TABLE` (`JST-XH-2`, `ribbon-flat`, `USB-A-cable`,
`USB-C-cable`, `micro-USB-cable`, `ethernet-cable`, `mains-2c`, etc.) —
`Read` that file and pass the number through `cable_diameter`.

> **Connector vs cable:** USB-A / USB-C / micro-USB / RJ45 connectors are
> RECTANGULAR with a height ≪ width. A round channel sized for the cable
> will NOT fit the connector. Size for whichever piece passes through the
> channel; route the connector entry separately.

> **Straight only:** the helper raises `NotImplementedError` for a
> centerline with more than two points. For curved or multi-segment
> routing see **Beyond the helper** below.

## Closing the channel

The helper cuts an open-top channel (no lid). Three ways to retain the cable:

1. **Open channel + press-fit**: works for cables <= 4 mm; cable snaps
   over the lip. Lip is 0.4 mm thick at the rim. Use `channel_clearance`
   near 0 to retain by friction.
2. **Snap-on printed lid**: thin separate lid that clips over the
   channel via a cantilever snap each ~30 mm. See snap-fit-cantilever.md.
3. **Hot glue / silicone**: pour over the cable. Not parametric but
   common.

## Beyond the helper

**Curved / multi-segment routing is not in the helper yet** — it is
straight-only. For an L-bend or a polyline route, write a
`custom_cable_channel()` function (candidate to promote): sweep a rect
profile along the polyline. Keep corner radius generous (see Pitfalls).

```python
import cadquery as cq

def custom_cable_channel(part, *, centerline, cable_diameter, channel_clearance=0.4, channel_depth=None):
    """Curved cable channel — sweep a rect profile along a polyline.
    Not in cadlib; the cadlib helper handles only straight runs.
    """
    w = cable_diameter + channel_clearance
    depth = channel_depth if channel_depth is not None else cable_diameter * 0.9
    path = cq.Workplane("XY").polyline(centerline)
    profile = cq.Workplane("YZ").center(0, -depth / 2).rect(w, depth)
    cutter = profile.sweep(path)
    return part.cut(cutter)
```

**Strain relief is also not in cadlib.** At each entry/exit, narrow the
channel to ~80% of nominal width over a ~3 mm stretch so the jacket
squeezes and takes strain off the conductors. Add two short pinch bumps
straddling the channel mouth:

```python
def custom_strain_relief(part, *, centerline, channel_width, channel_depth):
    """Narrow each channel end with two pinch bumps the jacket deforms past.
    Not in cadlib — candidate to promote.
    """
    pinch_r = 1.0                    # 2 mm diameter bumps
    offset  = channel_width / 2      # bump centres at the channel wall
    for (x, y) in (centerline[0], centerline[-1]):
        for side in (+1, -1):
            part = (
                part.faces(">Z").workplane()
                    .center(x, y + side * offset)
                    .circle(pinch_r)
                    .extrude(channel_depth)
            )
    return part
```

## Pitfalls

- Channel too narrow: cable won't lay flat, bulges out of the surface.
- Channel too wide: cable rattles, no strain relief — worse than nothing.
- No strain relief: cable flexes at the same point every time; conductor
  cracks invisibly inside the jacket after 100-1000 cycles. The user
  thinks the cable is fine until it stops working. (Strain relief is not
  in the helper — add it with `custom_strain_relief()` above.)
- Sharp 90 deg corners in the channel: stress concentrator on the cable.
  Use a turning radius >= 3x cable diameter (e.g., a USB-C cable needs
  >=10 mm corner radius). The straight helper sidesteps this; a curved
  `custom_cable_channel()` must keep the radius generous.
- Channel routed past a heat source (motor, regulator) without
  insulation: cable jacket melts. Keep >= 3 mm from hot components or
  route around.
- Print orientation: channels printed with the open top facing UP have
  perfect surface finish on the channel floor (bed side); printed
  upside-down they'll be rough and the cable wears. Keep channels open-up
  (`open_face=">Z"` and printed that way up).
- Bridging the channel: if you intend to print a roof over the channel
  (closed conduit), span > 5 mm needs supports or the roof sags into
  the cable.
- Don't cut a circular cable hole exactly the cable diameter — cable
  jacket has compliance + thermal expansion. Add 0.4 mm clearance
  (the helper's `channel_clearance` default).
