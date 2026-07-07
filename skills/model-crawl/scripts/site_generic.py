#!/usr/bin/env python3
"""Generic fallback adapter — best-effort metadata + file/image discovery
for any model-listing webpage that isn't printables.com (no site-specific
API integration). See ../references/generic-site-scraping.md for the full
technique, its limits, and how to add a dedicated adapter for a new site.

Strategy, cheapest/most-structured signal first:
  1. JSON-LD (`<script type="application/ld+json">`, schema.org Product /
     CreativeWork / 3DModel) — many catalog sites emit this for SEO. Best
     source when present: name, description, author, image(s), license,
     datePublished, keywords.
  2. Open Graph / Twitter Card meta tags — near-universal fallback.
  3. Plain `<title>` / `<meta name="description">` — last resort for name
     and summary.
  4. A regex sweep of the raw HTML for links ending in a known 3D-model
     extension, and a generic `<img src>` sweep for showcase images.

The raw-HTML pass above will often find rich metadata but NO downloadable
model file on JS-heavy single-page-app sites (Thingiverse, MakerWorld,
Cults3D, ...) whose file lists load via an API call after page load rather
than being present in the initial HTML. To do better than just reporting
that and giving up, this module also tries a second, genuinely different
approach when the raw-HTML file sweep comes up empty (or the raw fetch
failed outright): a JS-rendering "reader" proxy (`r.jina.ai`) that actually
executes the page's JavaScript server-side and returns the rendered
content as markdown. This is a genuinely different fetch mechanism, not
just another retry of the same one — worth trying automatically before
reporting failure, but its own failure (also challenge-blocked) is
reported just as honestly as the direct fetch's.
"""
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request

from common import UA, USER_AGENTS, MODEL_EXT_RE, STEP_RE, sanitize, fetch_text

JSON_LD_RE = re.compile(r'<script[^>]+type="application/ld\+json"[^>]*>(.*?)</script>', re.S | re.I)
META_TAG_RE = re.compile(r'<meta\s+([^>]+)>', re.I)
TITLE_RE = re.compile(r'<title[^>]*>(.*?)</title>', re.S | re.I)
IMG_SRC_RE = re.compile(r'<img[^>]+src="([^"]+)"', re.I)
FILE_LINK_RE = re.compile(r'(?:href|src)="([^"?#"]+\.(?:step|stp|stl|3mf|obj|iges|igs|ply|gltf|glb|fbx|skp))(?:[?#][^"]*)?"', re.I)
SKIP_IMAGE_RE = re.compile(r'\.(svg|ico|gif)$|logo|icon|avatar|sprite', re.I)

READER_PROXY = "https://r.jina.ai/{url}"
MARKDOWN_LINK_RE = re.compile(r'\]\(([^)\s]+)\)')
CHALLENGE_MARKERS = ("just a moment", "performing security verification", "captcha", "enable javascript and cookies")
# A JS-render can surface a real filename as plain text (e.g. a filename
# label next to a client-side "Download" button with no static href).
# Not downloadable without a URL, but worth surfacing by name rather than
# reporting "nothing found" when something plainly is.
FILENAME_TEXT_RE = re.compile(r'\b([\w][\w.\-]*\.(?:step|stp|stl|3mf|obj|iges|igs|ply|gltf|glb|fbx|skp))\b', re.I)


def matches(url):
    return True  # fallback adapter — always applicable


def _attr(attrs_str, name):
    m = re.search(rf'{name}="([^"]*)"', attrs_str, re.I)
    return html.unescape(m.group(1)) if m else None


def _parse_meta_tags(page_html):
    og, twitter, misc = {}, {}, {}
    for attrs in META_TAG_RE.findall(page_html):
        prop = _attr(attrs, "property") or _attr(attrs, "name")
        content = _attr(attrs, "content")
        if not prop or content is None:
            continue
        if prop.startswith("og:"):
            og[prop[3:]] = content
        elif prop.startswith("twitter:"):
            twitter[prop[8:]] = content
        elif prop == "description":
            misc["description"] = content
        elif prop in ("author", "keywords"):
            misc[prop] = content
    return og, twitter, misc


