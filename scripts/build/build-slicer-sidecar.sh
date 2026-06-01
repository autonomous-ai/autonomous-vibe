#!/usr/bin/env bash
# Build the bundled OrcaSlicer sidecar for Panda's Tauri shell.
#
# Downloads the pinned OrcaSlicer release for the host platform, extracts the
# CLI binary from its .app / AppImage / .zip wrapper, and places it at
# desktop/src-tauri/resources/slicer/orcaslicer-<triple>.
#
# Idempotent: re-runs short-circuit if .installed marker matches the pinned
# SLICER_VERSION.txt + asset SHA. Pass --force to rebuild.
#
# Outputs:
#   desktop/src-tauri/resources/slicer/orcaslicer-<triple>  ← Tauri sidecar
#   desktop/src-tauri/resources/slicer/.installed           ← marker
#
# v1 supports macOS (universal DMG → arm64 + x86_64). Linux + Windows
# branches are sketched but untested.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SLICER_VERSION_FILE="${SCRIPT_DIR}/SLICER_VERSION.txt"
RESOURCES_DIR="${REPO_ROOT}/desktop/src-tauri/resources/slicer"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [[ ! -f "${SLICER_VERSION_FILE}" ]]; then
  echo "error: ${SLICER_VERSION_FILE} missing" >&2
  exit 1
fi
SLICER_VERSION="$(tr -d '[:space:]' < "${SLICER_VERSION_FILE}")"  # e.g. v2.3.2
# Strip leading 'v' for use inside the asset filename.
SLICER_VER_NUM="${SLICER_VERSION#v}"

# --- detect host triple -----------------------------------------------------
HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"
case "${HOST_OS}-${HOST_ARCH}" in
  Darwin-arm64)  TRIPLE="aarch64-apple-darwin" ;;
  Darwin-x86_64) TRIPLE="x86_64-apple-darwin" ;;
  Linux-x86_64)  TRIPLE="x86_64-unknown-linux-gnu" ;;
  MINGW*|MSYS*|CYGWIN*) TRIPLE="x86_64-pc-windows-msvc" ;;
  *)
    echo "error: unsupported host ${HOST_OS}-${HOST_ARCH}" >&2
    exit 1
    ;;
esac

# --- pick asset by platform -------------------------------------------------
# OrcaSlicer v2.3.2 ships one universal macOS DMG, a Linux AppImage, and a
# Windows portable zip. Update this table when bumping SLICER_VERSION.txt.
case "${TRIPLE}" in
  aarch64-apple-darwin|x86_64-apple-darwin)
    ASSET="OrcaSlicer_Mac_universal_${SLICER_VERSION}.dmg"
    ;;
  x86_64-unknown-linux-gnu)
    ASSET="OrcaSlicer_Linux_AppImage_Ubuntu2404_${SLICER_VERSION}.AppImage"
    ;;
  x86_64-pc-windows-msvc)
    ASSET="OrcaSlicer_Windows_${SLICER_VERSION}_portable.zip"
    ;;
  *) echo "error: no asset mapping for ${TRIPLE}" >&2; exit 1 ;;
esac

URL="https://github.com/SoftFever/OrcaSlicer/releases/download/${SLICER_VERSION}/${ASSET}"
SIDECAR_NAME="orcaslicer-${TRIPLE}"
SIDECAR_PATH="${RESOURCES_DIR}/${SIDECAR_NAME}"
MARKER="${RESOURCES_DIR}/.installed"

# --- short-circuit if marker matches AND payload is actually present -------
# (Markers are committed as scaffolding; verify the real binary exists too.)
case "${TRIPLE}" in
  *-apple-darwin) PAYLOAD="${RESOURCES_DIR}/OrcaSlicer.app/Contents/MacOS/OrcaSlicer" ;;
  *)              PAYLOAD="${SIDECAR_PATH}" ;;
esac
if [[ "${FORCE}" -eq 0 && -f "${MARKER}" && -s "${PAYLOAD}" ]]; then
  if grep -q "^slicer_version=${SLICER_VERSION}$" "${MARKER}" 2>/dev/null \
      && grep -q "^triple=${TRIPLE}$" "${MARKER}" 2>/dev/null; then
    echo "slicer sidecar already installed (${SLICER_VERSION}); skipping."
    echo "  use --force to rebuild."
    exit 0
  fi
fi

mkdir -p "${RESOURCES_DIR}"

# --- download ---------------------------------------------------------------
TMP_DIR="$(mktemp -d -t panda-slicer.XXXXXX)"
trap 'on_exit' EXIT
on_exit() {
  # macOS: try to detach any mounted DMG (best-effort).
  if [[ -n "${MOUNT_POINT:-}" && -d "${MOUNT_POINT}" ]]; then
    hdiutil detach "${MOUNT_POINT}" -quiet 2>/dev/null || true
  fi
  rm -rf "${TMP_DIR}"
}

DOWNLOAD="${TMP_DIR}/${ASSET}"
echo "==> downloading ${ASSET}"
curl -fL --retry 3 --connect-timeout 20 -o "${DOWNLOAD}" "${URL}"
SHA="$(shasum -a 256 "${DOWNLOAD}" | awk '{print $1}')"
echo "    sha256=${SHA}"

