#!/usr/bin/env python3
"""Shared helpers for model-crawl's site adapters: HTTP fetch, readme
rendering, manifest append. Site-specific logic lives in site_printables.py
(GraphQL API) and site_generic.py (best-effort HTML/JSON-LD/OG scrape) —
both adapters resolve down to the same shape so fetch_model_folder.py can
treat them identically.

Adapter contract: a `fetch(url, formats, max_images)` function returning
`(meta, file_targets, image_targets)` where:
  - meta: dict, see build_readme() below for the fields it reads
  - file_targets: [(local_filename, download_url), ...] — model files to save
  - image_targets: [(local_filename, download_url), ...] — showcase images to save
"""
import csv
import os
import re
import sys
import time
import urllib.error
import urllib.request

# Rotated across retry attempts — a real desktop/mobile browser spread, not
# just a version bump, since some bot-walls key off OS/device class too.
USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
]
UA = USER_AGENTS[0]  # back-compat single UA (used as-is by site_printables.py, which is never blocked)

STEP_RE = re.compile(r"\.(step|stp)$", re.IGNORECASE)
MODEL_EXT_RE = re.compile(r"\.(step|stp|stl|3mf|obj|iges|igs|ply|gltf|glb|fbx|skp)$", re.IGNORECASE)

# Status codes worth retrying: transient rate-limiting/server hiccups, and
# bot-wall responses where a different UA/header set occasionally gets
# through even though a Cloudflare-grade WAF challenge will not budge no
# matter how many times or with what headers a plain HTTP client retries it.
RETRYABLE_STATUSES = {403, 408, 429, 500, 502, 503, 504}


