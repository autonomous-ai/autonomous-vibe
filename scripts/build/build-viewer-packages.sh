#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

MODE="write"

CADJS_SRC="$REPO_ROOT/packages/cadjs"
CADJS_DST="$REPO_ROOT/viewer/packages/cadjs"

usage() {
  cat <<'EOF'
Usage:
  scripts/build/build-viewer-packages.sh [--check]

Sync packages/cadjs/ into viewer/packages/cadjs/ so the viewer build can
import cadjs as a local file dependency.

Options:
  --check     Fail if viewer/packages/cadjs is stale.
  -h, --help  Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) MODE="check" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ ! -f "$CADJS_SRC/package.json" ] || [ ! -d "$CADJS_SRC/src" ]; then
  echo "Missing cadjs source: $CADJS_SRC" >&2
  exit 1
fi

if ! command -v rsync >/dev/null 2>&1; then
  echo "rsync is required." >&2
  exit 1
fi

EXCLUDES=(
  --exclude node_modules
  --exclude dist
  --exclude coverage
  --exclude tmp
  --exclude .vite
  --exclude .DS_Store
)

case "$MODE" in
  write)
    mkdir -p "$CADJS_DST"
    rsync -a --delete --delete-excluded "${EXCLUDES[@]}" "$CADJS_SRC/" "$CADJS_DST/"
    echo "Synced packages/cadjs/ → viewer/packages/cadjs/"
    ;;
  check)
    if [ ! -d "$CADJS_DST" ]; then
      echo "Missing generated viewer cadjs package." >&2
      echo "Run scripts/build/build-viewer-packages.sh and commit the result." >&2
      exit 1
    fi
    DIFF_TMP="$(mktemp)"
    trap 'rm -f "$DIFF_TMP"' EXIT
    if ! diff -qr \
      -x node_modules -x dist -x coverage -x tmp -x .vite -x .DS_Store \
      "$CADJS_SRC" "$CADJS_DST" >"$DIFF_TMP"; then
      cat "$DIFF_TMP" >&2
      echo "" >&2
      echo "viewer/packages/cadjs is stale." >&2
      echo "Run scripts/build/build-viewer-packages.sh and commit." >&2
      exit 1
    fi
    echo "viewer/packages/cadjs is up to date."
    ;;
esac
