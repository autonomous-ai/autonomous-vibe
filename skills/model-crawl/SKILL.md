---
name: model-crawl
description: Given a URL to a 3D-printable model listing on ANY website (printables.com, Thingiverse, MakerWorld, Cults3D, or any other model-catalog page), fetch the listing's metadata and download its real 3D-model file(s) (STEP preferred, falling back to whatever formats the source actually publishes) plus gallery images into a self-contained design folder in the workspace. printables.com URLs get a dedicated fast path that talks directly to its public GraphQL API (no HTML scraping, no WebFetch, no auth needed — those are unreliable/blocked on that site), including a real per-file download link; every other site falls back to a persistent best-effort scrape that retries with rotated User-Agents, then tries a JS-rendering reader proxy before giving up, reporting plainly what was tried and what couldn't be found. Use whenever the user hands you a model-listing link and wants it archived locally — e.g. as reference material before asking cadcode to reproduce or remix it, or to inspect in cad-viewer.
---

# Any model-listing URL → design folder

## Purpose

Turn **one** model-listing URL — from printables.com or any other site —
into a self-contained folder of real downloaded files (not scraped
placeholders) plus a readme, without manual browsing, clicking "Download",
or copy-pasting the description text. The result is reference material a
user can hand to `cadcode` ("make something like this, but wider") or open
directly in `cad-viewer`.

**Why this skill exists**: a plain `WebFetch` / raw-HTML approach against
printables.com is unreliable — the page is an empty SvelteKit shell whose
real data loads client-side, and header-heavy fetches get dropped. Talking
directly to printables' own public GraphQL API is strictly more reliable
and is the only path this skill uses for that site.

## Mechanism — site-dispatched adapters

`scripts/fetch_model_folder.py` picks an adapter by URL, in order:

1. **`site_printables.py`** — printables.com URLs. Talks directly to
   printables' own public GraphQL API (`https://api.printables.com/graphql/`,
   discovered via introspection), never HTML/`WebFetch`. Gets rich
   structured metadata AND a real per-file download link via the
   `getDownloadLink` mutation. Read `references/printables-graphql-api.md`
   for the full schema notes (the misleadingly-named `stls` field, the
   mutation shape, enums, gotchas).
2. **`site_generic.py`** — every other URL. Genuinely persistent, not a
   single-shot best-effort: (a) fetch the raw HTML, retrying transient/
   bot-wall-looking failures (403/429/5xx) up to 5x with backoff across 4
   rotated browser User-Agents; (b) parse JSON-LD (`schema.org`
   Product/CreativeWork/3DModel) and Open Graph/Twitter Card meta tags for
   metadata, sweep the HTML for `<img>` tags and file links matching known
   3D-model extensions; (c) if that whole direct-HTML approach found no
   model file (or failed to fetch at all), try a **second, genuinely
   different mechanism** — a JS-rendering reader proxy (`r.jina.ai`) that
   executes the page's JavaScript server-side, which can both bypass some
   bot-walls a plain HTTP client can't and surface files/filenames that
   only exist in JS-rendered content, never the initial HTML. Read
   `references/generic-site-scraping.md` for what each stage reliably
   finds and how final failure still degrades to a design folder with an
   honest diagnosis instead of crashing or a terse "couldn't fetch."

Both adapters resolve to the same shape — `(meta dict, file_targets,
image_targets)`, documented at the top of `scripts/common.py` — so
`fetch_model_folder.py` downloads, writes the readme, and appends the
manifest identically regardless of which adapter ran. **Adding a dedicated
adapter for a new site** (once you've confirmed it has something as stable
as printables' GraphQL API — don't assume, verify) is a matter of writing
`site_<name>.py` with a `matches()`/`fetch()` pair and registering it in
`ADAPTERS`, before `site_generic` (which must stay last as the fallback).
See the end of `generic-site-scraping.md` for the checklist.

## Usage

```bash
uv run --python 3.12 --with html2text python \
  ~/.claude/skills/model-crawl/scripts/fetch_model_folder.py \
  <model-url> [--out-dir DIR] [--formats step,stp] [--max-images N] [--manifest CSV_PATH]
```

- `<model-url>` — any model-listing page URL. printables.com URLs
  (containing `/model/<numeric-id>`) get the dedicated GraphQL adapter;
  everything else gets the generic scraper.
- `--out-dir DIR` (default: current directory) — the `<slug>/` folder is
  created directly under this. Point it at wherever in the current
  project workspace the archive should live (e.g. a `references/`
  subfolder) — Panda has no fixed convention for this, unlike a dedicated
  crawl-dataset repo.
- `--formats` (default: unset) — comma-separated extensions to force, e.g.
  `step,stp`. **Default behavior without this flag**: prefer STEP if
  found, otherwise fall back to whatever the source actually publishes /
  exposes (STL/3MF/OBJ/whatever), so the folder is never empty just
  because a source has no STEP. `design_readme.md` always states plainly
  whether a STEP file was actually retrieved.
