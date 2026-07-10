#!/usr/bin/env bash
# Fail if the macOS Panda.app bundle embeds a stale viewer dist.
#
# Tauri 2's `tauri::generate_context!()` bakes `frontendDist` (per
# tauri.conf.json) into the Rust binary at compile time. Rebuilding only
# `viewer/dist/` without re-running `cargo tauri build` ships an .app whose
# embedded JS predates the dist on disk — every IPC invoke silently falls
# through to the browser stub because the bundled transport.ts is the older
# version that doesn't import `@tauri-apps/api`.
#
# This script catches exactly that: bundled binary mtime must be ≥ viewer
# dist mtime. Wired into `tauri.conf.json` as an afterBundleCommand.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

TARGET="release"
TRIPLE=""
QUIET=0

usage() {
  cat <<'EOF'
Usage: scripts/build/verify-bundle-fresh.sh [--target=release|debug] [--triple=<triple>] [--quiet]

Verifies that the compiled Vibe binary under target/[<triple>/]<target>/
(the .app's Mach-O on macOS, Vibe[.exe] elsewhere)
is at least as new as viewer/dist/index.html. Exits 1 with a clear message
otherwise — usually means someone rebuilt the viewer dist without re-running
`cargo tauri build`, so the bundle ships pre-fix JS.

Pass --triple when the bundle was produced by `cargo tauri build --target <triple>`
(a cross-build), since cargo then nests output under target/<triple>/.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target=release|--target=debug) TARGET="${1#--target=}" ;;
    --triple=*) TRIPLE="${1#--triple=}" ;;
    --quiet) QUIET=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "verify-bundle-fresh: unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# A --target <triple> build nests output under target/<triple>/<profile>/.
if [ -n "${TRIPLE}" ]; then
  PROFILE_DIR="${REPO_ROOT}/desktop/src-tauri/target/${TRIPLE}/${TARGET}"
else
  PROFILE_DIR="${REPO_ROOT}/desktop/src-tauri/target/${TARGET}"
fi

# Locate the compiled binary whose mtime we compare against the dist. On macOS
# the canonical artifact is inside the .app; on Windows/Linux there is no .app,
# so fall back to the plain compiled binary (Vibe[.exe]) — the same
# Mach-O/PE that generate_context!() baked the dist into at compile time.
BUNDLE_BIN=""
for cand in \
  "${PROFILE_DIR}/bundle/macos/Vibe.app/Contents/MacOS/Vibe" \
  "${PROFILE_DIR}/Vibe.exe" \
  "${PROFILE_DIR}/Vibe"; do
  if [ -f "${cand}" ]; then BUNDLE_BIN="${cand}"; break; fi
done
DIST_INDEX="${REPO_ROOT}/viewer/dist/index.html"

if [ -z "${BUNDLE_BIN}" ]; then
  echo "verify-bundle-fresh: no compiled binary under ${PROFILE_DIR}" >&2
  echo "  Run \`cargo --manifest-path desktop/src-tauri/Cargo.toml tauri build\` first." >&2
  exit 1
fi

if [ ! -f "${DIST_INDEX}" ]; then
  echo "verify-bundle-fresh: no viewer dist at ${DIST_INDEX}" >&2
  echo "  Run \`npm --prefix viewer run build\`." >&2
  exit 1
fi

# stat -f on macOS, stat -c on Linux.
if stat -f %m / >/dev/null 2>&1; then
  bundle_mtime=$(stat -f %m "${BUNDLE_BIN}")
  dist_mtime=$(stat -f %m "${DIST_INDEX}")
else
  bundle_mtime=$(stat -c %Y "${BUNDLE_BIN}")
  dist_mtime=$(stat -c %Y "${DIST_INDEX}")
fi

if [ "${bundle_mtime}" -lt "${dist_mtime}" ]; then
  echo "verify-bundle-fresh: bundle is older than viewer/dist." >&2
  echo "  bundle: ${BUNDLE_BIN} (mtime ${bundle_mtime})" >&2
  echo "  dist:   ${DIST_INDEX} (mtime ${dist_mtime})" >&2
  echo "" >&2
  echo "  Re-run \`cargo --manifest-path desktop/src-tauri/Cargo.toml tauri build\`." >&2
  echo "  generate_context!() bakes the dist into the binary at compile time;" >&2
  echo "  rebuilding only the viewer ships pre-IPC-fix JS in the .app." >&2
  exit 1
fi

if [ "${QUIET}" -eq 0 ]; then
  echo "verify-bundle-fresh: bundle is fresh (bundle ${bundle_mtime} >= dist ${dist_mtime})"
fi
