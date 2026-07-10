#!/usr/bin/env python3
"""Generate the Vibe app icons from the brand mark.

The source of truth is the raster master at
`desktop/src-tauri/icons/logo-source.png` (the Vibe cube mark). This script
resizes it into every icon slot the app needs. Run with any Python that has
Pillow (the bundled CPython does):

    desktop/src-tauri/resources/python/bin/python3 \
        scripts/build/gen-logo.py

Writes:
  desktop/src-tauri/icons/{logo-1024.png,icon.png,icon.ico}  (Tauri OS app icon)
  viewer/src/client/assets/{favicon.png,favicon.ico}         (in-app logo + favicon)
"""
import os, sys
from PIL import Image

SOURCE = "logo-source.png"   # brand master, lives next to the generated icons


def load_master():
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.normpath(os.path.join(here, "..", ".."))
    src = os.path.join(root, "desktop", "src-tauri", "icons", SOURCE)
    master = Image.open(src).convert("RGBA")
    # Normalize to a square 1024 master so every downstream size is a clean
    # downscale (LANCZOS) rather than a mixed up/down resample.
    return master.resize((1024, 1024), Image.LANCZOS)


def main():
    master = load_master()

    # Optional explicit output path renders just the 1024 master (used for previews).
    if len(sys.argv) > 1:
        master.save(sys.argv[1])
        print("wrote", sys.argv[1])
        return

    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.normpath(os.path.join(here, "..", ".."))
    icons = os.path.join(root, "desktop", "src-tauri", "icons")
    assets = os.path.join(root, "viewer", "src", "client", "assets")
    ico_sizes = [(s, s) for s in (16, 32, 48, 64, 128, 256)]

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
