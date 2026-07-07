"""Demo: render sample STLs with the QA look vs. the new hero-cover look.

Run from packages/cadpy:
    PYTHONPATH=src python examples_thumbnail_demo.py
Outputs PNGs into ./_thumb_demo/ (opens nothing; paths printed at the end).
"""
import os
import trimesh

from cadpy.render_part import render_stl_to_png

OUT = os.path.join(os.path.dirname(__file__), "_thumb_demo")
os.makedirs(OUT, exist_ok=True)

# ---- A few sample parts (stand in for generated projects) ------------------
def phone_stand():
    base = trimesh.creation.box(extents=(70, 90, 6))
    back = trimesh.creation.box(extents=(70, 6, 60))
    back.apply_translation((0, -42, 30))
    back.apply_transform(trimesh.transformations.rotation_matrix(0.5, (1, 0, 0), (0, -42, 6)))
    return trimesh.util.concatenate([base, back])

def bracket():
    a = trimesh.creation.box(extents=(60, 8, 40))
    b = trimesh.creation.box(extents=(60, 40, 8))
    b.apply_translation((0, 16, -16))
    return trimesh.util.concatenate([a, b])

def vase():
    return trimesh.creation.cylinder(radius=25, height=80, sections=64)

SAMPLES = {"phone_stand": phone_stand, "bracket": bracket, "vase": vase}

# Curated filament palette + gradient backdrop (the "better capture" recipe).
PALETTE = {
    "phone_stand": (0.910, 0.475, 0.169),  # orange
    "bracket":     (0.204, 0.702, 0.831),  # cyan
    "vase":        (0.486, 0.361, 0.839),  # violet
}

def hero_bg(color):
    """Soft vertical gradient: near-white top → light tint of the color."""
    mix = lambda k: tuple(c * k + (1.0 - k) for c in color)
    return (mix(0.06), mix(0.30))

paths = []
for name, make in SAMPLES.items():
    mesh = make()
    stl = os.path.join(OUT, f"{name}.stl")
    mesh.export(stl)

    # 1) QA look — unchanged defaults (7-view slate-blue grid).
    qa = render_stl_to_png(stl, os.path.join(OUT, f"{name}_QA.png"))

    # 2) Hero cover — single iso, filament color, gradient bg, zoomed to fill.
    color = PALETTE[name]
    hero = render_stl_to_png(
        stl, os.path.join(OUT, f"{name}_HERO.png"),
        views=(("", 24.0, -58.0),),      # one iso panel, no title
        base_color=color, bg=hero_bg(color),
        size=900, zoom=1.5,
    )
    paths += [qa, hero]

print("Wrote:")
for p in paths:
    if p:
        print(f"  {p}  ({os.path.getsize(p)} bytes)")
