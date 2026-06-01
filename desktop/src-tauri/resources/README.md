# Bundled sidecar binaries

Panda's Tauri shell ships two `externalBin` sidecars: a portable CPython
runtime and the OrcaSlicer CLI. Both are populated by build scripts in
`scripts/build/` — the actual binaries are **gitignored** so the repo stays
small. The zero-byte placeholders + `.installed` markers in this tree are
committed so a fresh checkout still resolves the paths Tauri expects.

## How to populate the sidecars

Before running `cargo tauri build` (or `cargo tauri dev` if you need the
sidecars at dev time), run from the repo root:

```sh
./scripts/build/build-all-sidecars.sh
```

This:

1. Downloads python-build-standalone (pinned in
   `scripts/build/PYTHON_VERSION.txt`), extracts it under
   `python/`, and `uv pip install`s the cadpy dep set into the embedded
   Python.
2. Downloads OrcaSlicer (pinned in `scripts/build/SLICER_VERSION.txt`),
   extracts the CLI binary, and places it under `slicer/`.
3. Writes a `.installed` marker in each directory recording the version +
   SHA so subsequent runs short-circuit.

Pass `--force` to rebuild even if the markers match.

## Layout

```
resources/
├── python/
│   ├── bin/
│   │   ├── python3                            ← real interpreter (gitignored)
│   │   └── python3-<triple>                   ← symlink, named for Tauri
│   ├── lib/, share/, include/                 ← Python prefix (gitignored)
│   └── .installed                             ← marker (committed)
└── slicer/
    ├── OrcaSlicer.app/                        ← macOS bundle (gitignored)
    ├── orcaslicer-<triple>                    ← symlink/exec, Tauri sidecar
    └── .installed                             ← marker (committed)
```

`<triple>` is the Rust target triple — `aarch64-apple-darwin`,
`x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, or
`x86_64-pc-windows-msvc`. Tauri's `externalBin` entries in
`../tauri.conf.json` reference the un-suffixed path; Tauri appends the
suffix at bundle time.

## Platform support (v1)

| Triple                       | Python | OrcaSlicer | Tested |
| :--------------------------- | :----: | :--------: | :----: |
| `aarch64-apple-darwin`       | yes    | yes        | yes    |
| `x86_64-apple-darwin`        | yes    | yes        | no     |
| `x86_64-unknown-linux-gnu`   | yes    | yes        | no     |
| `x86_64-pc-windows-msvc`     | yes    | yes        | no     |

Non-macOS targets are implemented in the scripts but have not been smoke-
tested. Verifying them is v1.1 work. The Windows branch may also need a
`.exe` suffix tweak in `tauri.conf.json` (Tauri appends `.exe` for
Windows triples automatically).

## Why the placeholder files are committed

Tauri's bundler resolves `externalBin` paths at *configuration* time, before
any build script runs. Without the zero-byte placeholders + `.installed`
markers, a fresh `cargo tauri build` would fail with "external binary not
found" even if the developer just hadn't run the sidecar script yet. The
placeholders keep cargo happy; the build script overwrites them with real
content (and `.gitignore` exempts the markers so they survive).

## Bundle size

The populated sidecars are ~750 MB – 1 GB per platform. That's gitignored
because committing it would balloon the repo, but it's expected in the
final installed app — comparable to OrcaSlicer alone or Fusion 360.
