# Component integration — make it actually assemble and work

A part that is a valid solid and looks premium can still be **useless** if you
can't install the components into it. The classic failure: a MagSafe phone stand
with a neat recess for the puck — but the puck has a **captive cable with a
strain-relief connector collar** that won't pass the opening, so the charger can
never be fitted. Geometry was fine; the *product* was broken.

This doc is the discipline that prevents that. It is **function-first** — these
checks outrank looks, and a `validate()` assert or a `functional` warning that
fails means the design is not done.

## 1. Model the WHOLE real component, not a bounding box

A component is rarely just its body. Before modeling its pocket/mount, write
down everything physically attached to it that must also fit:

- **Captive cables** — a permanently-attached cable has a real diameter, a
  **strain-relief collar / connector** at the device end (wider than the
  jacket), and a length. You must route all three.
- **Connectors / plugs** — USB-C, Lightning, barrel jacks: the connector body is
  bigger than the cable and often a different cross-section.
- **Buttons, ports, lenses, vents** — must stay accessible after assembly.
- **Mating hardware** — screw heads, nuts, inserts need access + tool clearance.

Look the component up in `references/hobbyist-defaults.md` (MagSafe puck,
connector collars, phones, bearings, motors). If it isn't there, state the
dimensions you're assuming as assumptions in the plan.

## 2. Write the assembly / setup sequence

Enumerate, **in order**, how a person assembles and sets up the finished print,
and for each step name the clearance it needs:

1. *Install the MagSafe puck:* feed the cable + connector collar (Ø9 mm) through
   the **open** rear channel → seat the puck in its Ø56.4 pocket → lay the cable
   into the channel → it exits the base front. *Needs: open route, ≥Ø9 collar
   clearance, channel ≥ cable Ø.*
2. *Place the phone:* rests on the base ledge, magnet holds the lean. *Needs:
   ledge clears a cased phone; CoM inside the base.*

If a step is physically impossible with the current geometry, the design is
wrong — fix the geometry, not the sequence.

## 3. The rules that catch the common traps

- **Captive cable ⇒ OPEN route.** You can only lay a captive cable in from the
  side; you cannot thread it through a closed tunnel. Use
  `cadlib.cutouts.add_open_cable_channel` (see
  `references/patterns/cable-channel.md`), never a bored hole.
- **Size the opening for the CONNECTOR, not the jacket.** The widest thing that
  must pass is the strain-relief collar / connector body. A channel sized for
  the 3.6 mm cable blocks the 9 mm collar.
- **Insertion path must be straight + reachable.** A pocket the part itself
  walls off (no approach for the component or a tool) can't be loaded.
- **Removable when it must be removable.** If the user swaps the component, don't
  trap it behind a one-way snap.
- **Keep ports/buttons/cables accessible** after everything is together.

## 4. Enforce it — two mechanisms, use both

Encode each requirement so it can't silently regress (see the project template
`validation.py` and `references/project-structure.md`):

- **Hard `validate(p)` asserts** for true fit constraints that make the build
  *impossible* — `assert pocket_dia > puck_dia`, `assert back_wall >= 2.0`. A
  failed assert blocks the build (surfaces as `VALIDATION_FAILED`).
- **Soft `functional` warnings** for assembly-feasibility — return them from
  `functional_checks(p)` and merge into the envelope:
  `return {"shape": shape, "warnings": functional_checks(p)}`. Each entry:
  `{"part": <name>, "kind": "functional", "detail": "...", "severity": "warning"}`.
  The part still builds + renders, and the driver's **functional-review loop**
  won't finish while any remain. Example:

  ```python
  def functional_checks(p):
      w = []
      if p.connector_dia + p.channel_clearance < p.connector_dia:
          w.append({"part": "stand", "kind": "functional",
                    "detail": "connector pocket cannot clear the collar — puck "
                              "won't install", "severity": "warning"})
      return w
  ```

See `assets/example_magsafe_stand.py` for the whole pattern done right.

## 5. Verify against the render

In the build loop (SKILL.md step 6), after `scripts/review`, walk the assembly
sequence against the per-part PNGs: for each step, can the component (and its
cable/connector) actually get to where it needs to be? Fix and re-run until both
`validate()` passes and `functional_checks()` returns empty. **Never declare done
while a `functional` warning or a failed assert remains.**
