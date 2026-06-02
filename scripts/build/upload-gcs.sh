#!/usr/bin/env bash
# Build Panda locally and upload the release artifacts to GCS.
#
# Modeled on sphere/scripts/upload-system.sh: read version → build artifact →
# `gsutil cp` to gs://${GCS_BUCKET}/<path> → merge a manifest. Here the manifest
# is the Tauri auto-updater's latest.json (not a generic metadata.json), so the
# .app.tar.gz signature is embedded and the platform url points at the public
# CDN (PUBLIC_BASE_URL, default https://cdn.autonomous.ai) that fronts the
# bucket — not the raw GCS endpoint.
#
# Host-OS-aware. On macOS it builds BOTH macOS arches in one run — Apple Silicon
# (aarch64) and Intel (x86_64). Cross-building the Intel app on an Apple Silicon
# host works because: the Rust x86_64-apple-darwin target is installed,
# OrcaSlicer ships a universal .app, and python-build-standalone has a per-arch
# tarball (the x86_64 import smoke-test needs Rosetta 2). On a Windows host it
# builds the native x86_64-pc-windows-msvc target (no cross-OS toolchain). Each
# run MERGES its platform(s) into the shared latest.json, preserving entries it
# didn't build — so run on macOS for the darwin keys and on Windows for the
# windows key, and installed apps on every platform update from GCS. Restrict
# arches with --target.
#
# Uploads, under gs://${GCS_BUCKET}/${GCS_PREFIX}/:
#   releases/<ver>/<platform>/<installer>              user-facing installer (.dmg / .msi)
#   releases/<ver>/<platform>/<updater payload>        .app.tar.gz (mac) / -setup.exe (win)
#   releases/<ver>/<platform>/<payload>.sig            its minisign signature
#   latest.json                                        stable updater manifest (merged)
#
# where <platform> is the updater key (darwin-aarch64 / darwin-x86_64 /
# windows-x86_64). The per-platform subdir keeps identically-named payloads from
# different arches from colliding.
#
# To make installed apps update from GCS instead of GitHub, point
# tauri.conf.json → plugins.updater.endpoints at the printed latest.json URL.
#
# Env overrides:
#   GCS_BUCKET                bucket (default: s3-autonomous-upgrade-3)
#   GCS_PREFIX                key prefix (default: panda)
#   PUBLIC_BASE_URL           public base for latest.json URLs, fronting the
#                             bucket (default: https://cdn.autonomous.ai)
#   TAURI_SIGNING_KEY_FILE    updater private key (default: ~/.tauri/panda-updater.key)
#   APPLE_SIGNING_IDENTITY    Gatekeeper signing identity (default: "-" = ad-hoc/unsigned)
#   UPDATE_NOTES              latest.json "notes" string (default: "Panda <ver>")
#
# Flags:
#   --target <triple>  build only this arch (repeatable); default builds both
#                      aarch64-apple-darwin and x86_64-apple-darwin
#   --no-build         skip the build; upload whatever is already in the bundle dirs
#   --skip-sidecars    skip build-all-sidecars.sh (use when sidecars are already built)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

GCS_BUCKET="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
GCS_PREFIX="${GCS_PREFIX:-panda}"
TAURI_SIGNING_KEY_FILE="${TAURI_SIGNING_KEY_FILE:-${HOME}/.tauri/panda-updater.key}"

usage() { sed -n '2,41p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

DO_BUILD=1
DO_SIDECARS=1
TARGETS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build) DO_BUILD=0 ;;
    --skip-sidecars) DO_SIDECARS=0 ;;
    --target) TARGETS+=("${2:?--target needs a triple}"); shift ;;
    --target=*) TARGETS+=("${1#--target=}") ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

START_TS=$(date +%s)

# step <heading...> — timestamped section header.
step() {
  echo ""
  echo "[$(date +%H:%M:%S)] >>> $*"
}

# human_size <path> — "12M" / "345K" (portable: BSD + GNU du).
human_size() {
  du -sh "$1" 2>/dev/null | cut -f1 | tr -d '[:space:]'
}

# upload_artifact <local path> <gs path> — copy to the bucket, no-cache.
upload_artifact() {
  local src="$1" dest="$2" t0 t1
  echo "    src:     $src ($(human_size "$src"))"
  echo "    dest:    gs://${GCS_BUCKET}/${dest}"
  t0=$(date +%s)
  gsutil -h "Cache-Control:no-cache, no-store, must-revalidate" \
    cp "$src" "gs://${GCS_BUCKET}/${dest}"
  t1=$(date +%s)
  echo "    uploaded in $((t1 - t0))s"
}