- `--max-images N` (default: 5) — cap on gallery images fetched into
  `showcase_images/`.
- `--manifest CSV_PATH` (optional) — append a row to a CSV tracking every
  model crawled so far (`model_id,name,slug,author,downloadCount,url,files,
  num_step_files`), creating it with a header if it doesn't exist yet, and
  skipping if that model's slug is already present. `model_id`/
  `downloadCount` are blank for non-printables rows — that data doesn't
  exist outside printables.com.

The dependency install (`html2text`, for HTML→Markdown description
conversion, used by the printables adapter) happens ad hoc via `uv run
--with` — nothing needs to be installed system-wide or added to Panda's
bundled Python sidecar, since this skill never touches the cadpy pipeline.

For multiple URLs, just invoke the script once per URL (it's a single
network-bound pass per model, a few seconds each) — there's no batch mode
built in on purpose.

## Output

```
<out-dir>/<slug>/
  <original filename(s) of every downloaded 3D-model file, if any>
  design_readme.md
  showcase_images/          # only created if at least one image was found
    00.<ext>
    01.<ext>
    ...
```

`design_readme.md` always contains at minimum: title, source URL, and a
**Files downloaded** section (with an explicit warning if no STEP file was
retrieved). Everything else is included when the source actually has it:
author, published date, category, tags, license, a stats block
(downloads/likes/rating/views/remixes/makes — printables only), declared
print settings (printables only), a summary, the full description, and — on
the generic path especially — a **Crawl notes** section stating plainly
what was tried and what wasn't found, e.g. "the raw HTML had no file link
but a reader-proxy pass found one," "no file URL was found but the
rendered page text mentions a real filename `foo.stl` — download it
manually," or "both a direct fetch and a reader-proxy pass hit the same
bot/WAF challenge."

## CAD Viewer handoff

After a crawl downloads a `.step`/`.stp`/`.stl` file, hand the explicit
file path to `$cad-viewer` so the user can look at it without leaving the
chat. If `$cad-viewer` is unavailable or startup fails, report that
instead of silently omitting the handoff. If the goal is a parametric,
editable rebuild rather than just a reference render, hand the downloaded
file's path and the readme's description to a `cadcode` conversation as
the design brief/reference — cadcode does not import STEP files directly,
so treat the download as **inspiration and dimension source**, not
something to wrap and re-export unmodified.

## Non-negotiables

- **printables.com always uses the GraphQL adapter — never `WebFetch` or
  raw HTML scraping for that site.** Confirmed unreliable/broken there;
  don't rediscover this per session.
- **Prefer STEP, but never leave the folder empty just because no STEP
  exists (or no file could be found at all).** A mesh-only listing, or even
  metadata-only when no file was retrievable, is still worth archiving —
  say so plainly in the readme rather than silently downloading nothing or
  failing outright.
- **Never fabricate a field or file.** If the generic adapter can't find a
  description, license, or file link, the readme says so via "Crawl
  notes" — it does not guess or leave a false impression that nothing
  exists on the source site.
- **Don't give up after one failed approach.** A single fetch failure or an
  empty file sweep is not the final answer — try the second mechanism (the
  reader-proxy pass) before writing off a URL. This is a real, verified
  second path (it bypasses some live blocks and finds real filenames raw
  HTML can't), not theater; use it. Only report failure/"no file found"
  after both have genuinely been tried.
- **But don't overclaim what retrying achieves, either.** A Cloudflare-
  grade interactive challenge beats both the direct fetch and the
  reader-proxy on some sites. When both fail, say plainly that this looks
  like the actual ceiling for automated fetching (and what a human would
  need to do instead — open it in a browser, save the page manually), not
  that "more retries" would eventually work.
- **A fetch failure (403, timeout, DNS) must still produce a design
  folder** with a readme explaining what was tried and why it didn't work,
  not a crash — this keeps a multi-URL batch (run one invocation per URL)
  from dying on one bad site.
- **If a real filename is visible but not a downloadable URL** (a
  client-side-triggered download with no static `href`), say the filename
  by name in the notes rather than reporting "nothing found" — it's a much
  more useful handoff to whoever does the manual download.
- **On printables.com specifically**: use the canonical `slug` and file
  `id`s returned by the API, not values parsed out of the input URL; don't
  call `getDownloadLink` speculatively (it likely increments the real
  download counter — only call it for a file you're actually about to
  save); its returned links are TTL-limited, so download immediately
  rather than stashing links for later.
- **Don't invent a dedicated site adapter speculatively.** The generic
  fallback is the default for "some other site" — only promote a site to
  its own `site_<name>.py` after confirming (by introspection or testing,
  not assumption) that it has something stable to build on.
