#!/usr/bin/env python3
"""Generate the Panda app icons from the panda mark.

Source of truth for the design lives here and in icons/logo.svg.
Run with the bundled CPython (it has Pillow):

    desktop/src-tauri/resources/python/bin/python3 \
        scripts/build/gen-logo.py

Writes:
  desktop/src-tauri/icons/{logo-1024.png,icon.png,icon.ico}  (Tauri OS app icon)
  viewer/src/client/assets/{favicon.png,favicon.ico}         (in-app logo + favicon)
"""
import os, sys
from PIL import Image, ImageDraw

SS = 4                     # supersample factor for antialiasing
U = 1024                   # design units
S = U * SS

def p(v):                  # design unit -> supersampled px
    return int(round(v * SS))

# Palette — matches the app's monochrome zinc theme
BG    = (24, 24, 27, 255)    # zinc-900  #18181b  (rounded-square background)
WHITE = (250, 250, 250, 255) # head
INK   = (17, 17, 20, 255)    # ears / patches / nose
EYE   = (250, 250, 250, 255) # eye whites

def rotated_ellipse(base, cx, cy, w, h, angle, fill):
    layer = Image.new("RGBA", (p(w), p(h)), (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse([0, 0, p(w) - 1, p(h) - 1], fill=fill)
    layer = layer.rotate(angle, resample=Image.BICUBIC, expand=True)
    base.alpha_composite(layer, (p(cx) - layer.width // 2, p(cy) - layer.height // 2))

def build():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # rounded-square background (full bleed; macOS masks its own squircle)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=p(232), fill=BG)

    # ears — white circles poking above the head, with a dark inner-ear
    for cx in (330, 694):
        d.ellipse([p(cx - 112), p(196), p(cx + 112), p(196 + 224)], fill=WHITE)
        d.ellipse([p(cx - 48),  p(258), p(cx + 48),  p(258 + 96)],  fill=INK)

    # head — white circle (overlaps the ears into one silhouette)
    HX, HY, HR = 512, 560, 332
    d.ellipse([p(HX - HR), p(HY - HR), p(HX + HR), p(HY + HR)], fill=WHITE)

    # eye patches — iconic angled almond patches, kept apart by a white nose-bridge
    rotated_ellipse(img, 396, 548, 168, 226, 23, INK)
    rotated_ellipse(img, 628, 548, 168, 226, -23, INK)

    # eyes — white dot + dark pupil + catchlight, set inner-upper in each patch
    for ex, ey in ((434, 522), (590, 522)):
        d.ellipse([p(ex - 44), p(ey - 44), p(ex + 44), p(ey + 44)], fill=EYE)
        d.ellipse([p(ex - 21), p(ey - 18), p(ex + 21), p(ey + 24)], fill=INK)
        d.ellipse([p(ex - 4), p(ey - 13), p(ex + 13), p(ey + 4)], fill=WHITE)

    # nose — soft rounded triangle pointing down
    nx, ny = 512, 624
    d.rounded_rectangle([p(nx - 44), p(ny - 30), p(nx + 44), p(ny + 18)],
                        radius=p(26), fill=INK)
    d.polygon([(p(nx - 40), p(ny + 8)), (p(nx + 40), p(ny + 8)), (p(nx), p(ny + 52))],
              fill=INK)

    # mouth — short stem + gentle smile
    d.line([p(nx), p(ny + 46), p(nx), p(ny + 70)], fill=INK, width=p(9))
    d.arc([p(nx - 52), p(ny + 36), p(nx + 52), p(ny + 96)], start=20, end=160,
          fill=INK, width=p(9))

    return img.resize((U, U), Image.LANCZOS)

def main():
    # Optional explicit output path renders just the 1024 master (used for previews).
    if len(sys.argv) > 1:
        build().save(sys.argv[1])
        print("wrote", sys.argv[1])
        return

    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.normpath(os.path.join(here, "..", ".."))
    icons = os.path.join(root, "desktop", "src-tauri", "icons")
    assets = os.path.join(root, "viewer", "src", "client", "assets")
    ico_sizes = [(s, s) for s in (16, 32, 48, 64, 128, 256)]
    master = build()

    # Tauri OS app icon (baked into the bundle at build time — must be local files)
    master.save(os.path.join(icons, "logo-1024.png"))
    master.resize((512, 512), Image.LANCZOS).save(os.path.join(icons, "icon.png"))
    master.save(os.path.join(icons, "icon.ico"), sizes=ico_sizes)

    # In-app brand assets the viewer imports (top-bar logo + browser favicon)
    master.resize((512, 512), Image.LANCZOS).save(os.path.join(assets, "favicon.png"))
    master.save(os.path.join(assets, "favicon.ico"), sizes=ico_sizes)

    print("wrote tauri icons ->", icons)
    print("wrote viewer assets ->", assets)

if __name__ == "__main__":
    main()