# platform_key_for <triple> — Tauri updater platform key for a target triple.
platform_key_for() {
  case "$1" in
    aarch64-apple-darwin)  echo "darwin-aarch64" ;;
    x86_64-apple-darwin)   echo "darwin-x86_64" ;;
    x86_64-pc-windows-msvc) echo "windows-x86_64" ;;
    *) echo "unsupported target triple: $1" >&2; return 1 ;;
  esac
}

# ---- version + targets ------------------------------------------------------

step "Read version from tauri.conf.json"
VERSION="$(python3 -c "import json; print(json.load(open('${REPO_ROOT}/desktop/src-tauri/tauri.conf.json'))['version'])")"
echo "    version: ${VERSION}"

# Host OS + arch decide the default target set. macOS cross-builds both darwin
# arches in one run; Windows can only build its own native MSVC target (no
# cross-OS toolchain), so it defaults to just that. On a Windows host uname -m
# reports x86_64 — without the OS check that would mis-map to apple-darwin.
HOST_OS="$(uname -s)"
case "${HOST_OS}" in
  Darwin)
    case "$(uname -m)" in
      arm64|aarch64) HOST_TRIPLE="aarch64-apple-darwin" ;;
      x86_64)        HOST_TRIPLE="x86_64-apple-darwin" ;;
      *) echo "unsupported host arch: $(uname -m)" >&2; exit 1 ;;
    esac ;;
  MINGW*|MSYS*|CYGWIN*) HOST_TRIPLE="x86_64-pc-windows-msvc" ;;
  *) echo "unsupported host OS: ${HOST_OS}" >&2; exit 1 ;;
esac

# Default target set per host. macOS builds both arches (host built LAST so the
# arch-specific Python sidecar — resources/python is a single shared prefix,
# overwritten per build — is left native for subsequent dev runs); Windows
# builds only its own triple.
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  case "$HOST_TRIPLE" in
    aarch64-apple-darwin)   TARGETS=(x86_64-apple-darwin aarch64-apple-darwin) ;;
    x86_64-apple-darwin)    TARGETS=(aarch64-apple-darwin x86_64-apple-darwin) ;;
    x86_64-pc-windows-msvc) TARGETS=(x86_64-pc-windows-msvc) ;;
  esac
fi
echo "    targets: ${TARGETS[*]}"

REL_PREFIX="${GCS_PREFIX}/releases/${VERSION}"
# Public-facing base URL baked into latest.json (and printed). Uploads still go
# to gs://${GCS_BUCKET} via gsutil; this is just the host clients fetch from.
# Defaults to the CDN that fronts the bucket, so artifacts resolve at
# https://cdn.autonomous.ai/<prefix>/... rather than the raw GCS endpoint.
# Override with PUBLIC_BASE_URL (must front the same bucket). Trailing slash
# stripped so URL joins don't double up.
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://cdn.autonomous.ai}"
BASE_URL="${PUBLIC_BASE_URL%/}"

# ---- signing setup (once; shared across both builds) ------------------------

if [[ "$DO_BUILD" == 1 ]]; then
  step "Configure signing"
  [[ -f "$TAURI_SIGNING_KEY_FILE" ]] || {
    echo "signing key not found: $TAURI_SIGNING_KEY_FILE" >&2
    echo "  (set TAURI_SIGNING_KEY_FILE, or generate with \`cargo tauri signer generate\`)" >&2
    exit 1
  }
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$TAURI_SIGNING_KEY_FILE")"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

  # Apple Gatekeeper signing is macOS-only; on Windows the updater key above is
  # all that's needed (the NSIS/MSI artifacts are signed with it). `security`
  # doesn't exist off-darwin, so skip the whole block.
  if [[ "${HOST_OS}" != "Darwin" ]]; then
    echo "    apple signing: skipped (non-darwin host)"
  else
  # Apple code signing (Gatekeeper) — independent of the updater key above.
  # Default to ad-hoc ("-") so the build never fails on a missing Developer ID
  # cert. The app runs locally; other Macs show a Gatekeeper warning until it's
  # signed with a real Developer ID + notarized. To do that, export a valid
  # APPLE_SIGNING_IDENTITY (an identity in your keychain) before running, e.g.:
  #   APPLE_SIGNING_IDENTITY="Developer ID Application: Eternal AI Limited (9M75XA82CZ)"
  #
  # Self-healing: if a non-ad-hoc identity is requested but isn't actually in
  # the keychain (e.g. a stale `export APPLE_SIGNING_IDENTITY=...` from this
  # shell session pointing at a cert you don't have), fall back to ad-hoc with
  # a warning instead of letting codesign abort the whole build.
  WANT_IDENTITY="${APPLE_SIGNING_IDENTITY:--}"
  if [[ "$WANT_IDENTITY" != "-" ]] \
     && ! security find-identity -v -p codesigning | grep -qF "$WANT_IDENTITY"; then
    echo "    apple signing: '${WANT_IDENTITY}' not found in keychain — falling back to ad-hoc" >&2
    WANT_IDENTITY="-"
  fi
  export APPLE_SIGNING_IDENTITY="$WANT_IDENTITY"
  if [[ "$APPLE_SIGNING_IDENTITY" == "-" ]]; then
    echo "    apple signing: ad-hoc (not Developer ID; not notarized)"
    # Notarization is impossible for an ad-hoc build (Apple requires a real
    # Developer ID cert + secure timestamp). Tauri attempts it whenever the
    # notarization creds are present, so strip them here to skip that step —
    # otherwise the build fails with "Archive contains critical validation
    # errors / binary is not signed with a valid Developer ID certificate".
    unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID \
          APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
  else
    echo "    apple signing: ${APPLE_SIGNING_IDENTITY}"
  fi
  fi  # end darwin-only apple signing
