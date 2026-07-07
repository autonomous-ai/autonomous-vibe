#!/usr/bin/env python3
"""printables.com adapter — talks directly to the public GraphQL API
(https://api.printables.com/graphql/), no HTML scraping, no auth needed.

Full schema/gotcha reference: ../references/printables-graphql-api.md

Key facts this module relies on:
  - `print(id).stls` is misleadingly named: it lists EVERY 3D-model file
    format (STEP, STL, OBJ, 3MF...), not just STL.
  - `getDownloadLink` mutation returns a real, unauthenticated, TTL-limited
    download URL — call it only for files you're about to actually save.
  - `print(id).description` is HTML; convert with html2text.
  - `print(id).images[].filePath` is a relative key; full URL is
    `https://files.printables.com/<filePath>`.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

import html2text

from common import UA, STEP_RE, sanitize

API = "https://api.printables.com/graphql/"
MODEL_URL_RE = re.compile(r"/model/(\d+)")

_converter = html2text.HTML2Text()
_converter.body_width = 0
_converter.ignore_images = False


def matches(url):
    return "printables.com" in url


def gql(query, variables=None, retries=4, rate_limit_retries=2):
    """POST a GraphQL query, retrying transient failures. A 429 is handled
    separately from other errors: it's Cloudflare-level IP throttling (seen
    in practice after sustained crawling), not a per-request fluke, so
    retrying it on the same 1.5s*attempt cadence as a generic error just
    re-hammers a server that already told us to back off. Honor a
    `Retry-After` header if present, otherwise wait a longer fixed
    cooldown, and give up after fewer attempts."""
    payload = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = urllib.request.Request(
        API, data=payload, headers={"Content-Type": "application/json", "User-Agent": UA}
    )
    rate_limit_hits = 0
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                rate_limit_hits += 1
                if rate_limit_hits > rate_limit_retries:
                    print(f"  ! gql rate-limited ({rate_limit_hits}x), giving up on this call: {e}", file=sys.stderr)
                    return None
                cooldown = float(e.headers.get("Retry-After", 60))
                print(f"  ! gql 429, cooling down {cooldown:.0f}s before retry {rate_limit_hits}/{rate_limit_retries}", file=sys.stderr)
                time.sleep(cooldown)
                continue
            if attempt == retries - 1:
                print(f"  ! gql error: {e}", file=sys.stderr)
                return None
            time.sleep(1.5 * (attempt + 1))
        except Exception as e:  # noqa: BLE001
            if attempt == retries - 1:
                print(f"  ! gql error: {e}", file=sys.stderr)
                return None
            time.sleep(1.5 * (attempt + 1))


MODEL_QUERY = """
query($id:ID!){
  print(id:$id){
    id name slug summary description
    datePublished
    downloadCount likesCount ratingAvg ratingCount viewsCount remixCount makesCount
    tags{ name }
    category{ name path{ name } }
    license{ name abbreviation }
    printer{ name }
    materials{ name }
    printDuration
    weight
    layerHeights
    nozzleDiameters
    numPieces
    user{ publicUsername }
    images{ id filePath imageWidth imageHeight }
    stls{ id name }
  }
}
"""

DOWNLOAD_LINK_MUTATION = """
mutation($printId:ID!,$source:DownloadSourceEnum!,$files:[DownloadFileInput]){
  getDownloadLink(printId:$printId, source:$source, files:$files){
    ok
    errors{ field messages }
    output{ link }
  }
}
"""


def _extract_model_id(url):
    m = MODEL_URL_RE.search(url)
    if not m:
        sys.exit(
            f"Could not find a model id in {url!r} — expected a URL like "
            "https://www.printables.com/model/1743444-egg-dispenser"
        )
    return m.group(1)


def _get_download_link(print_id, file_id):
    data = gql(
        DOWNLOAD_LINK_MUTATION,
        {"printId": str(print_id), "source": "model_detail", "files": [{"fileType": "stl", "ids": [str(file_id)]}]},
    )
    if not data or not data.get("data") or not data["data"].get("getDownloadLink"):
        return None
    out = data["data"]["getDownloadLink"]
    if not out.get("ok"):
        print(f"  ! getDownloadLink not ok: {out.get('errors')}", file=sys.stderr)
        return None
    return out["output"]["link"]


def fetch(url, formats, max_images):
    model_id = _extract_model_id(url)
    print(f"[printables] Fetching model id={model_id} via GraphQL API ...")
    data = gql(MODEL_QUERY, {"id": model_id})
    if not data or not data.get("data") or not data["data"].get("print"):
        sys.exit(f"Could not fetch metadata for model id={model_id} (private/deleted/rate-limited?)")
    m = data["data"]["print"]
    slug = m["slug"]
    source_url = f"https://www.printables.com/model/{model_id}-{slug}"

    all_files = m.get("stls") or []
    step_files = [f for f in all_files if STEP_RE.search(f["name"])]

    if formats:
        files_to_get = [f for f in all_files if os.path.splitext(f["name"])[1].lstrip(".").lower() in formats]
        if not files_to_get:
            print(
                f"  ! none of the requested formats ({sorted(formats)}) are published; "
                f"available: {sorted({os.path.splitext(f['name'])[1] for f in all_files})}",
                file=sys.stderr,
            )
    else:
        files_to_get = step_files if step_files else all_files

    print(
        f"[printables] {m['name']!r} (slug={slug}) — {len(all_files)} file(s) published, "
        f"{'STEP available' if step_files else 'NO STEP available'}, resolving {len(files_to_get)} download link(s)"
    )

    file_targets = []
    for f in files_to_get:
        link = _get_download_link(model_id, f["id"])
        time.sleep(0.15)
        if not link:
            print(f"  ! no download link for {f['name']}", file=sys.stderr)
            continue
        file_targets.append((sanitize(f["name"]), link))

    images = (m.get("images") or [])[:max_images]
    image_targets = []
    for idx, img in enumerate(images):
        file_path = img["filePath"]
        ext = os.path.splitext(file_path)[1] or ".jpg"
        image_targets.append((f"{idx:02d}{ext}", f"https://files.printables.com/{file_path}"))

    cat = m.get("category")
    category = None
    if cat:
        category = (
            " > ".join([p["name"] for p in cat.get("path", [])] + [cat["name"]]) if cat.get("path") else cat["name"]
        )
    lic = m.get("license")
    license_str = f"{lic['name']} ({lic['abbreviation']})" if lic else None

    desc_html = m.get("description") or ""
    description_md = _converter.handle(desc_html).strip() if desc_html else "_no description provided_"

    meta = {
        "name": m["name"],
        "source_url": source_url,
        "site": "printables",
        "site_id": model_id,
        "slug": slug,
        "author": m["user"]["publicUsername"],
        "published": m.get("datePublished"),
        "category": category,
        "tags": [t["name"] for t in (m.get("tags") or [])],
        "license": license_str,
        "summary": m.get("summary"),
        "description_md": description_md,
        "notes": [],
        "stats": {
            "downloads": m.get("downloadCount"),
            "likes": m.get("likesCount"),
            "rating": m.get("ratingAvg"),
            "rating_count": m.get("ratingCount"),
            "views": m.get("viewsCount"),
            "remixes": m.get("remixCount"),
            "makes": m.get("makesCount"),
        },
        "print_settings": {
            "printer": m["printer"]["name"] if m.get("printer") else None,
            "materials": [mm["name"] for mm in (m.get("materials") or [])],
            "layer_heights": m.get("layerHeights") or [],
            "nozzle_diameters": m.get("nozzleDiameters") or [],
            "print_duration": m.get("printDuration"),
            "weight": m.get("weight"),
            "num_pieces": m.get("numPieces"),
        },
    }
    return meta, file_targets, image_targets
