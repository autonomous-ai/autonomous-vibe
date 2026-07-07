---
name: shape-analysis
description: Enrich a short or vague 3D-object prompt into a detailed, print-ready design brief before modeling. Use when the user asks for an object in a few words — "phone stand", "wall hook", "pen holder", "planter", "GoPro mount" — and the request lacks dimensions, features, style, or ergonomic detail. Analyzes the intended shape and returns a structured brief with popular, well-considered defaults so the generated object comes out refined and appealing rather than generic.
---

# Shape Analysis — prompt enrichment for 3D parts

## Purpose

A short prompt like "phone stand" underspecifies the object: it says nothing
about angle, phone size, cable routing, footprint, or style. Modeling it
literally yields a bland box. This skill turns a terse description into a
**detailed design brief** — the shape, the dimensions, the popular features
people actually expect for that object — so the downstream CAD step produces
something refined and appealing.

This is a **read-only, no-artifact** skill. It writes no files and generates no
geometry. Its only output is one enriched design brief, which the user (or the
`cadcode` skill) then turns into a model.

## When to use

- The user names an object in a few words with no dimensions, features, or style.
- The prompt is ambiguous about intended use, target fit (a phone, a bike rail,
  an M3 bolt), or aesthetic.
- The user explicitly asks to "make it nicer / more polished / more popular".

Do **not** use it when the user already gave a complete spec, is editing an
existing `.py` part, or asked for an exact literal shape ("a 20 mm cube").

## Workflow

1. **Classify the object.** Map the prompt to a known object category (stand,
   mount, holder, tray, hook, enclosure, planter, adapter, bracket, …). If the
   category is unclear, pick the most common reading and state the assumption.

2. **Infer the target it must fit.** Many objects exist to hold or attach to
   something else. Resolve real reference dimensions:
   - Consumer devices → typical real sizes (a modern phone ≈ 75 × 160 × 8 mm).
   - Fasteners / rails / standards → look them up rather than guessing.
   - When a fit dimension drives the whole part, call it out explicitly and add
     a printing clearance (0.2–0.4 mm for FDM slip fits).

3. **Add the popular features.** For the category, list the features that make
   the object genuinely useful and that most well-liked versions include —
   e.g. a phone stand gets an adjustable viewing angle (~60°), a cable channel,
   a lip to stop the phone sliding, and a stable weighted base. Prefer features
   that are printable without supports.

4. **Set concrete dimensions.** Give real numbers, not "medium". Include
   overall envelope, wall thickness (≥ 2 mm for structural FDM), and any
   critical internal dimension. Keep the footprint stable (wide base, low
   center of mass).

5. **Choose a style.** A short aesthetic direction: minimal / geometric /
   organic / utilitarian. Note fillet radii on handled or visible edges
   (2–4 mm reads as "finished", sharp reads as "prototype").

6. **Respect print reality.** Flag overhangs > 45°, thin unsupported spans,
   and anything needing supports. Prefer a flat, large first-layer face and a
   single-piece design unless a split obviously helps.

7. **Emit one brief** in the format below and stop. Do not model anything.

## Output format

Return exactly one fenced ```design-brief block containing the enriched spec as
JSON, followed by a 2–3 sentence plain-language summary. Keep every dimension in
millimeters.

```design-brief
{
  "object": "phone stand",
  "category": "stand",
  "fits": { "target": "modern smartphone", "ref_mm": [75, 160, 8], "clearance_mm": 0.3 },
  "envelope_mm": [90, 80, 70],
  "wall_mm": 2.4,
  "features": [
    "60° viewing angle",
    "front lip 8 mm to retain the phone",
    "rear cable channel 12 mm wide",
    "wide weighted base for stability"
  ],
  "style": "minimal, geometric, 3 mm filleted visible edges",
  "print": { "orientation": "base flat on bed", "supports": false, "notes": "no overhang > 45°" },
  "assumptions": ["single phone, portrait orientation", "PLA on an FDM printer"]
}
```

Then: a short summary the user can approve or tweak, e.g. *"A minimal 90×80 mm
portrait phone stand at a 60° angle, with a retaining lip, a rear cable channel,
and a wide base for stability — printable flat with no supports. Adjust the
angle or add a landscape slot if you like."*

## Handoff

This skill is standalone: it produces a brief, not a model. When the user wants
the object built, hand the enriched brief to the `cadcode` skill as the design
input — its concrete dimensions and feature list are exactly what cadcode needs
to generate a good `.py` part on the first pass. If the user only asked for
analysis, stop after the brief.

## Guidance

- Default to **popular, safe, printable** choices; call out every assumption so
  the user can correct it in one message.
- Never invent a precise reference dimension you are unsure of — look it up or
  mark it as an estimate.
- Keep briefs tight. More detail than a modeler can act on is noise; aim for the
  handful of decisions that most change how the finished object looks and works.