else
  step "Skipping build (--no-build)"
fi

# ---- per-target: build + upload artifacts -----------------------------------
#
# Each target's bundle lands under target/<triple>/release/bundle (cargo nests
# output by triple whenever --target is passed). The .app.tar.gz is named
# identically for both arches, so uploads go under a per-platform subdir.

declare -a MERGE_ENTRIES=()   # "platform_key|sig_path|tarball_url" for latest.json
declare -a SUMMARY=()

for TRIPLE in "${TARGETS[@]}"; do
  PLATFORM_KEY="$(platform_key_for "$TRIPLE")"
  step "========== ${TRIPLE}  (${PLATFORM_KEY}) =========="

  if [[ "$DO_BUILD" == 1 ]]; then
    if [[ "$DO_SIDECARS" == 1 ]]; then
      step "Build sidecars for ${TRIPLE} (python + slicer; idempotent)"
      "${REPO_ROOT}/scripts/build/build-all-sidecars.sh" --target "$TRIPLE"
    fi
    step "Build signed app bundle (${TRIPLE})"
    "${REPO_ROOT}/scripts/build/build-app.sh" --target "$TRIPLE"
  fi

  BUNDLE_DIR="${REPO_ROOT}/desktop/src-tauri/target/${TRIPLE}/release/bundle"

  # The updater payload + signature differ per OS:
  #   darwin  → macos/<app>.app.tar.gz  (+ .sig)   ; user installer: dmg/*.dmg
  #   windows → nsis/<app>_*-setup.exe  (+ .sig)   ; user installer: msi/*.msi
  # On Windows the NSIS setup .exe is BOTH the updater payload and a user-facing
  # installer, so it's not duplicated under INSTALLERS.
  INSTALLERS=()
  case "$TRIPLE" in
    *-apple-darwin)
      PAYLOAD="$(ls "${BUNDLE_DIR}/macos/"*.app.tar.gz 2>/dev/null | head -n1 || true)"
      SIG="$(ls "${BUNDLE_DIR}/macos/"*.app.tar.gz.sig 2>/dev/null | head -n1 || true)"
      PAYLOAD_DESC="updater tarball"
      DMG="$(ls "${BUNDLE_DIR}/dmg/"*.dmg 2>/dev/null | head -n1 || true)"
      [[ -f "$DMG" ]] && INSTALLERS+=("dmg|$DMG")
      ;;
    *-pc-windows-*)
      PAYLOAD="$(ls "${BUNDLE_DIR}/nsis/"*-setup.exe 2>/dev/null | head -n1 || true)"
      SIG="$(ls "${BUNDLE_DIR}/nsis/"*-setup.exe.sig 2>/dev/null | head -n1 || true)"
      PAYLOAD_DESC="NSIS setup .exe"
      MSI="$(ls "${BUNDLE_DIR}/msi/"*.msi 2>/dev/null | head -n1 || true)"
      [[ -f "$MSI" ]] && INSTALLERS+=("msi|$MSI")
      ;;
    *) echo "no artifact mapping for ${TRIPLE}" >&2; exit 1 ;;
  esac

  [[ -f "$PAYLOAD" ]] || { echo "updater payload (${PAYLOAD_DESC}) missing under ${BUNDLE_DIR} — was createUpdaterArtifacts on and the build signed?" >&2; exit 1; }
  [[ -f "$SIG" ]]     || { echo "signature missing: ${PAYLOAD}.sig — the build wasn't signed (TAURI_SIGNING_PRIVATE_KEY)?" >&2; exit 1; }

  DEST_PREFIX="${REL_PREFIX}/${PLATFORM_KEY}"
  PAYLOAD_DEST="${DEST_PREFIX}/$(basename "$PAYLOAD")"
  PAYLOAD_URL="${BASE_URL}/${PAYLOAD_DEST}"

  step "Upload updater payload — ${PAYLOAD_DESC} (${PLATFORM_KEY})"
  upload_artifact "$PAYLOAD" "$PAYLOAD_DEST"

  step "Upload signature (${PLATFORM_KEY})"
  upload_artifact "$SIG" "${DEST_PREFIX}/$(basename "$SIG")"

  for inst in "${INSTALLERS[@]+"${INSTALLERS[@]}"}"; do
    kind="${inst%%|*}"; path="${inst#*|}"
    step "Upload .${kind} installer (${PLATFORM_KEY})"
    upload_artifact "$path" "${DEST_PREFIX}/$(basename "$path")"
    SUMMARY+=("  ${kind} (${PLATFORM_KEY}): ${BASE_URL}/${DEST_PREFIX}/$(basename "$path")")
  done

  MERGE_ENTRIES+=("${PLATFORM_KEY}|${SIG}|${PAYLOAD_URL}")
  SUMMARY+=("  updater (${PLATFORM_KEY}): ${PAYLOAD_URL}")
