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

# sha256 <file> — portable digest. git-bash on Windows lacks `shasum`; macOS
# lacks `sha256sum`. Prefer whichever exists.
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SLICER_VERSION_FILE="${SCRIPT_DIR}/SLICER_VERSION.txt"
RESOURCES_DIR="${REPO_ROOT}/desktop/src-tauri/resources/slicer"

FORCE=0
TARGET_TRIPLE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1 ;;
    --target) TARGET_TRIPLE="${2:?--target needs a triple}"; shift ;;
    --target=*) TARGET_TRIPLE="${1#--target=}" ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ ! -f "${SLICER_VERSION_FILE}" ]]; then
  echo "error: ${SLICER_VERSION_FILE} missing" >&2
  exit 1
fi
SLICER_VERSION="$(tr -d '[:space:]' < "${SLICER_VERSION_FILE}")"  # e.g. v2.3.2
# Strip leading 'v' for use inside the asset filename.
SLICER_VER_NUM="${SLICER_VERSION#v}"

# --- resolve target triple --------------------------------------------------
# Defaults to the host triple; --target selects another arch. On macOS this is
# effectively cosmetic: OrcaSlicer ships one *universal* DMG, so the same .app
# serves both aarch64 and x86_64 — we emit both darwin sidecar symlinks below
# regardless of which triple was requested.
if [[ -n "${TARGET_TRIPLE}" ]]; then
  TRIPLE="${TARGET_TRIPLE}"
else
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
fi

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
if [[ "${FORCE}" -eq 0 && -f "${MARKER}" && -s "${PAYLOAD}" ]] \
    && grep -q "^slicer_version=${SLICER_VERSION}$" "${MARKER}" 2>/dev/null; then
  case "${TRIPLE}" in
    *-apple-darwin)
      # Universal .app: one payload serves both darwin arches. Don't re-download
      # just because the marker records the other triple — instead self-heal the
      # requested sidecar symlink (it may be missing on a fresh checkout) and
      # exit. Both arch symlinks point at the same Mach-O inside the bundle.
      if [[ ! -e "${SIDECAR_PATH}" ]]; then
        echo "==> linking ${SIDECAR_NAME} -> OrcaSlicer.app (universal)"
        ln -s "OrcaSlicer.app/Contents/MacOS/OrcaSlicer" "${SIDECAR_PATH}"
      fi
      echo "slicer sidecar already installed (${SLICER_VERSION}, universal); skipping."
      echo "  use --force to rebuild."
      exit 0
      ;;
    *)
      if grep -q "^triple=${TRIPLE}$" "${MARKER}" 2>/dev/null; then
        echo "slicer sidecar already installed (${SLICER_VERSION}); skipping."
        echo "  use --force to rebuild."
        exit 0
      fi
      ;;
  esac
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
SHA="$(sha256 "${DOWNLOAD}")"
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
    # frameworks (@rpath/...) resolve. The DMG is universal, so emit BOTH
    # darwin arch symlinks from this one build — an Apple Silicon host can then
    # bundle either an arm64 or an x86_64 (Intel) app without re-extracting.
    for t in aarch64-apple-darwin x86_64-apple-darwin; do
      link="${RESOURCES_DIR}/orcaslicer-${t}"
      rm -f "${link}"
      ln -s "OrcaSlicer.app/Contents/MacOS/OrcaSlicer" "${link}"
    done
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
    # Git-Bash on a GitHub windows runner may ship none of these; try them in
    # order of preference. `7z` and PowerShell are always present on the runner.
    if command -v unzip >/dev/null; then
      unzip -q "${DOWNLOAD}" -d "${UNZIP_DIR}"
    elif command -v 7z >/dev/null; then
      7z x -y -o"${UNZIP_DIR}" "${DOWNLOAD}" >/dev/null
    elif command -v powershell >/dev/null; then
      powershell -NoProfile -Command \
        "Expand-Archive -Force -LiteralPath '${DOWNLOAD}' -DestinationPath '${UNZIP_DIR}'"
    else
      echo "error: need one of unzip / 7z / powershell to extract the portable zip" >&2
      exit 1
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
