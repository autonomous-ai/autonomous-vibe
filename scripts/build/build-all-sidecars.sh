#!/usr/bin/env bash
# Build every Tauri sidecar Panda ships. Idempotent: each sub-script
# short-circuits via its own .installed marker. Pass --force to rebuild both.
#
# Run this once before `cargo tauri build`. The sub-scripts download from
# upstream releases (~1 GB total on first run); subsequent runs are no-ops.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) ARGS+=("--force") ;;
    --target) ARGS+=("--target" "${2:?--target needs a triple}"); shift ;;
    --target=*) ARGS+=("${1}") ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

echo "=== build-all-sidecars: python ==="
"${SCRIPT_DIR}/build-python-sidecar.sh" "${ARGS[@]+"${ARGS[@]}"}"

echo
echo "=== build-all-sidecars: slicer ==="
"${SCRIPT_DIR}/build-slicer-sidecar.sh" "${ARGS[@]+"${ARGS[@]}"}"

echo
echo "=== done ==="