done

# ---- merge + upload latest.json ---------------------------------------------
#
# Tauri updater manifest schema:
#   { version, notes, pub_date, platforms: { <key>: { signature, url } } }
# Fetch the existing manifest, update every built platform's entry, write it
# back so any platforms NOT built this run (e.g. windows) are preserved.
#
# Implementation note (carried from the reference's merge_metadata): pass paths
# to python via argv and supply the script via a heredoc. Do NOT pipe JSON into
# `python3 - <<HEREDOC` — the heredoc claims stdin so the pipe is dropped and
# sys.stdin.read() returns "", silently clobbering the manifest.

step "Merge latest.json (${VERSION}) for: ${TARGETS[*]}"
LATEST_DEST="${GCS_PREFIX}/latest.json"
LATEST_URL="${BASE_URL}/${LATEST_DEST}"
NOTES="${UPDATE_NOTES:-Panda ${VERSION}}"
PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

src=$(mktemp); dst=$(mktemp)
echo "    manifest: gs://${GCS_BUCKET}/${LATEST_DEST}"
if ! gsutil cp "gs://${GCS_BUCKET}/${LATEST_DEST}" "$src" 2>/dev/null; then
  echo "    (no existing latest.json — will create new)"
  printf '{}' >"$src"
fi

python3 - "$src" "$dst" "$VERSION" "$NOTES" "$PUB_DATE" "${MERGE_ENTRIES[@]}" <<'PY'
import json, sys
src, dst, version, notes, pub_date = sys.argv[1:6]
entries = sys.argv[6:]  # each: "platform_key|sig_path|url"
try:
    with open(src) as f:
        raw = f.read()
    data = json.loads(raw) if raw.strip() else {}
except (OSError, json.JSONDecodeError):
    data = {}
if not isinstance(data, dict):
    data = {}
data["version"] = version
data["notes"] = notes
data["pub_date"] = pub_date
platforms = data.get("platforms")
if not isinstance(platforms, dict):
    platforms = {}
for entry in entries:
    platform_key, sig_path, url = entry.split("|", 2)
    with open(sig_path) as f:
        signature = f.read().strip()
    platforms[platform_key] = {"signature": signature, "url": url}
data["platforms"] = platforms
with open(dst, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY

echo "    notes:    ${NOTES}"
for entry in "${MERGE_ENTRIES[@]}"; do
  echo "    ${entry%%|*}: ${entry##*|}"
done
gsutil \
  -h "Content-Type:application/json" \
  -h "Cache-Control:no-cache, no-store, must-revalidate" \
  cp "$dst" "gs://${GCS_BUCKET}/${LATEST_DEST}"
rm -f "$src" "$dst"
echo "    latest.json updated ✓"

# ---- summary ----------------------------------------------------------------

echo ""
echo "========== Done in $(( $(date +%s) - START_TS ))s =========="
echo "  version:      ${VERSION}"
for line in "${SUMMARY[@]}"; do
  echo "$line"
done
echo "  latest.json:  ${LATEST_URL}"
echo ""
echo "  Updater endpoint to use:"
echo "    ${LATEST_URL}"