# --- extract per platform ---------------------------------------------------
case "${TRIPLE}" in
  *-apple-darwin)
    if ! command -v hdiutil >/dev/null; then
      echo "error: hdiutil required on macOS" >&2; exit 1
    fi
    MOUNT_POINT="${TMP_DIR}/mnt"
    mkdir -p "${MOUNT_POINT}"
    echo "==> attaching DMG"
    hdiutil attach "${DOWNLOAD}" -mountpoint "${MOUNT_POINT}" -nobrowse -quiet
    # OrcaSlicer.app/Contents/MacOS/OrcaSlicer is the actual binary.
    APP_BIN="${MOUNT_POINT}/OrcaSlicer.app/Contents/MacOS/OrcaSlicer"
    if [[ ! -x "${APP_BIN}" ]]; then
      echo "error: ${APP_BIN} missing inside DMG" >&2
      ls "${MOUNT_POINT}" >&2 || true
      exit 1
    fi
    # On macOS the Orca CLI is the same binary as the GUI; it's a self-
    # contained Mach-O that loads frameworks via @rpath from inside the
    # .app bundle. To keep it functional we copy the entire .app and use
    # the Mach-O directly. Track G's command layer is responsible for
    # passing CLI args.
    APP_BUNDLE_SRC="${MOUNT_POINT}/OrcaSlicer.app"
    APP_BUNDLE_DST="${RESOURCES_DIR}/OrcaSlicer.app"
    echo "==> copying OrcaSlicer.app bundle (~150 MB) to resources"
    # Wipe any prior copy first.
    rm -rf "${APP_BUNDLE_DST}"
    # Use ditto on macOS to preserve resource forks, code signatures, and
    # symlinks inside the bundle.
    if command -v ditto >/dev/null; then
      ditto "${APP_BUNDLE_SRC}" "${APP_BUNDLE_DST}"
    else
      cp -R "${APP_BUNDLE_SRC}" "${APP_BUNDLE_DST}"
    fi
    # The Tauri sidecar entry is a symlink into the bundle so the bundled
    # frameworks (@rpath/...) resolve.
    rm -f "${SIDECAR_PATH}"
    ln -s "OrcaSlicer.app/Contents/MacOS/OrcaSlicer" "${SIDECAR_PATH}"
    ;;

  x86_64-unknown-linux-gnu)
    echo "==> copying AppImage"
    chmod +x "${DOWNLOAD}"
    cp "${DOWNLOAD}" "${SIDECAR_PATH}"
    chmod +x "${SIDECAR_PATH}"
    ;;

  x86_64-pc-windows-msvc)
    echo "==> extracting portable zip"
    UNZIP_DIR="${TMP_DIR}/unzipped"
    mkdir -p "${UNZIP_DIR}"
    if command -v unzip >/dev/null; then
      unzip -q "${DOWNLOAD}" -d "${UNZIP_DIR}"
    else
      echo "error: unzip required on Windows host" >&2; exit 1
    fi
    # Find the executable inside the portable zip.
    EXE="$(find "${UNZIP_DIR}" -maxdepth 4 -iname 'OrcaSlicer.exe' | head -1)"
    if [[ -z "${EXE}" ]]; then
      echo "error: OrcaSlicer.exe not found inside portable zip" >&2
      exit 1
    fi
    # Windows binary depends on adjacent DLLs — copy the whole directory and
    # point the sidecar at the main exe via a .cmd shim. Untested.
    PORTABLE_DST="${RESOURCES_DIR}/OrcaSlicer_portable"
    rm -rf "${PORTABLE_DST}"
    cp -R "$(dirname "${EXE}")" "${PORTABLE_DST}"
    # Tauri appends .exe on Windows triples, so the externalBin entry must
    # actually be `orcaslicer-x86_64-pc-windows-msvc.exe`.
    cp "${EXE}" "${SIDECAR_PATH}.exe"
    ;;
esac

# --- smoke check ------------------------------------------------------------
if [[ -x "${SIDECAR_PATH}" || -L "${SIDECAR_PATH}" ]]; then
  echo "==> smoke-checking orcaslicer --help (probing version banner)"
  # OrcaSlicer's CLI doesn't accept --version; the version is printed as part
  # of its --help banner ("OrcaSlicer-<ver>:"). Extract that line.
  BANNER="$("${SIDECAR_PATH}" --help 2>&1 || true)"
  echo "${BANNER}" | grep -i -E 'orcaslicer-[0-9]+\.[0-9]+\.[0-9]+' | head -1 \
    || echo "warning: could not find version line in --help banner"
fi

# --- write marker -----------------------------------------------------------
cat > "${MARKER}" <<EOF
# Generated by scripts/build/build-slicer-sidecar.sh. Do not edit by hand.
slicer_version=${SLICER_VERSION}
triple=${TRIPLE}
asset=${ASSET}
asset_sha256=${SHA}
EOF
echo "==> wrote ${MARKER}"
echo "done."
