---
name: cadcode
description: Generate, edit, validate, and render parametric 3D models for hobbyist 3D printing using CadQuery (B-rep, OCCT). Use for natural-language CAD asks like "phone stand", "wall mount", "honeycomb tray", "GoPro adapter", "vase". Outputs an archival STEP plus an interactive GLB preview (pickable faces/edges) and an optional printable STL. Produces editable Python source — describe what you want, get a printable file in minutes, edit by chatting.
---

# CADCode — hobbyist 3D CAD via CadQuery

## Purpose

Turn natural-language descriptions of 3D parts into printable, inspectable
3D models. The source of truth is **CadQuery Python** (B-rep on OpenCASCADE
— same kernel as SolidWorks / FreeCAD / build123d). Every generated `.py`
file is a small, editable parametric program. The user owns the file;
tweak parameters, re-render, re-print.

Optimised for **hobbyist 3D printing**, not commercial CAD. The deliverable
is an archival STEP plus a watertight STL that the user's slicer can
ingest, with an interactive GLB preview the viewer can pick faces and edges
on.

## Treat the design as a project

**A design is a small software project, not a single script.** Trivial parts
(a cube with a hole, a plate, a single hex tray) fit in one `.py` file.
Anything bigger — multi-part assemblies, designs with many features, any
part with more than ~120 lines of code — gets a project directory.

A project looks like:

```
my_design/
├── spec.md             design intent (English, human-readable)
├── params.py           ALL dimensions + manufacturing constants
├── validation.py       runtime constraints (printability, fit, sanity)
├── main.py             entrypoint — defines `gen_step()` (preferred) or
│                       assigns `result` (legacy single-file form)
├── parts/              one file per physical part
│   ├── __init__.py
│   ├── base.py
│   └── cover.py
├── features/           reusable feature functions (cutouts, vents, …)
│   └── __init__.py
└── assemblies/         positioning + union of parts
    ├── __init__.py
    └── product.py
```

`scripts/cad <project_dir>/` calls cadpy's artifact pipeline, which reads
``main.py`` with the project directory on ``sys.path`` (so ``from params
import Params`` and ``from parts.base import …`` work), then calls
``gen_step()``. **Use `Skill(skill='cadcode')` and `Read`
`templates/project_skeleton/` when you need the canonical layout** — copy
it to the user's workspace, edit, run.

Rules of the project format:

- **All dimensions live in `params.py`.** Geometry code never hardcodes
  numbers. The user (or you next turn) edits a value once; nothing else
  changes. Bad: `.box(120, 80, 35).shell(-3)`. Good: `.box(p.width, p.depth, p.height).shell(-p.wall)`.
