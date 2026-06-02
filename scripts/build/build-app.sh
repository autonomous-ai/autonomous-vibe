#!/usr/bin/env bash
# Canonical Panda app build: cargo tauri build + bundle-freshness guard.
#
# Always use this in CI and when shipping. Plain `cargo tauri build` works
# but skips the guard that catches a stale `viewer/dist/` embedded into the
# bundle (see verify-bundle-fresh.sh for the failure mode).
#
# Pass-through args go to `cargo tauri build`; common ones:
#   --debug                build target/debug/bundle (faster)
#   --features <list>      forwarded to cargo
#   --target <triple>      cross-target

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

TAURI_TARGET="release"
for arg in "$@"; do
  if [ "$arg" = "--debug" ]; then
    TAURI_TARGET="debug"
  fi
done

# Vendor shared Python packages into the skill runtimes BEFORE bundling, so the
# `skills/` tree shipped via `bundle.resources` carries a populated cadpy. Without
# this the cadcode generator ships an empty pipeline and the model falls back to
# hand-written export/render scripts (clutter + non-contract artifacts).
"${REPO_ROOT}/scripts/build/build-skill-runtimes.sh"

# Guard: never bundle an empty cadpy. Mirrors verify-bundle-fresh.sh's intent.
VENDORED_GENERATION="${REPO_ROOT}/skills/cadcode/scripts/packages/cadpy/generation.py"
if [ ! -s "${VENDORED_GENERATION}" ]; then
  echo "error: vendored cadpy is empty (${VENDORED_GENERATION} missing/empty)." >&2
  echo "       build-skill-runtimes.sh did not populate it; aborting before bundle." >&2
  exit 1
fi

( cd "${REPO_ROOT}/desktop/src-tauri" && cargo tauri build "$@" )
"${REPO_ROOT}/scripts/build/verify-bundle-fresh.sh" "--target=${TAURI_TARGET}"