def _parse_json_ld(page_html):
    """Merge every JSON-LD block of a recognised type; first non-empty value
    per key wins — catalog sites sometimes split structured data across
    multiple blocks."""
    merged = {}
    for raw in JSON_LD_RE.findall(page_html):
        raw = html.unescape(raw.strip())
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            continue
        candidates = obj if isinstance(obj, list) else [obj]
        for c in candidates:
            if not isinstance(c, dict):
                continue
            types = c.get("@type")
            types = types if isinstance(types, list) else [types]
            if not any(t in ("Product", "CreativeWork", "3DModel", "Article") for t in types if t):
                continue
            for k, v in c.items():
                if k not in merged or merged[k] in (None, "", []):
                    merged[k] = v
    return merged


def _extract_author(json_ld):
    author = json_ld.get("author") or json_ld.get("brand")
    if isinstance(author, dict):
        return author.get("name")
    if isinstance(author, str):
        return author
    return None


def _collect_images(page_html, base_url, json_ld, og, max_images):
    urls, seen = [], set()

    def add(u):
        if not u:
            return
        full = urllib.parse.urljoin(base_url, html.unescape(u))
        if full in seen or SKIP_IMAGE_RE.search(full):
            return
        seen.add(full)
        urls.append(full)

    add(og.get("image"))
    img_field = json_ld.get("image")
    if isinstance(img_field, str):
        add(img_field)
    elif isinstance(img_field, list):
        for u in img_field:
            add(u)
    thumb = json_ld.get("thumbnailUrl")
    if isinstance(thumb, str):
        add(thumb)

    for src in IMG_SRC_RE.findall(page_html):
        if len(urls) >= max_images:
            break
        add(src)

    return urls[:max_images]


def _collect_files(page_html, base_url, formats):
    urls, seen = [], set()
    for m in FILE_LINK_RE.finditer(page_html):
        full = urllib.parse.urljoin(base_url, m.group(1))
        if full not in seen:
            seen.add(full)
            urls.append(full)

    if formats:
        urls = [u for u in urls if os.path.splitext(u)[1].lstrip(".").lower() in formats]
    else:
        step_urls = [u for u in urls if STEP_RE.search(u)]
        if step_urls:
            urls = step_urls
    return urls


def _looks_like_challenge(text):
    head = text[:1000].lower()
    return any(marker in head for marker in CHALLENGE_MARKERS)