- **`main.py` defines `gen_step()`** at module scope. It returns one of:
  a ``cq.Workplane`` / ``cq.Shape`` (single solid), a ``cq.Assembly``
  (multi-part hierarchy with names + colors + locations), or an
  envelope ``dict`` like ``{"shape": <…>, "stl": True, "mesh_tolerance":
  0.03}`` when you want to tune mesh fidelity or request extra output
  formats (see the [Artifact-control envelope](#artifact-control-envelope)
  section). The legacy ``result = <shape>`` form is still accepted for
  trivial single-file scripts — the runner treats it as if
  ``gen_step()`` returned ``result``.
- **One file per physical part** under `parts/`. Each part knows nothing
  about its siblings; it builds in its own local frame.
- **Each feature is its own function.** `add_left_usb_c_cutout(part, p)`,
  not nested inline. Compose them in a pipeline so each edit has a clear
  target.
- **Assembly = positioning + union, never geometry.** Build parts in
  `parts/`, place them in `assemblies/`.
- **`validation.py` runs at startup** with `assert` checks on Params.
  Bad dimensions fail loudly before paying a render cycle.

### Artifact-control envelope

For most parts, return the shape directly from ``gen_step()`` and let the
defaults handle the export. When you need control:

```python
def gen_step():
    body = build_my_part(p)
    return {
        "shape": body,                       # required: cq.Workplane | cq.Shape
        "stl": True,                         # write the .stl too (default off)
        "mesh_tolerance": 0.03,              # mm, default 0.05
        "mesh_angular_tolerance": 2.0,       # deg, default 3.0
    }
```

The envelope keys (``shape`` | ``instances`` | ``children`` for content;
``stl`` / ``3mf`` / ``mesh_tolerance`` / ``mesh_angular_tolerance`` for
output) are all that the cadpy pipeline accepts — unknown keys raise.

See `references/project-structure.md` for the long version.

## The loop

The cadcode skill turns you into a self-correcting CAD designer. **You close
the feedback loop yourself** — do not hand a possibly-broken model to the
user for verification.

```
understand task → inspect repo → make plan → edit .py → run scripts/cad
       ↑                                                       ↓
       └────────── fix ←─── read failure / render ←────────────┘
```

What "fix" means in practice:

- ``ok=false``: read the traceback, change the smallest responsible line, re-run.
- ``is_solid=false`` or volume far off expected: load `references/repair-loop.md`, classify, fix, re-run.
- Preview GLB looks wrong (proportions off, hole misplaced, parts misaligned): edit the `.py` and re-run. **Always inspect the GLB** in the viewer — geometry can be valid but wrong.

You have everything you need to close the loop on your own:

- The user's prompt and any attached reference image (inspect).
- The current workspace files including prior `.py` versions (inspect).
- `scripts/cad` for compile + solid check + STEP/GLB/topology/metadata export (run).
- `scripts/check` for a quick validation when you only need a sanity check (run).
- This SKILL.md + the references for domain knowledge (plan).

**Iterate until the model is correct.** Soft cap of 4 iterations before you
ask the user a clarifying question — past that, you're probably guessing
about user intent rather than fixing a geometry bug. Closing the loop is
what makes you feel like an engineer instead of an autocomplete.

## Use this skill when

The user asks for any of:

- A specific printable part: phone stand, wall hook, bracket, mount, jig,
  enclosure, knob, organizer, hex tray, gridfinity bin, vase, GoPro/action-
  camera adapter, replacement knob, light cover, cable clip.
- A CadQuery `.py` file, parametric model, or STL/STEP/3MF output.
- Editing an existing CadQuery file: "make the wall 2mm thicker", "add
  fillets to the top edges", "move the screw holes 5mm apart".
- A printable replacement part with a stated device + dimensions.

Do **not** use this skill for: render-only concept art, FEA / simulation,
robotics description files (URDF / SDF), or 2D laser-cut DXF. If a sibling
skill is installed for those domains, use it; otherwise tell the user this
skill is not the right tool.

## Default assumptions

Use these defaults unless the user specifies otherwise:

- **Units**: millimeters.
- **Origin**: center of the main body, base plane on `XY`, height along `+Z`.
- **Output**: closed, positive-volume solids. ``scripts/cad`` reports
  ``is_solid`` in its JSON — do not declare done when it's ``false``. Do
  not add an ``assert <shape>.isValid()`` line to the user's ``.py``;
  cadpy already validates as part of the artifact pipeline.
- **Print bed**: 200×200mm typical FDM. Warn if your model exceeds it.
- **Wall thickness for FDM enclosures**: 2.0–3.0 mm.
- **Cosmetic fillet**: 1.0–2.0 mm where geometry allows.
- **Cable channels / slots**: 2–4 mm wider than the cable / connector.
- **Clearance holes** (use these unless user specifies otherwise):
  - M3 close-fit: 3.4 mm
  - M4 close-fit: 4.5 mm
  - M5 close-fit: 5.5 mm
  - #4 self-tap: 3.2 mm
  - #6 self-tap: 3.7 mm
- **Tolerances baked into the print** (FDM, 0.4mm nozzle): assume 0.2 mm
  positive slop on holes the user will press a part into; assume 0.4 mm slop
  on parts the user will assemble by hand.

Ask the user **one focused clarifying question only** when an assumption
would change geometry materially. Examples that warrant a question:

- Phone model when the prompt says "phone stand" but no model is given.
- Portrait vs landscape orientation when both are common for the part type.
- Wall mount vs desk stand vs handheld when not implied.
- Hand or thread (M3 vs #4-40, BSPP vs NPT).

Examples that do **not** warrant a question — just pick a sane default and
note the assumption in your reply:

- Cosmetic fillet radius.
- Background colour, finish, or decorative texture.
- Whether to add a chamfer to the print-bed edge (always yes — it lifts off
  cleaner).

## Root model

- **Skill directory**: this folder. Tools live at `scripts/cad` and
  `scripts/check`.
- **Workspace cwd**: relative target paths resolve from the user's working
  directory. Use absolute paths when you write a `.py` file so subsequent
  tool calls find it.
- **Source = the `.py` file (or project) you wrote**. STEP, GLB, the
  topology sidecar, the metadata sidecar, and any optional STL/3MF are
  *derived*. When the user asks for a change, edit the `.py` and
  re-generate. Do not edit the STL or STEP.
- **Entry function**: every CadQuery file (or project ``main.py``) you
  produce **must** define ``gen_step()`` at module scope, returning either
  a ``cq.Workplane`` / ``cq.Shape`` / ``cq.Assembly``, or an envelope
  ``dict``. The legacy single-file form — assigning the final shape to a
  module-level global named ``result`` — is still accepted for trivial
  scripts. Without one of these, the runner fails.

## Available tools

The skill lives at ``~/.claude/skills/cadcode/`` (or wherever the user
installed it). From the workspace, the launchers are:

```bash
# Single-file mode: pass any .py file defining gen_step() (or, for
# trivial scripts, ending with a module-level `result = <shape>`).
python ~/.claude/skills/cadcode/scripts/cad   <input.py>      [flags]

# Project mode: pass a directory containing main.py — sibling modules
# (params.py, parts/, features/, assemblies/, validation.py) are
# automatically added to sys.path
python ~/.claude/skills/cadcode/scripts/cad   <project_dir>/  [flags]

python ~/.claude/skills/cadcode/scripts/check <input.py>
```

Common flags on ``scripts/cad``:

- ``--out-dir DIR``       where artifacts land (default: alongside input)
- ``--mesh-tolerance MM`` linear meshing tolerance for STL/GLB (default 0.05)
- ``--angular-tolerance DEG``  angular meshing tolerance for STL/GLB (default 3°)
- ``--wall-clock-s S``    subprocess timeout (default 30; bump for complex parts)

Use ``--help`` for the full flag set. Always pass an **absolute path** for
``<input.py>`` or ``<project_dir>`` — the agent's cwd may not be the
user's workspace.

**`scripts/cad`** — primary tool. Runs the CadQuery file (or project) in
an isolated subprocess (rlimit + restricted imports + 30s wall-clock kill)
and writes the canonical artifact set next to the source via the cadpy
pipeline:

- `<name>.step` — full B-rep archival, with XCAF labels + colors.
- `<name>.glb` — interactive preview mesh with embedded face/edge IDs the
  viewer uses for picking and ``@cad[<file>#fN]`` references.
- `<name>.topology.json` — sidecar mapping face/edge/vertex ordinals to
  their STEP entities. Read this if you want to know which OCCT face an
  ID refers to.
- `<name>.step.json` — source hash, generator metadata, validation summary
  (``is_solid``, ``volume_mm3``, mesh tolerances).
- `<name>.stl` — slicer-ready mesh, written **only** if your ``gen_step()``
  envelope sets ``stl=True`` (or you returned a bare shape in single-file
  mode, where STL defaults to on for back-compat with the hobbyist flow).
- `<name>.3mf` — alt mesh format, written only if ``3mf=True`` in the
  envelope.

Prints a single JSON line on stdout matching the Panda skill stdout
contract (§3 in ``docs/panda-interfaces.md``):
``{ok, step_path, glb_path, topology_path, metadata_path, stl_path?,
is_solid, volume_mm3, bbox, error?}``.

**`scripts/check`** — quick validator. Runs the `.py` and reports
`is_solid`, `volume_mm3`, manifold status, and any min-wall warnings
without keeping artifacts. Use this to sanity-check a model before paying
for the full export.

## Running the loop

Each phase of the loop in concrete terms:

### 1. Understand the task

Read the user's prompt fully. Classify it: **new part**, **edit of an
existing `.py`**, **render-only review**, or **validation-only check**. If
a reference image was attached, `Read` it first — its dimensions and
style are usually authoritative.

### 2. Inspect the workspace

List the workspace files. If a `.py` exists from a prior turn AND this is
an edit request, `Read` it before writing. Don't regenerate from scratch
when an edit will do — minimal diffs respect the user's prior tweaks.

If you're unsure how to approach a feature (hex grid, tapered shell,
multi-part union), `Read` one of the example assets in this skill's
`assets/` directory and mimic the pattern.

### 3. Make a plan

In your reasoning, write down: parameters (name + value + unit), key
features, build order. Catch dimension errors before they cost a render
cycle. For multi-feature parts, decide the union order — most stable
anchor first.

### 4. Edit the `.py`

Write the file with:
- A 1-line docstring at top describing the part.
- Named parameters with units in comments (`PHONE_W = 77  # iPhone 15 PM`).
- A single ``gen_step()`` function at module scope that returns the final
  ``cq.Workplane`` / ``cq.Shape`` / ``cq.Assembly`` (or an envelope
  ``dict`` if you need to tune mesh tolerance or request an STL/3MF — see
  the [Artifact-control envelope](#artifact-control-envelope) section).
  Trivial single-file scripts may use the legacy ``result = <shape>``
  module-level form instead.

Pick a filename from the part: `phone_stand.py`, `gopro_adapter.py`. Use
absolute paths for the `Write` tool — the workspace cwd is not the skill
directory.

### 5. Run `scripts/cad`

```bash
python ~/.claude/skills/cadcode/scripts/cad <abs/path/to/file.py>
```

This compiles, checks `is_solid`, exports STEP + GLB + topology +
metadata (+ optional STL/3MF per envelope), and prints a JSON line.

### 6. Read the failure (or the render)

Don't skip this step. Even when `ok=true is_solid=true`, geometry can be
visually wrong:

- The GLB at ``glb_path`` is the canonical preview — in Panda the viewer
  pane renders it automatically, with feature edges and pickable faces.
  When the viewer isn't available, use the ``cad-viewer`` skill (if
  installed) to spin one up against the workspace.
- Compare against the user's prompt and any reference image.
- Check the bbox in the JSON: does it match the intent (right order of
  magnitude, fits on a 200×200mm bed)?

If anything is off — compile error, non-solid, wrong proportions,
misplaced holes — go to step 7.

### 7. Fix

Apply the **smallest responsible** source change:
- Compile errors → load `references/repair-loop.md`, fix the line.
- `is_solid=false` → boolean op probably went wrong; reduce / restructure.
- Wrong proportions → re-check parameters against bbox.
- Hole/feature misplaced → recompute against the right reference face
  with the right selector (`.faces(">Z[1]")` etc.).

Then go back to step 5. **Soft cap: 4 iterations** before asking the user
a clarifying question. Past 4, you are probably guessing about user
intent rather than fixing a geometry bug.

### 8. Hand off

Final reply to the user (mandatory, see "Required final response" below):
the STL path, bbox + volume, parameters to tweak, and one or two
assumptions you made.

## Non-negotiables

- The agent **never** edits the generated STEP / GLB / STL / topology
  sidecar / metadata sidecar. Edit `.py`, re-generate.
- Every generated `.py` (or project ``main.py``) defines exactly one
  ``gen_step()`` at module scope, OR for trivial single-file scripts
  assigns the final shape to a module-level ``result``. cadpy accepts
  both.
- Every CadQuery `.py` starts with `import cadquery as cq` and uses `cq.`
  throughout. Do not mix in `build123d` — they are different libraries.
- Run `scripts/cad` (or at minimum `scripts/check`) before declaring done.
  Never claim a model is printable from reading code alone.
- When the prompt is ambiguous on a *geometry-changing* axis, ask **one**
  clarifying question. Otherwise, pick a default and proceed.
- Use millimeters throughout. Do not convert; do not annotate inches.

## Reference examples

Working ``.py`` files you can study (do NOT load eagerly — read on demand
when you need to mimic a pattern):

| File | Demonstrates |
|---|---|
| ``assets/example_cube_with_hole.py`` | Hello world: primitives, face selectors, ``.hole()`` |
| ``assets/example_hex_tray.py`` | Parametric grid, hex polygon math, ``.pushPoints`` |
| ``assets/example_spur_gear.py`` | Polar arrays of trapezoidal teeth, shaft bore + keyway |
| ``assets/example_twisted_vase.py`` | Multi-level loft of rotated cross-sections, ``.shell()`` for hollow walls |
| ``assets/example_gopro_mount.py`` | Multi-part union (base + stem + 3-finger head), standard GoPro spec, ``.cboreHole`` |
| ``assets/example_knurled_knob.py`` | Polar array of cutting features (knurling), chamfers, M3 set screw |

These are the canonical patterns. Mimic the file shape: docstring at top,
named parameters at the top of the file, single ``result = ...`` at the
bottom.

## Progressive references

Load these only when their trigger applies (saves the host agent's context):

- `references/project-structure.md` — when to use a project directory
  vs a single file, the canonical layout, the seven rules, editing rules.
  **Load before scaffolding any multi-part design.**
- `references/cadquery-modeling.md` — CadQuery idioms: workplanes, faces
  selectors, hole/cboreHole, fillet/chamfer, polygon for hex grids, loft for
  taper, common pitfalls.
- `references/hobbyist-defaults.md` — full FDM tolerance table, common
  fastener / cable / bearing dimensions, well-known part sizes (iPhone 15
  family, GoPro mount, NEMA17 motor, GridFinity 42mm baseplate, 608 bearing,
  etc.).
- `references/repair-loop.md` — diagnosis + repair when `scripts/cad`
  returns `ok=false` or `is_solid=false`: classify the failure, the smallest
  responsible fix, when to re-render vs re-validate.
- `references/assembly.md` — `cq.Assembly` workflow for designs with
  **physically separate parts** (lid + base, hinge, removable cover, robot
  chassis + wheels). **Load before designing anything the user prints as
  multiple pieces and assembles** — using `.union()` for these instead of
  Assembly loses clearances, fits, and per-part STL export.

## Helper library (`cadlib`)

The skill ships a Python package at `~/.claude/skills/cadcode/cadlib/`
with composable, tested CadQuery helpers. **Prefer importing these over
re-deriving geometry from the pattern docs.** The runner adds the skill
root to `sys.path`, so `from cadlib.X import Y` resolves inside the
sandbox.

```python
from cadlib.enclosure import hollow_box, add_lid_lip, lid_plate
from cadlib.mounting  import add_screw_post, add_heat_set_pocket, add_nut_trap
from cadlib.cutouts   import (
    add_press_fit_pocket, add_magnet_pocket, add_bearing_seat, add_cable_channel,
)
from cadlib.mechanical import add_dovetail_slot, add_rib_stiffener
from cadlib.layout    import four_corner_points, grid_points, circle_points
from cadlib.tables    import (
    SCREW_TABLE, NUT_TABLE, HEATSET_TABLE, BEARING_TABLE, MAGNET_TABLE, CABLE_TABLE,
)
```

Every helper:

- is **keyword-only** (no positional surprises)
- **returns** a new `cq.Workplane` (does not mutate `part`)
- **raises `ValueError`** on impossible param combinations (so failures
  point at the spec, not at OCCT five frames deep)
- has a one-paragraph docstring with units + one usage example — `Read`
  the helper's source file if you want the full signature

When **no helper fits**, write the geometry inline in a function named
`custom_<feature>()` — that's a signal the library is missing a helper,
worth promoting later. **Do not copy the pattern doc's template
verbatim** when a `cadlib` helper exists — the docs are reference, the
package is the source of truth.

### Recipes — worked examples to mimic

Two complete recipes live at `~/.claude/skills/cadcode/recipes/`. Read
them when designing a similar product:

| Recipe | Demonstrates |
|---|---|
| `electronics_enclosure.py` | hollow_box + add_lid_lip + four_corner_points + add_screw_post + custom side port + lid_plate |
| `magnetic_lid_box.py`      | hollow_box + four_corner_points + add_magnet_pocket × 2 (base + lid) + lid_plate |

Both currently produce a single assembled ``result`` for the preview GLB
— a v0 single-file shape. New designs should wrap that final shape in a
``gen_step()`` function instead. For multi-part products where each piece
prints separately, follow the ``cq.Assembly`` pattern in
``references/assembly.md`` — cadpy preserves part names, colors, and
locations through the STEP+GLB pipeline so the viewer can highlight each
part.

## Pattern library

Atomic mechanical-engineering patterns, each in its own file under
`references/patterns/`. **Load only the patterns you actually need** — they
are small but adding 16 to every turn blows context. Match the user's
language to the trigger column and `Read` the corresponding file.

| Trigger phrases the user might say | Pattern file |
|---|---|
| snap fit, clip-on lid, clamshell, snap together | `references/patterns/snap-fit-cantilever.md` |
| living hinge, fold-open, flexure, clamshell flap | `references/patterns/living-hinge.md` |
| press fit, interference fit, tight fit, shaft hole | `references/patterns/press-fit-pocket.md` |
| dovetail, slide-on lid, T-slot mount, sliding rail | `references/patterns/dovetail-slide.md` |
| screw boss, mounting post, PCB standoff, M2/M3/M4/M5 hole | `references/patterns/screw-boss.md` |
| heat-set insert, brass insert, Ruthex / Voron insert | `references/patterns/heat-set-insert-pocket.md` |
| nut trap, embedded nut, captive nut, hex pocket | `references/patterns/nut-trap.md` |
| ribs, stiffener, gusset, brace, "make this stronger" | `references/patterns/rib-stiffener.md` |
| crack at corner, fatigue, stress relief, fillets | `references/patterns/fillet-stress-relief.md` |
| wall thickness, nozzle width, "how thick should X be" | `references/patterns/wall-thickness-rules.md` |
| print orientation, layer lines, "how should I print this" | `references/patterns/print-orientation.md` |
| overhangs, supports, teardrop hole, bridging | `references/patterns/overhang-relief.md` |
| draft angle, mould master, silicone mould, taper | `references/patterns/draft-angle.md` |
| magnet, magnetic closure, N42 / N52, neodymium | `references/patterns/magnet-pocket.md` |
| bearing, 608 / 688 / 6800, skate bearing, pulley | `references/patterns/bearing-seat.md` |
| cable channel, wire routing, strain relief, USB cable | `references/patterns/cable-channel.md` |

Each file has the same shape: **Trigger**, **Why (the mechanics)**, **CadQuery
template**, parameter ranges, and pitfalls. The template is copy-pasteable
and uses real CadQuery APIs — adapt parameters to the user's part rather
than starting from scratch.

When a design needs **multiple patterns** (e.g., enclosure with magnet
closure + screw bosses + cable channel), load all the relevant pattern
files at the start of the design phase, then weave them into one `.py`.

## Required final response

Your final reply to the user MUST contain, in order:

1. **One sentence** stating what you made (e.g., "Made a phone stand for an iPhone 15 Pro Max, 130mm tall, tilted 20°.").
2. **Output path** — the STEP for archival inspection plus, when you set
   ``stl=True`` (or used single-file mode), the STL absolute path the user
   can drag into a slicer.
3. **Bounding box + volume** so the user knows it'll fit on a 200×200mm bed.
4. **Tweakable parameters** — the variables at the top of the `.py` and what they do.
5. **Assumptions** — one or two bullets for anything geometry-changing you defaulted (case allowance, screw size, tilt direction).

Skip anything else. The user wants a printable file, not a thesis.
