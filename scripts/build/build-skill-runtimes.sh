#!/usr/bin/env bash
# Vendor shared Python packages into skill runtimes.
#
# Panda's repo rule: each skill must be self-contained at runtime — it never
# imports from outside its own directory. Shared helpers live under
# `packages/` and get copied into per-skill vendor directories by this
# script. The vendored directories are gitignored / regenerated on build.
#
# Currently vendors:
#   packages/cadpy/src/cadpy/  →  skills/cadcode/scripts/packages/cadpy/
#
# Run automatically by scripts/dev.sh (before `cargo run`) and
# scripts/build/build-app.sh (before bundling), so the cadcode generator always
# ships a populated cadpy. The vendored tree is gitignored; only README.md and
# .gitignore are tracked.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CADPY_SRC="${REPO_ROOT}/packages/cadpy/src/cadpy"
CADCODE_VENDOR="${REPO_ROOT}/skills/cadcode/scripts/packages/cadpy"

if [ ! -d "${CADPY_SRC}" ]; then
  echo "error: cadpy source not found at ${CADPY_SRC}" >&2
  exit 1
fi

mkdir -p "${CADCODE_VENDOR}"
# rsync excludes Python caches and keeps the tracked files we ship (the README
# documentation and the .gitignore that keeps the rest of the vendored tree out
# of git). `P` protects them from `--delete`, which would otherwise remove any
# dest file absent from the source tree.
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude='__pycache__' \
    --exclude='*.pyc' \
    --filter='P README.md' \
    --filter='P .gitignore' \
    "${CADPY_SRC}/" "${CADCODE_VENDOR}/"
else
  # Portable fallback for environments without rsync (e.g. Windows Git Bash).
  # Mirror the rsync behaviour: wipe the vendored tree except the tracked
  # README.md / .gitignore, then copy the source minus Python caches.
  find "${CADCODE_VENDOR}" -mindepth 1 \
    ! -name README.md ! -name .gitignore \
    -prune -exec rm -rf {} +
  ( cd "${CADPY_SRC}" && \
    find . -name '__pycache__' -prune -o -name '*.pyc' -prune -o -type f -print0 \
    | while IFS= read -r -d '' f; do
        mkdir -p "${CADCODE_VENDOR}/$(dirname "$f")"
        cp "$f" "${CADCODE_VENDOR}/$f"
      done )
fi

echo "vendored cadpy → skills/cadcode/scripts/packages/cadpy"
