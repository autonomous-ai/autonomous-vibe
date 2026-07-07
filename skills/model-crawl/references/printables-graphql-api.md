# printables.com GraphQL API notes

Everything `fetch_model_folder.py` relies on. printables.com is a
SvelteKit app; its real data comes from
`https://api.printables.com/graphql/`, a public GraphQL endpoint with
introspection **enabled** and no auth/cookies required for public models.

## Discovering the schema yourself

```bash
# top-level query/mutation field names
curl -s https://api.printables.com/graphql/ -X POST \
  -H "Content-Type: application/json" -A "Mozilla/5.0" \
  -d '{"query":"query{__schema{queryType{fields{name}}}}"}'

curl -s https://api.printables.com/graphql/ -X POST \
  -H "Content-Type: application/json" -A "Mozilla/5.0" \
  -d '{"query":"query{__schema{mutationType{fields{name}}}}"}'

# fields on a named type
curl -s https://api.printables.com/graphql/ -X POST \
  -H "Content-Type: application/json" -A "Mozilla/5.0" \
  -d '{"query":"query{__type(name:\"PrintType\"){fields{name}}}"}'
```

If a field's type name is opaque from introspection (wrapped in
NON_NULL/LIST), query it with a deliberately-wrong subfield
(`{ print(id:1){ someField{ xxx } } }`) — GraphQL's error message names the
real type (`Cannot query field 'xxx' on type 'RealTypeName'`).

## Search / discovery — `searchPrints2`

```graphql
query($q:String!,$offset:Int,$limit:Int,$ordering:SearchChoicesEnum){
  searchPrints2(query:$q, offset:$offset, limit:$limit, ordering:$ordering){
    totalCount
    items{ id name slug downloadCount user{publicUsername} }
  }
}
```

- `ordering`: `latest | popular | best_match | rating | makes_count`
- Empty `query: ""` returns the generic popular feed (capped around 10k
  results with `ordering: popular`); non-empty strings search title,
  description, tags.
- `downloadCount` can be `null` on some items — guard before comparing to a
  threshold.

## Single model — `print(id: ID!)`

```graphql
query($id:ID!){
  print(id:$id){
    id name slug summary description        # description is HTML, not markdown
    datePublished
    downloadCount likesCount ratingAvg ratingCount viewsCount remixCount makesCount
    tags{ name }
    category{ name path{ name } }            # path = ancestor categories, root-first
    license{ name abbreviation }
    printer{ name }
    materials{ name }
    printDuration weight layerHeights nozzleDiameters numPieces
    user{ publicUsername }
    images{ id filePath imageWidth imageHeight }
    stls{ id name }                          # see gotcha below
  }
}
```

**Gotcha — `stls` is not just STL files.** It returns *every* uploaded
3D-model file for the print: `.stl`, `.step`/`.stp`, `.obj`, `.3mf`,
whatever the author uploaded. Filter its `name` field by extension to find
STEP files specifically. `otherFiles` is a separate list for misc
attachments (PDFs, docs) and `gcodes` is pre-sliced print files — neither
is where a STEP file would show up.

**Gotcha — images.** `images[].filePath` is a relative storage key, not a
full URL. Build the real URL as `https://files.printables.com/<filePath>`.

## Getting an actual download link — `getDownloadLink` mutation

The SSR-hydration JSON blobs baked into the rendered page never include a
usable download link — it has to be requested explicitly via this
mutation:

```graphql
mutation($printId:ID!,$source:DownloadSourceEnum!,$files:[DownloadFileInput]){
  getDownloadLink(printId:$printId, source:$source, files:$files){
    ok
    errors{ field messages }
    output{ link ttl count }
  }
}
```

Variables:

```json
{
  "printId": "259465",
  "source": "model_detail",
  "files": [{"fileType": "stl", "ids": ["1184745"]}]
}
```

- `source`: `model_detail | model_viewer` (either works from a script; use
  `model_detail` to match what the model page itself does).
- `files[].fileType`: enum `stl | gcode | sla | other | pack` — **`stl`
  covers every "3D model file" upload, including actual `.step` files**,
  because it mirrors the same overloaded meaning as the `stls` query field
  above. Use the numeric file `id` from `print(id).stls`, not a filename.
- `output.link` is a signed `https://files.printables.com/media/prints/...`
  CloudFront URL. `output.ttl` gives its lifetime in seconds — download
  immediately, don't cache the link for later.
- Calling this mutation likely increments the model's own download
  counter (as the real "Download" button would) — don't call it
  speculatively for exploration; only when you're actually about to fetch
  the file.

## Worked example

```bash
# 1. Resolve a model id from its URL: /model/(\d+)
# https://www.printables.com/model/259465-iso-chc-m3-screws-3d-models-step-files -> 259465

# 2. List its files, find the STEP ones
curl -s https://api.printables.com/graphql/ -X POST \
  -H "Content-Type: application/json" -A "Mozilla/5.0" \
  -d '{"query":"query{print(id:259465){stls{id name}}}"}'
# -> {"id":"1184745","name":"CHC M3 L4.step"}, ...

# 3. Get a real download link for one of them
curl -s https://api.printables.com/graphql/ -X POST \
  -H "Content-Type: application/json" -A "Mozilla/5.0" \
  -d '{"query":"mutation($p:ID!,$s:DownloadSourceEnum!,$f:[DownloadFileInput]){getDownloadLink(printId:$p,source:$s,files:$f){ok output{link}}}","variables":{"p":"259465","s":"model_detail","f":[{"fileType":"stl","ids":["1184745"]}]}}'
# -> {"ok":true,"output":{"link":"https://files.printables.com/media/prints/259465/stls/2320586_.../chc-m3-l4.step"}}

# 4. Download it
curl -sL -o "CHC M3 L4.step" "<that link>"
```

## Rate-limiting courtesy

No hard rate limit was ever hit, but every request this skill makes to
this API sleeps ~0.15-0.2s between calls as a courtesy. Scale that up if
running a much larger crawl than a handful of models at a time.

## Why not scrape the rendered HTML / use WebFetch

- A plain fetch of a model page is mostly an empty SvelteKit shell — the
  useful data is either not present or requires parsing brittle inlined
  `<script type="application/json" data-sveltekit-fetched>` SSR blocks.
  Talking to the GraphQL endpoint directly is strictly more reliable and
  gets you fields (canonical slug, numeric file ids, a real download link)
  that never make it into the page's own hydration payload at all. This is
  the concrete fix for "Panda can't crawl printables.com" — the fetch
  wasn't unreliable because of bad luck, it was fetching the wrong thing.
- `WebFetch` reliably header-overflows on these listing pages — don't use
  it here; a plain `urllib` POST with a browser `User-Agent` against the
  API endpoint is all this skill needs, no HTML parsing at all.
