---
name: cadcode
description: Generate, edit, validate, and render parametric 3D models for hobbyist 3D printing using CadQuery (B-rep, OCCT). Use for natural-language CAD asks like "phone stand", "wall mount", "honeycomb tray", "GoPro adapter", "vase". Outputs an archival STEP plus a printable STL the viewer previews. Produces editable Python source — describe what you want, get a printable file in minutes, edit by chatting.
---

# CADCode — hobbyist 3D CAD via CadQuery

## Purpose

Turn natural-language descriptions of 3D parts into printable, inspectable
3D models. The source of truth is **CadQuery Python** (B-rep on OpenCASCADE
— same kernel as SolidWorks / FreeCAD). Every generated `.py` file is a
small, editable parametric program. The user owns the file; tweak
parameters, re-render, re-print.

Optimised for **hobbyist 3D printing**, not commercial CAD. The deliverable
is an archival STEP plus a watertight STL that the user's slicer can ingest
and that the viewer renders as the preview.

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
        "mesh_tolerance": 0.03,              # mm, default 0.05
        "mesh_angular_tolerance": 2.0,       # deg, default 3.0
    }
```

The envelope keys (``shape`` | ``instances`` | ``children`` for content;
``mesh_tolerance`` / ``mesh_angular_tolerance`` for output) are all that the
cadpy pipeline accepts — unknown keys raise. The ``.stl`` is always written;
no envelope flag is needed.

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
- ``warnings`` non-empty (e.g. ``disconnected_bodies``, ``sliver``, ``invalid_brep``): these are deterministic geometry defects — **treat them as blocking**. A ``disconnected_bodies`` warning means a feature is floating off the body (placed outside its footprint, or never unioned) — or, for a **mechanism**, two pinned links whose shared joint was posed by eyeballed angles instead of solved, so they never meet. Anchor it to the body (`references/patterns/anchor-to-body.md`) or solve the loop so the joint coincides (`references/kinematic-placement.md`), and re-run. Do not declare done while any warning remains.
- Preview STL looks wrong (proportions off, hole misplaced, parts misaligned, a member poking through a plate): edit the `.py` and re-run. **Always inspect every part** — geometry can be valid (`is_solid=true`, no warnings) but still wrong.

You have everything you need to close the loop on your own:

- The user's prompt and any attached reference image (inspect).
- The current workspace files including prior `.py` versions (inspect).
- `scripts/cad` for compile + solid check + STEP/STL/metadata export (run).
- `scripts/check` for a quick validation when you only need a sanity check (run).
- This SKILL.md + the references for domain knowledge (plan).

**Iterate until the model is correct.** Soft cap of 4 iterations before you
ask the user a clarifying question — past that, you're probably guessing
about user intent rather than fixing a geometry bug. Closing the loop is
what makes you feel like an engineer instead of an autocomplete.

## Plan-phase design discipline

When Panda runs you in **planning mode** (`--permission-mode plan`), you write
no geometry — you produce the plan the user approves before the build. That plan
is an **engineering spec**, not a sales pitch. Hold it to four rules:

1. **Exact measurements.** Every dimension, quantity, and metric is a precise
   number with a unit. Never "about", "roughly", or "approximately" — if you
   don't know a value, derive it (below) or ask the user.
2. **Component-level breakdown.** List each distinct part with its outer
   dimensions, material, and purpose, and state exactly how parts connect —
   joint/feature type, mating dimensions, clearance/tolerance, attachment
   points, alignment. A single-part object still lists its one part.
3. **Physical correctness.** Account for gravity, balance, load-bearing, center
   of mass, structural stability, and FDM layer-line orientation. State your
   assumptions and confirm the design behaves under real-world conditions. Show
   only the checks that apply — for a part with no load case (decorative, a
   loose-fit cover), say so in a clause rather than inventing a load.
4. **Show the math.** For each derived or load-bearing number, show the formula
   and the values used so a reader can check it: `name = formula = value unit`.

**Scale to the request.** A trivial edit ("make the wall 2 mm thicker", "move
the holes 5 mm apart") needs only the exact before→after values and any physical
consequence — one to three lines. A new part or any multi-part / load-bearing
design gets the full treatment.

### Where the numbers come from — source them, don't guess

| Need | Load |
|---|---|
| FDM tolerances, fastener clearance holes, bearing/motor/phone sizes, sanity sizes | `references/hobbyist-defaults.md` |
| Wall thickness (nozzle multiples) + the `h³` stiffness rule | `references/patterns/wall-thickness-rules.md` |
| Screw pull-out (engagement = 2·screw-Ø), boss OD sizing | `references/patterns/screw-boss.md` |
| Rib vs wall stiffness (one rib ≈ 5–10× cheaper than doubling walls) | `references/patterns/rib-stiffener.md` |

Standard derived values you should cite rather than invent: wall snaps to a
nozzle multiple (0.4 mm nozzle → 0.8 / 1.2 / 1.6 / 2.0 / 2.8 / 3.2 mm; 2.0 mm
enclosure, 2.8 mm + ribs load-bearing); M3 clearance Ø3.4 mm, self-tap Ø2.5 mm,
boss engagement 6 mm, boss OD ≥ 8.8 mm; FDM slip fit ≈ 0.2 mm clearance per
side; PETG ≈ 0.6× PLA stiffness and creeps under sustained load.

### Physics checklist — what to show

- **Tip-over / balance:** center of mass vs support footprint. Compute the
  horizontal CoM offset and compare to the base edge:
  `x_CoM < base_overhang` ⇒ stable; report the margin.
- **Load path / bearing stress:** where weight enters, what carries it to the
  ground or mount, and the fastener/wall that takes the reaction.
- **Stiffness / deflection:** wall thickness and ribs for the stated load;
  remember doubling thickness is 8× stiffer (`h³`), a rib is usually cheaper.
- **FDM layer orientation:** a load pulling *across* the layer lines is far
  weaker (e.g. boss pull-out drops ~50%). State the print orientation wherever
  strength matters.
- **Build volume:** confirm the part fits the printer (Bambu ≈ 256 mm cube;
  cadpy's sanity bound is 200 × 200 mm).
- **Assumptions to state:** material (and its density/stiffness), applied load,
  orientation in use, support condition (free-standing, wall-mounted, clamped).
  Label every assumed input (a phone's mass, a bag's weight) as an assumption
  the user can correct — never present a guess as a measured fact, and never
  fabricate a load just to fill the section. Skip checks that don't apply and
  say why.

End the Physics check with a one-line verdict: stable / load-safe / printable
under the stated assumptions, or the condition that would make it fail.

### Worked example — desktop phone stand (single PLA part)

> **What I'll make** — A free-standing PLA cradle that holds a phone at a 70°
> viewing angle.
>
> **Parts**
> - *Stand body* — 100 × 75 mm base footprint, 6.0 mm floor; cradle wall rising
>   at 70° from the base, 110 mm tall, 2.8 mm wall; front retaining lip 8 mm
>   tall × 5 mm deep. Material PLA. One printed part, no fasteners; the phone
>   rests in the cradle and is retained by the lip (phone slides in from the
>   top, 1 mm side clearance each side for a loose fit).
>
> **Measurements & math**
> - `cradle wall = load-bearing default = 2.8 mm` (7 perimeters @ 0.4 mm nozzle)
> - `floor = 6.0 mm` — mass ballast low in the base to resist tip-over
> - `lip height = 8 mm` > phone resting offset, so the phone cannot slide out
> - `phone CoM height up cradle = 80 mm` (assumed, mid-height of a 160 mm phone)
>
> **Physics check** — Assumptions (user can correct): phone mass *assumed*
> 0.20 kg, PLA, static desktop, printed flat on the base.
> - Tip-over: phone leans 20° back from vertical, so its CoM sits
>   `x_CoM = 80·sin(20°) = 80·0.342 = 27.4 mm` behind the cradle root.
> - The base extends `60 mm` behind the cradle root, so
>   `x_CoM (27.4 mm) < base_overhang (60 mm)` ⇒ **stable, 32.6 mm margin.**
> - Load path: phone weight (`0.20 kg · 9.81 = 2.0 N`) bears on the cradle wall
>   and floor, both continuous PLA to the base — no fastener in the load path.
> - Print orientation: printed flat on the base, so the cradle's bending load
>   runs along layer lines, not across them — full layer strength.
> - Build volume: `100 × 75 × 110 mm` fits a Bambu 256 mm bed easily.
> - **Verdict:** stable, load-safe, and printable for phones up to a 60 mm
>   rearward CoM offset under these assumptions.

For a **multi-part assembly**, give each part its own *Parts* entry and make the
connection explicit (e.g. "base + lid, 0.2 mm slip fit on a 2 mm lip; four M3
self-tap bosses, 6 mm engagement, on a 80 × 60 mm bolt pattern").

## Use this skill when

The user asks for any of:

- A specific printable part: phone stand, wall hook, bracket, mount, jig,
  enclosure, knob, organizer, hex tray, gridfinity bin, vase, GoPro/action-
  camera adapter, replacement knob, light cover, cable clip.
- A CadQuery `.py` file, parametric model, or STL/STEP output.
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
- **Source = the `.py` file (or project) you wrote**. STEP, STL, and the
  metadata sidecar are *derived*. When the user asks for a change, edit the
  `.py` and re-generate. Do not edit the STL or STEP.
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
- ``--mesh-tolerance MM`` linear meshing tolerance for the STL (default 0.05)
- ``--angular-tolerance DEG``  angular meshing tolerance for the STL (default 3°)
- ``--wall-clock-s S``    subprocess timeout (default 30; bump for complex parts)

Use ``--help`` for the full flag set. Always pass an **absolute path** for
``<input.py>`` or ``<project_dir>`` — the agent's cwd may not be the
user's workspace.

**`scripts/cad`** — primary tool. Runs the CadQuery file (or project) in
an isolated subprocess (rlimit + restricted imports + 30s wall-clock kill)
and writes the canonical artifact set next to the source via the cadpy
pipeline:

- `<name>.step` — full B-rep archival, with XCAF labels + colors.
- `<name>.stl` — slicer-ready mesh, always written. It is also the mesh the
  viewer renders as the preview.
- `<name>.step.json` — source hash, generator metadata, validation summary
  (``is_solid``, ``volume_mm3``, mesh tolerances).

Prints a single JSON line on stdout matching the Panda skill stdout
contract (§3 in ``docs/panda-interfaces.md``):
``{ok, step_path, stl_path, metadata_path, is_solid, volume_mm3, bbox,
error?}``.

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
anchor first. (In Panda's planning phase this becomes the user-facing
spec — see [Plan-phase design discipline](#plan-phase-design-discipline).)

### 4. Edit the `.py`

Write the file with:
- A 1-line docstring at top describing the part.
- Named parameters with units in comments (`PHONE_W = 77  # iPhone 15 PM`).
- A single ``gen_step()`` function at module scope that returns the final
  ``cq.Workplane`` / ``cq.Shape`` / ``cq.Assembly`` (or an envelope
  ``dict`` if you need to tune mesh tolerance — see
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

This compiles, checks `is_solid`, exports STEP + STL + metadata, and prints
a JSON line.

### 6. Read the failure (or the render)

Don't skip this step. Even when `ok=true is_solid=true`, geometry can be
visually wrong:

- **Resolve `warnings` first.** The JSON's ``warnings`` array lists
  deterministic defects cadpy already found — `disconnected_bodies` (a part is
  several detached solids → something floats), `sliver`, `invalid_brep`. Any
  warning is blocking; go to step 7.
- **Look at every part, not just the assembly.** Run
  ``python scripts/review <project_dir>`` — it renders the assembled model and
  *each named part* to multi-view (iso + top) PNGs under ``<stem>_review/`` and
  re-lists the warnings. `Read` each PNG. The top view exposes features that sit
  outside the body footprint; the iso exposes members poking through plates.
  A whole-assembly preview hides a floating standoff *inside* a tray or a small
  spike on one part — per-part views do not.
- **Justify each part.** For every part, state in one line what it is for and
  what it connects to (which mounting interface / mating face). If you cannot
  justify a part, or it does not connect to anything, it is a defect — fix it.
- Compare against the user's prompt and any reference image.
- Check the bbox in the JSON: does it match the intent (right order of
  magnitude, fits on a 200×200mm bed)?

If anything is off — compile error, non-solid, a warning, a floating or
purposeless part, a member protruding through a plate, wrong proportions,
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

- The agent **never** edits the generated STEP / STL / metadata sidecar.
  Edit `.py`, re-generate.
- Every generated `.py` (or project ``main.py``) defines exactly one
  ``gen_step()`` at module scope, OR for trivial single-file scripts
  assigns the final shape to a module-level ``result``. cadpy accepts
  both.
- Every CadQuery `.py` starts with `import cadquery as cq` and uses `cq.`
  throughout. CadQuery is the only modeling library available.
- Run `scripts/cad` (or at minimum `scripts/check`) before declaring done.
  Never claim a model is printable from reading code alone.
- Never declare done with a non-empty `warnings` array, a floating/disconnected
  part, or a part you cannot justify. For assemblies, run `scripts/review` and
  inspect **every** per-part render — not just the assembled preview.
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
- `references/kinematic-placement.md` — **mechanism** placement: parts that
  share a *moving* joint or form a closed loop (four-bar / Hoeken walking legs,
  crank + coupler + rocker, scissor lift, pantograph, steering linkage). Solve
  the joint so the shared pin coincides instead of eyeballing each link's angle.
  **Load before placing any linkage** — guessed angles leave joints apart and
  trip `disconnected_bodies`. The four-bar helper lives in `cadlib.kinematics`.

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
from cadlib.kinematics import solve_fourbar, place_two_point, circle_intersections
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

Both currently produce a single assembled ``result`` for the preview
— a v0 single-file shape. New designs should wrap that final shape in a
``gen_step()`` function instead. For multi-part products where each piece
prints separately, follow the ``cq.Assembly`` pattern in
``references/assembly.md`` — cadpy preserves part names, colors, and
locations in the STEP file.

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
| draft angle, taper a wall, stacking/nesting parts, tapered release | `references/patterns/draft-angle.md` |
| magnet, magnetic closure, N42 / N52, neodymium | `references/patterns/magnet-pocket.md` |
| bearing, 608 / 688 / 6800, skate bearing, pulley | `references/patterns/bearing-seat.md` |
| cable channel, wire routing, strain relief, USB cable | `references/patterns/cable-channel.md` |
| floating part, disconnected bodies, standoff on a curved wall, strut into a plate, "part not attached" | `references/patterns/anchor-to-body.md` |
| four-bar / 4-bar linkage, crank + coupler + rocker, Hoeken / Klann / Jansen walking leg, scissor lift, pantograph, "joints must meet", legs hanging disconnected | `references/patterns/four-bar-linkage.md` |

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
2. **Output path** — the STEP for archival inspection plus the STL absolute
   path the user can drag into a slicer.
3. **Bounding box + volume** so the user knows it'll fit on a 200×200mm bed.
4. **Tweakable parameters** — the variables at the top of the `.py` and what they do.
5. **Assumptions** — one or two bullets for anything geometry-changing you defaulted (case allowance, screw size, tilt direction).

Skip anything else. The user wants a printable file, not a thesis.