def _fetch_via_reader(url, timeout=45):
    """Second, genuinely different fetch approach: a JS-rendering reader
    proxy, not another retry of the same plain-HTTP method. Returns the
    rendered markdown text, or None if the proxy itself failed or the
    target site challenge-blocked the proxy too (checked, not assumed —
    see module docstring for what this does and doesn't get past)."""
    proxy_url = READER_PROXY.format(url=url)
    req = urllib.request.Request(proxy_url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            text = resp.read().decode("utf-8", errors="replace")
    except Exception as e:  # noqa: BLE001
        print(f"  ! reader-proxy fetch failed too: {e}", file=sys.stderr)
        return None
    if _looks_like_challenge(text):
        print("  ! reader-proxy also hit a bot/JS challenge page", file=sys.stderr)
        return None
    return text


def _parse_reader_markdown(text):
    """Reader-proxy output shape: 'Title: ...\\n\\nURL Source: ...\\n\\nMarkdown Content:\\n<body>'."""
    title_m = re.search(r'^Title:\s*(.*)$', text, re.M)
    title = title_m.group(1).strip() if title_m else None
    body_m = re.search(r'Markdown Content:\s*\n(.*)', text, re.S)
    body = body_m.group(1).strip() if body_m else text
    return title, body


def _collect_links_from_markdown(markdown_text, base_url):
    urls, seen = [], set()
    for target in MARKDOWN_LINK_RE.findall(markdown_text):
        full = urllib.parse.urljoin(base_url, target)
        if full not in seen:
            seen.add(full)
            urls.append(full)
    return urls


def _derive_slug(url, name):
    path = urllib.parse.urlparse(url).path.strip("/")
    segment = path.split("/")[-1] if path else ""
    # thingiverse-style "thing:12345" — the identifying part is the numeric
    # id, not the generic word before it, so this doesn't make a usable
    # unique slug; fall through to the name-based slug instead.
    had_id_suffix = bool(re.search(r"[:=]\d+$", segment))
    segment = re.sub(r"[:=].*$", "", segment)
    if segment and not had_id_suffix and not segment.isdigit() and len(segment) > 3:
        return sanitize(segment, maxlen=80).lower()
    return sanitize(name, maxlen=80).lower().replace(" ", "-") if name else "model"


def _direct_fetch_failed_meta(url, e, reader_text):
    code = getattr(e, "code", None)
    if code in (403, 401, 429):
        diagnosis = (
            f"Direct fetch was retried across {len(USER_AGENTS)} different browser "
            f"User-Agents with backoff and still got HTTP {code}. This looks like a WAF/bot-protection "
            "wall (e.g. Cloudflare)."
        )
    else:
        diagnosis = f"Direct fetch was retried with backoff and still failed: {e}."

    if reader_text is None:
        diagnosis += (
            " A second, genuinely different approach (a JS-rendering reader proxy, "
            "r.jina.ai) was also tried and also failed or hit the same kind of "
            "challenge — this looks like the actual ceiling for automated fetching "
            "here, not a matter of retrying more. A real interactive browser "
            "session (or manually saving the page and re-running this scraper "
            "against the saved HTML) would be needed to get past it."
        )
        return {
            "name": url,
            "source_url": url,
            "site": "generic",
            "notes": [diagnosis, "No metadata, files, or images could be retrieved."],
            "description_md": "_page could not be fetched_",
        }

    # Direct fetch failed, but the reader-proxy got real (non-challenge)
    # content — use it as the sole source of metadata/files/images instead
    # of giving up.
    diagnosis += (
        " A second, genuinely different approach (a JS-rendering reader proxy, "
        "r.jina.ai) DID get through, though — its rendered content is used "
        "below instead of giving up."
    )
    title, body = _parse_reader_markdown(reader_text)
    links = _collect_links_from_markdown(body, url)
    file_urls = [u for u in links if MODEL_EXT_RE.search(u)]  # formats filtering applied by the caller
    image_urls = [u for u in links if re.search(r'\.(jpg|jpeg|png|webp)(\?|$)', u, re.I)][:5]
    notes = [diagnosis]
    if not file_urls:
        bare_names = sorted(set(FILENAME_TEXT_RE.findall(body)))
        if bare_names:
            notes.append(
                "No downloadable file URL was found, but the rendered page text "
                f"mentions a real filename: {', '.join(bare_names)}. This is likely "
                "a client-side-triggered download (a JS action calling an API, not "
                "a static link) — the file exists on the source site but isn't "
                "retrievable by this scraper; download it manually from the page."
            )
    return {
        "name": title or url,
        "source_url": url,
        "site": "generic",
        "notes": notes,
        "description_md": body[:4000] if body else "_no description found_",
        "_reader_file_urls": file_urls,
        "_reader_image_urls": image_urls,
    }


def fetch(url, formats, max_images):
    print(f"[generic] Fetching {url} (best-effort HTML scrape, retrying transient/bot-wall failures) ...")
    notes = []
    try:
        page_html = fetch_text(url)
    except Exception as e:  # noqa: BLE001
        print(f"  ! could not fetch page after retries: {e}", file=sys.stderr)
        print("  ... trying a second approach: JS-rendering reader proxy", file=sys.stderr)
        reader_text = _fetch_via_reader(url)
        meta = _direct_fetch_failed_meta(url, e, reader_text)
        reader_files = meta.pop("_reader_file_urls", [])
        reader_images = meta.pop("_reader_image_urls", [])
        if formats:
            reader_files = [u for u in reader_files if os.path.splitext(u)[1].lstrip(".").lower() in formats]
        elif any(STEP_RE.search(u) for u in reader_files):
            reader_files = [u for u in reader_files if STEP_RE.search(u)]
        file_targets = [(sanitize(os.path.basename(urllib.parse.urlparse(u).path)), u) for u in reader_files]
        image_targets = [(f"{i:02d}{os.path.splitext(urllib.parse.urlparse(u).path)[1] or '.jpg'}", u) for i, u in enumerate(reader_images[:max_images])]
        if not file_targets and reader_text is not None:
            meta["notes"].append(
                "The reader-proxy's rendered content didn't contain a recognisable "
                "3D-model file link either — it may only be reachable through the "
                "site's own UI (e.g. behind a login or a JS action, not a static link)."
            )
        return meta, file_targets, image_targets

    json_ld = _parse_json_ld(page_html)
    og, twitter, misc = _parse_meta_tags(page_html)

    name = json_ld.get("name") or og.get("title") or twitter.get("title")
    if not name:
        tm = TITLE_RE.search(page_html)
        name = html.unescape(tm.group(1)).strip() if tm else url
        notes.append("No JSON-LD or Open Graph title found; used the raw <title> tag.")
    else:
        notes.append("Used JSON-LD for metadata." if json_ld.get("name") else "Used Open Graph tags for metadata.")

    description = json_ld.get("description") or og.get("description") or twitter.get("description") or misc.get("description")
    if not description:
        description = "_no description found_"
        notes.append("No description found via JSON-LD, Open Graph, or <meta name=description>.")

    author = _extract_author(json_ld)
    tags = []
    keywords = json_ld.get("keywords") or misc.get("keywords")
    if isinstance(keywords, str):
        tags = [t.strip() for t in keywords.split(",") if t.strip()]
    elif isinstance(keywords, list):
        tags = keywords

    license_field = json_ld.get("license")
    license_str = license_field if isinstance(license_field, str) else None

    published = None
    main_entity = json_ld.get("mainEntityOfPage")
    if isinstance(main_entity, dict):
        published = main_entity.get("datePublished")
    published = published or json_ld.get("datePublished")

    image_urls = _collect_images(page_html, url, json_ld, og, max_images)
    image_targets = []
    for idx, u in enumerate(image_urls):
        # extension from the URL PATH only — some sites serve images through
        # a resize proxy with the real URL/extension buried in a query
        # string, which os.path.splitext(u) would wrongly pick up.
        ext = os.path.splitext(urllib.parse.urlparse(u).path)[1]
        if not ext or len(ext) > 5:
            ext = ".jpg"
        image_targets.append((f"{idx:02d}{ext}", u))

    file_urls = _collect_files(page_html, url, formats)
    if not file_urls:
        # The raw HTML has nothing — try a second, genuinely different
        # approach (JS-rendering reader proxy) before concluding there's no
        # file, rather than giving up on the first method's result.
        print("  (no file link in raw HTML; trying JS-rendering reader proxy before giving up)", file=sys.stderr)
        reader_text = _fetch_via_reader(url)
        if reader_text is not None:
            _, body = _parse_reader_markdown(reader_text)
            reader_links = _collect_links_from_markdown(body, url)
            reader_file_urls = [u for u in reader_links if MODEL_EXT_RE.search(u)]
            if formats:
                reader_file_urls = [u for u in reader_file_urls if os.path.splitext(u)[1].lstrip(".").lower() in formats]
            elif any(STEP_RE.search(u) for u in reader_file_urls):
                reader_file_urls = [u for u in reader_file_urls if STEP_RE.search(u)]
            if reader_file_urls:
                file_urls = reader_file_urls
                notes.append(
                    "No file link was in the page's raw HTML (common on JS-rendered "
                    "sites), but a JS-rendering reader-proxy pass found one in the "
                    "actually-rendered content."
                )
            else:
                bare_names = sorted(set(FILENAME_TEXT_RE.findall(body)))
                if bare_names:
                    notes.append(
                        "No downloadable file URL was found, but the rendered page text "
                        f"mentions a real filename: {', '.join(bare_names)}. This is "
                        "likely a client-side-triggered download (a JS action calling an "
                        "API, not a static link) — the file exists on the source site but "
                        "isn't retrievable by this scraper; download it manually from the "
                        "page."
                    )
                else:
                    notes.append(
                        "No downloadable 3D-model file link was found in either the raw "
                        "HTML or a JS-rendering reader-proxy pass of this page. It may "
                        "only be reachable through the site's own UI (e.g. a download "
                        "button behind further JS interaction, or a login wall)."
                    )
        else:
            notes.append(
                "No downloadable 3D-model file link was found in the page's raw "
                "HTML, and a follow-up JS-rendering reader-proxy attempt also "
                "failed or hit a bot/JS challenge. A real file may still exist on "
                "the page — check it manually."
            )
    file_targets = [(sanitize(os.path.basename(urllib.parse.urlparse(u).path)), u) for u in file_urls]

    slug = _derive_slug(url, name)

    meta = {
        "name": name,
        "source_url": url,
        "site": "generic",
        "slug": slug,
        "author": author,
        "published": published,
        "category": json_ld.get("category"),
        "tags": tags,
        "license": license_str,
        "summary": None,
        "description_md": description,
        "notes": notes,
        "stats": {},
        "print_settings": {},
    }
    return meta, file_targets, image_targets
