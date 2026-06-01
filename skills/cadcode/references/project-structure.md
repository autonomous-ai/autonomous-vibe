# Project structure

Load this when the user asks for any non-trivial part — multi-part
assembly, more than ~5 features, anything that wants to be tweaked over
time.

## When to use a project, not a single file

| Single ``.py`` | Project directory |
|---|---|
| Cube, plate, hook, single knob, single bracket | Enclosure with base + lid |
| <120 lines | Multi-part assembly |
| One physical body | 3+ named parts or 5+ features |
| Throwaway / one-shot | The user might come back and tweak it |

When in doubt, prefer the project. The edit affordances pay off after
the first iteration.

## Canonical layout

```
<project>/
├── spec.md              English design intent — read FIRST
├── params.py            dataclass with ALL numeric dimensions
├── validation.py        assert-style printability checks
├── main.py              entrypoint — sets `result` for the runner
├── parts/
│   ├── __init__.py
│   ├── base.py          one file per physical part
│   └── cover.py
├── features/            optional — reusable feature functions
│   └── __init__.py
└── assemblies/
    ├── __init__.py
    └── product.py       positioning + union of parts
```

A working template lives at
``~/.claude/skills/cadcode/templates/project_skeleton/``. Copy it to the
user's workspace as a starting point, rename the project dir, edit.

## The seven rules

### 1. All dimensions in ``params.py``, nowhere else

```python
# params.py — the single source of truth for numbers
from dataclasses import dataclass

@dataclass
class Params:
    width: float = 120.0
    depth: float = 80.0
    height: float = 35.0
    wall: float = 3.0
    fillet_radius: float = 1.5
    screw_diameter: float = 3.2
    screw_boss_diameter: float = 8.0
    screw_margin: float = 10.0
    lid_gap: float = 0.4
```

Then geometry reads from ``p`` only:

```python
# Bad — magic numbers, can't tweak from one place
.box(120, 80, 35).shell(-3)

# Good — every dimension is named, edit once in params.py
.box(p.width, p.depth, p.height).shell(-p.wall)
```

The agent's job, when the user says "make the wall 2mm thicker", is to
edit `params.py` ONLY. Geometry files don't change.

### 2. One file per part

```python
# parts/base.py
import cadquery as cq
from params import Params

def make_base(p: Params) -> cq.Workplane:
    part = _outer_shell(p)
    part = _hollow_inside(part, p)
    part = _add_screw_bosses(part, p)
    return part

def _outer_shell(p): ...
def _hollow_inside(part, p): ...
def _add_screw_bosses(part, p): ...
```

Each ``make_<thing>`` returns a Workplane in the part's *local* frame —
do not call ``.translate()`` for assembly position inside a part file.
Positioning is the assembly's job.

### 3. Features are functions, composed in a pipeline

```python
def make_part(p: Params) -> cq.Workplane:
    part = _outer_shell(p)
    for feature in (
        _hollow_inside,
        _add_screw_bosses,
        _add_usb_cutout,
        _add_vent_slots,
        _add_label,
        _apply_fillets,
    ):
        part = feature(part, p)
    return part
```

Each feature: ``(part, p) -> part``. Pure, composable, easy to reorder.

Name features by intent: ``add_left_usb_c_cutout``, ``apply_corner_fillets``,
``mirror_to_right_side``. Not ``thing1``, ``fix_hole``, ``helper``.

### 4. Assemblies position, never deform

```python
# assemblies/product.py
import cadquery as cq
from params import Params
from parts.base import make_base
from parts.cover import make_cover

def make_assembly(p: Params) -> cq.Workplane:
    base = make_base(p)
    cover = make_cover(p).translate((0, 0, p.height + p.lid_gap))
    return base.union(cover)
```

Translations, rotations, mirrors are fair game here. Editing a part's
geometry from the assembly is NOT — go fix the part file.

### 5. ``validation.py`` runs first

```python
# validation.py
from params import Params

def validate_params(p: Params) -> None:
    assert p.wall >= 1.6, f"wall too thin for FDM: {p.wall}"
    assert p.fillet_radius < p.wall, "fillet would erode wall"
    assert p.screw_margin > p.screw_boss_diameter / 2, "screw boss off the edge"
```

Then in ``main.py``:

```python
from params import Params
from validation import validate_params
from assemblies.product import make_assembly

p = Params()
validate_params(p)
result = make_assembly(p)
```

Failing validation is a feature. Better to fail with a useful message
than render a model that's unprintable.

### 6. The runner reads ``result``

``main.py`` MUST end with ``result = <a Workplane or compound>``. The
runner reads this name and exports STL + STEP + PNG. Don't return; don't
write files inside ``main.py``; just assign.

### 7. Stable, intent-aligned names

Names are an editing API. The agent searches by intent:

```
# Good — agent edit "make the USB cutout bigger" hits exactly one place
add_left_usb_c_cutout(part, p)
add_right_button_cutout(part, p)
add_top_vent_slots(part, p)

# Bad — opaque, agent has to read code to find the right spot
thing1(part, p)
modify(part, p)
helper2(part, p)
```

## Editing rules for the agent

When the user asks for a change:

1. **Dimension change** ("2mm thicker wall", "10mm longer") → edit
   ``params.py`` ONLY. Don't touch geometry.
2. **New feature** ("add USB cutout", "vent slots on top") → add a new
   feature function in ``features/`` or the relevant ``parts/<file>.py``,
   add a call site in the feature pipeline, add dimensions to
   ``params.py``.
3. **Remove feature** → comment out the call in the pipeline; don't
   delete the function (user might want it back next turn).
4. **New part** → new file in ``parts/``, register in the assembly.
5. **Tighter / looser fit** → adjust gap parameters in ``params.py``
   (``lid_gap``, ``shaft_fit``, etc.).
6. **Different material / printer** → edit ``validation.py`` constants
   (``min_wall``, ``min_overhang_angle``, etc.).

After any edit, run ``scripts/cad <project_dir>/`` and Read the PNG.
The loop applies the same way — project mode doesn't change it.

## What the agent should AVOID

- Mixing dimensions and geometry. If you find yourself typing a number
  inside ``parts/*.py``, stop. Add it to ``params.py`` first.
- Single-file refactors of a project. If the user has a project, keep
  it as a project — don't flatten into one giant file because it feels
  simpler to write.
- Inline assembly inside a part file. Parts don't know about each
  other; if you need two parts coordinated, that's an assembly.
- Renames without need. If the agent renames ``make_base`` →
  ``build_base`` between turns, the user has to mentally chase. Stick
  with the names the project established.
