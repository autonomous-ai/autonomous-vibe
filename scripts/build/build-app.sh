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

( cd "${REPO_ROOT}/desktop/src-tauri" && cargo tauri build "$@" )
"${REPO_ROOT}/scripts/build/verify-bundle-fresh.sh" "--target=${TAURI_TARGET}"