def _headers_for_attempt(attempt):
    ua = USER_AGENTS[attempt % len(USER_AGENTS)]
    headers = {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    if attempt >= 1:
        # a referer sometimes matters to simple bot checks; try it from the
        # second attempt on rather than every time, in case its absence
        # was fine and this is really about the UA/backoff instead.
        headers["Referer"] = "https://www.google.com/"
    return headers


def _fetch_bytes(url, timeout, retries):
    """Best-effort fetch: retries transient/bot-wall-looking failures with
    backoff and a rotated User-Agent/header set before giving up. Returns
    (bytes, attempts_made) on success; raises the last error after
    exhausting retries. Does NOT retry a plain 404 — that's a real "this
    doesn't exist," not a block worth working around."""
    last_err = None
    for attempt in range(retries):
        req = urllib.request.Request(url, headers=_headers_for_attempt(attempt))
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read(), attempt + 1
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code not in RETRYABLE_STATUSES:
                raise
        except Exception as e:  # noqa: BLE001 — URLError, timeout, connection reset, etc.
            last_err = e
        if attempt < retries - 1:
            wait = 1.5 * (attempt + 1)
            print(f"  ... attempt {attempt + 1}/{retries} failed ({last_err}), retrying in {wait:.1f}s", file=sys.stderr)
            time.sleep(wait)
    raise last_err


def fetch_text(url, timeout=20, retries=5):
    data, attempts = _fetch_bytes(url, timeout, retries)
    if attempts > 1:
        print(f"  (fetched after {attempts} attempts)", file=sys.stderr)
    return data.decode("utf-8", errors="replace")


def download_binary(url, dest_path, timeout=60, retries=5):
    try:
        data, attempts = _fetch_bytes(url, timeout, retries)
    except Exception as e:  # noqa: BLE001
        print(f"  ! download failed after retries ({url}): {e}", file=sys.stderr)
        return False
    with open(dest_path, "wb") as f:
        f.write(data)
    if attempts > 1:
        print(f"  (downloaded after {attempts} attempts)", file=sys.stderr)
    return True


def sanitize(s, maxlen=120):
    s = re.sub(r"[^A-Za-z0-9._ -]", "_", s)
    return s.strip()[:maxlen] or "file"


def fmt_list(vals):
    return ", ".join(str(v) for v in vals if v is not None) or "n/a"


def build_readme(meta, downloaded_files, step_present):
    """meta fields (all optional except name/source_url):
    name, source_url, site, author, published, category, tags (list),
    license, summary, description_md, notes (list),
    stats: dict subset of {downloads, likes, rating, rating_count, views,
        remixes, makes},
    print_settings: dict subset of {printer, materials, layer_heights,
        nozzle_diameters, print_duration, weight, num_pieces}
    """
    lines = [f"# {meta['name']}", ""]
    lines.append(f"- **Source**: [{meta['source_url']}]({meta['source_url']})")
    if meta.get("author"):
        lines.append(f"- **Author**: {meta['author']}")
    if meta.get("published"):
        lines.append(f"- **Published**: {meta['published']}")
    if meta.get("category"):
        lines.append(f"- **Category**: {meta['category']}")
    if meta.get("tags"):
        lines.append(f"- **Tags**: {', '.join(meta['tags'])}")
    if meta.get("license"):
        lines.append(f"- **License**: {meta['license']}")
    lines.append("")

    lines.append("## Files downloaded")
    if downloaded_files:
        for fname in downloaded_files:
            lines.append(f"- `{fname}`")
    else:
        lines.append("- _none — no downloadable 3D-model file could be retrieved_")
    if not step_present:
        lines.append("")
        lines.append(
            "> ⚠️ No STEP/STP file was retrieved for this model — the formats "
            "above (if any) are the closest available. Treat any downstream "
            "reconstruction as approximate/inspired rather than exact."
        )
    lines.append("")

    stats = meta.get("stats") or {}
    if any(v is not None for v in stats.values()):
        lines.append("## Stats")
        if stats.get("downloads") is not None:
            lines.append(f"- Downloads: {stats['downloads']}")
        if stats.get("likes") is not None:
            lines.append(f"- Likes: {stats['likes']}")
        if stats.get("rating") is not None:
            lines.append(f"- Rating: {stats['rating']} ({stats.get('rating_count', 'n/a')} ratings)")
        if stats.get("views") is not None:
            lines.append(f"- Views: {stats['views']}")
        if stats.get("remixes") is not None or stats.get("makes") is not None:
            lines.append(f"- Remixes: {stats.get('remixes', 'n/a')}, Makes: {stats.get('makes', 'n/a')}")
        lines.append("")

    ps = meta.get("print_settings") or {}
    if any(v not in (None, [], "") for v in ps.values()):
        lines.append("## Print settings (as published)")
        if ps.get("printer"):
            lines.append(f"- Printer: {ps['printer']}")
        if ps.get("materials"):
            lines.append(f"- Materials: {fmt_list(ps['materials'])}")
        if ps.get("layer_heights"):
            lines.append(f"- Layer heights: {fmt_list(ps['layer_heights'])}")
        if ps.get("nozzle_diameters"):
            lines.append(f"- Nozzle diameters: {fmt_list(ps['nozzle_diameters'])}")
        if ps.get("print_duration"):
            lines.append(f"- Print duration (declared): {ps['print_duration']}")
        if ps.get("weight"):
            lines.append(f"- Weight (declared): {ps['weight']}")
        if ps.get("num_pieces") is not None:
            lines.append(f"- Number of pieces: {ps['num_pieces']}")
        lines.append("")

    if meta.get("summary"):
        lines.append("## Summary")
        lines.append(meta["summary"])
        lines.append("")

    lines.append("## Description")
    lines.append(meta.get("description_md") or "_no description found_")
    lines.append("")

    if meta.get("notes"):
        lines.append("## Crawl notes")
        for n in meta["notes"]:
            lines.append(f"- {n}")
        lines.append("")

    return "\n".join(lines)


def materialize(meta, file_targets, image_targets, folder):
    """Download an adapter's (meta, file_targets, image_targets) result into
    `folder` and write design_readme.md — the shared "last mile" logic so
    it exists in exactly one place regardless of which adapter ran.
    Returns (downloaded_files, step_present)."""
    os.makedirs(folder, exist_ok=True)

    downloaded_files = []
    for fname, url in file_targets:
        dest = os.path.join(folder, fname)
        if os.path.exists(dest):
            downloaded_files.append(fname)
            continue
        if download_binary(url, dest):
            downloaded_files.append(fname)
            print(f"  + {fname} ({os.path.getsize(dest)} bytes)")
    step_present = any(STEP_RE.search(f) for f in downloaded_files)

    if image_targets:
        images_dir = os.path.join(folder, "showcase_images")
        os.makedirs(images_dir, exist_ok=True)
        for fname, url in image_targets:
            dest = os.path.join(images_dir, fname)
            if os.path.exists(dest):
                continue
            if download_binary(url, dest):
                print(f"  + showcase_images/{fname}")

    readme = build_readme(meta, downloaded_files, step_present)
    with open(os.path.join(folder, "design_readme.md"), "w") as f:
        f.write(readme)
    print("  + design_readme.md")

    return downloaded_files, step_present


def append_manifest(manifest_path, row):
    fieldnames = ["model_id", "name", "slug", "author", "downloadCount", "url", "files", "num_step_files"]
    exists = os.path.exists(manifest_path)
    if exists:
        with open(manifest_path) as f:
            existing_slugs = {r["slug"] for r in csv.DictReader(f)}
        if row["slug"] in existing_slugs:
            print(f"  (manifest already has {row['slug']!r}, not duplicating)")
            return
    with open(manifest_path, "a", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        if not exists:
            writer.writeheader()
        writer.writerow(row)
