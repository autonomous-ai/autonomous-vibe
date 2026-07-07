#!/usr/bin/env python3
"""
fetch_model_folder.py — turn ANY model-listing webpage URL into a
self-contained design folder: the model's real 3D-model file(s) (STEP
preferred where discoverable, falling back to whatever formats the site
actually publishes/exposes), a design_readme.md with whatever metadata
could be found, and a showcase_images/ folder of gallery photos.

    python fetch_model_folder.py <model-url> [--out-dir DIR] [--formats step,stl,3mf,obj]
                                              [--max-images N] [--manifest CSV_PATH]

SITE DISPATCH. printables.com URLs use `site_printables.py`, a dedicated
adapter that talks directly to printables' public GraphQL API — rich
metadata AND a real per-file download link, no HTML scraping at all (see
`../references/printables-graphql-api.md`). Every other URL uses
`site_generic.py`, a best-effort HTML/JSON-LD/Open-Graph scraper (see
`../references/generic-site-scraping.md`) — it usually finds good metadata
and images, but on JS-heavy single-page-app sites (Thingiverse, MakerWorld,
Cults3D, ...) the actual model file often isn't in the initial HTML and
won't be retrieved; this is reported plainly via a "Crawl notes" section in
the readme, never silently.

To add a dedicated adapter for another site (once you've confirmed it has
a stable API or a reliably-scrapable file list, the way printables.com's
GraphQL API was confirmed): write a new `site_<name>.py` with a `matches(url)`
predicate and a `fetch(url, formats, max_images) -> (meta, file_targets,
image_targets)` function matching the contract in `common.py`, then add it
to the ADAPTERS list below, before `site_generic`.

OUTPUT LAYOUT:

    <out-dir>/<slug>/
      <original filename(s), one per downloaded 3D-model file>
      design_readme.md
      showcase_images/
        00.<ext>
        01.<ext>
        ...

If `--manifest CSV_PATH` is given, appends one row
(model_id,name,slug,author,downloadCount,url,files,num_step_files) to that
CSV, creating it with a header if needed, skipping if the model's slug is
already present. `model_id`/`downloadCount` are blank for generic-site rows
(that data doesn't exist outside printables.com).

DEPENDENCIES. Only `html2text` is non-stdlib (used by the printables
adapter); everything else is stdlib. Run via:

    uv run --python 3.12 --with html2text python scripts/fetch_model_folder.py <url> ...
"""
import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import common
import site_generic
import site_printables

ADAPTERS = [site_printables, site_generic]  # first match wins; generic is always last


def pick_adapter(url):
    for adapter in ADAPTERS:
        if adapter.matches(url):
            return adapter
    return site_generic  # unreachable given site_generic.matches() is always True


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("url", help="model page URL (printables.com gets a dedicated fast path; any other site uses a best-effort generic scrape)")
    ap.add_argument("--out-dir", default=".", help="parent directory the <slug>/ folder is created under (default: cwd)")
    ap.add_argument("--formats", default="", help="comma-separated extensions to prefer, e.g. step,stp (default: STEP if found, else whatever the source publishes)")
    ap.add_argument("--max-images", type=int, default=5, help="max showcase images to download (default: 5)")
    ap.add_argument("--manifest", default=None, help="optional manifest.csv to append a row to")
    args = ap.parse_args()

    formats = {ext.strip().lower().lstrip(".") for ext in args.formats.split(",") if ext.strip()} or None

    adapter = pick_adapter(args.url)
    print(f"Adapter: {adapter.__name__}")
    meta, file_targets, image_targets = adapter.fetch(args.url, formats, args.max_images)

    slug = meta.get("slug") or re.sub(r"[^A-Za-z0-9-]", "-", meta["name"]).strip("-").lower() or "model"
    folder = os.path.join(args.out_dir, slug)

    downloaded_files, step_present = common.materialize(meta, file_targets, image_targets, folder)

    if args.manifest:
        common.append_manifest(
            args.manifest,
            {
                "model_id": meta.get("site_id", ""),
                "name": meta["name"],
                "slug": slug,
                "author": meta.get("author") or "",
                "downloadCount": (meta.get("stats") or {}).get("downloads", ""),
                "url": meta["source_url"],
                "files": ";".join(downloaded_files),
                "num_step_files": sum(1 for f in downloaded_files if common.STEP_RE.search(f)),
            },
        )
        print(f"  + appended to {args.manifest}")

    print(f"Done: {folder}")
    if not step_present:
        print("NOTE: no STEP file was retrieved for this model.", file=sys.stderr)


if __name__ == "__main__":
    main()
