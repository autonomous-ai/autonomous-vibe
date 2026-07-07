# Generic (non-printables) site scraping — technique and limits

Used by `scripts/site_generic.py` for any model-listing URL that isn't
printables.com (which has its own dedicated GraphQL adapter,
`site_printables.py` — see `printables-graphql-api.md`).

## Signal sources, in priority order

1. **JSON-LD** (`<script type="application/ld+json">`). Many catalog sites
   emit `schema.org` structured data for SEO — `Product`, `CreativeWork`,
   `3DModel`, or `Article` types carry `name`, `description`, `author`,
   `image`, `license`, `datePublished`, `keywords`. This is the richest
   available signal when present and needs no guessing. Present on
   Thingiverse (`schema.org/Product`, full metadata including author and CC
   license URL); absent on some other sites (MakerWorld, Cults3D — see
   below).
2. **Open Graph / Twitter Card meta tags** (`<meta property="og:...">`,
   `<meta name="twitter:...">`). Near-universal fallback for title,
   description, and a primary image even on sites with no JSON-LD.
3. **Plain `<title>` and `<meta name="description">`.** Last resort — used
   only if neither of the above has a name/description.
4. **Regex sweep for 3D-model file links** — any `href=`/`src=` ending in
   `.step`/`.stp`/`.stl`/`.3mf`/`.obj`/`.iges`/`.igs`/`.ply`/`.gltf`/`.glb`/
   `.fbx`/`.skp`, resolved to an absolute URL. This is the weakest part of
   the generic path — see "The file is usually the thing you won't get"
   below.
5. **Generic `<img src>` sweep** for images beyond whatever JSON-LD/OG
   already supplied, filtering out obvious non-content images (icons,
   logos, avatars, `.svg`).

## The file is usually the thing you won't get

Against a live Thingiverse listing, JSON-LD and Open Graph gave complete,
accurate metadata (title, full description, author, publish date, CC
license, a preview image) — but the raw HTML contained **zero** file
links, because Thingiverse's actual file list loads via a client-side API
call after the page mounts, not in the server-rendered HTML a plain GET
fetches. This is the **expected common case** for JS-heavy single-page-app
catalog sites (Thingiverse, MakerWorld, Cults3D and similar), not a bug in
the scraper.

`site_generic.py` reports this plainly via a `notes` list surfaced in
`design_readme.md`'s "Crawl notes" section — it never fabricates a file or
silently leaves the reader thinking none exists on the source site, only
that this scraper couldn't retrieve it automatically. If you need the
actual file from one of these sites, fetch it manually (open the page in a
browser, use the site's own download button) and drop it into the already-
created design folder.

## Sites that block plain HTTP fetches outright

MakerWorld and Cults3D have both been observed returning `HTTP 403
Forbidden` to a plain `urllib` GET with a browser `User-Agent` — likely bot
protection (Cloudflare or similar).

**`common.fetch_text`/`download_binary` don't give up after one try.**
Every fetch (page HTML, model files, images) retries up to 5 times with
backoff, rotating across 4 different desktop/mobile browser User-Agents
and adding a `Referer` header from the second attempt on — cheap to try,
and it does matter for sites whose blocking is simple UA-sniffing rather
than a full WAF. Only `403`/`408`/`429`/`5xx` are retried; a plain `404` is
raised immediately since that's a real "doesn't exist," not a block worth
working around.

**This is genuinely best-effort, not a guaranteed bypass**: against
Cults3D specifically, 4 different User-Agents plus a plain `curl`
invocation (different TLS/HTTP fingerprint than Python's `urllib`) have all
still gotten `403`. That's consistent with a Cloudflare-grade WAF
challenge not being beatable by varying headers/UA on a plain HTTP client,
no matter how many times you retry — it needs a real browser session (JS
challenge solving) to get past. `site_generic.py` reflects this honestly:
after exhausting retries on a `401`/`403`/`429`, the `design_readme.md`
"Crawl notes" section says plainly that this looks like bot/WAF protection
and that a real browser or a manually-saved copy of the page is what it
would actually take, rather than implying the scraper just needs to try
harder. If you hit this, the practical options are: fetch the page
manually and hand the saved HTML to a one-off variant of this scraper, or
accept that this particular source isn't automatable via a plain HTTP
client and note it in whatever larger task this crawl serves.

## Adding a dedicated adapter for a specific site

If a site turns out to have a stable, scrapable API or JSON payload (the
way printables.com does), it's worth a dedicated `site_<name>.py` rather
than permanently relying on the generic fallback — the generic path is a
safety net, not the preferred long-term path for a site you'll hit
repeatedly. To add one:

1. Confirm the API/payload is real and stable — introspect it live (see
   `printables-graphql-api.md` for the technique: check `__schema`, probe
   error messages for opaque type names) rather than trusting old
   documentation or guesses.
2. Write `site_<name>.py` with:
   - `matches(url) -> bool` — a simple domain check.
   - `fetch(url, formats, max_images) -> (meta, file_targets, image_targets)`
     matching the contract documented at the top of `common.py`.
3. Add it to `ADAPTERS` in `fetch_model_folder.py`, **before**
   `site_generic` (first match wins, generic is the fallback-of-last-resort
   and must stay last).
4. Test against at least one real URL from that site, including a case
   with no downloadable file if that's a realistic outcome there, before
   considering the adapter done.

Thingiverse is the most obvious next candidate (it has a public
`api.thingiverse.com` REST API, though most useful endpoints need an OAuth
token) — not implemented here because the token requirement hasn't been
verified against this skill's no-auth constraint; worth revisiting if this
skill starts hitting Thingiverse URLs often.
