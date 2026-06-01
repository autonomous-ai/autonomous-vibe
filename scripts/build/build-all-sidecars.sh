#!/usr/bin/env bash
# Build every Tauri sidecar Panda ships. Idempotent: each sub-script
# short-circuits via its own .installed marker. Pass --force to rebuild both.
#
# Run this once before `cargo tauri build`. The sub-scripts download from
# upstream releases (~1 GB total on first run); subsequent runs are no-ops.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ARGS=()
for arg in "$@"; do
  case "$arg" in
    --force) ARGS+=("--force") ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

echo "=== build-all-sidecars: python ==="
"${SCRIPT_DIR}/build-python-sidecar.sh" "${ARGS[@]+"${ARGS[@]}"}"

echo
echo "=== build-all-sidecars: slicer ==="
"${SCRIPT_DIR}/build-slicer-sidecar.sh" "${ARGS[@]+"${ARGS[@]}"}"

echo
echo "=== done ==="
