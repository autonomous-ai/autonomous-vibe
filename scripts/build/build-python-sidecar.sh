#!/usr/bin/env bash
# Build the bundled Python sidecar for Panda's Tauri shell.
#
# Downloads python-build-standalone (CPython 3.11.x), extracts it into
# desktop/src-tauri/resources/python/, then installs the cadpy dependency set
# (cadpy + cadquery + numpy + pillow + trimesh + vtk) into its site-packages.
# A symlink at bin/python3-<arch>-<os> matches Tauri's externalBin naming.
#
# Idempotent: re-runs short-circuit if the .installed marker matches the
# current PYTHON_VERSION.txt and dependency-set hash. Pass --force to rebuild.
#
# Outputs:
#   desktop/src-tauri/resources/python/                  ← Python prefix
#   desktop/src-tauri/resources/python/bin/python3-<triple>  ← Tauri sidecar
#   desktop/src-tauri/resources/python/.installed        ← marker (committed)
#
# v1 supports the host platform. Other-platform branches are sketched but
# untested — see scripts/build/README notes.

set -euo pipefail

# --- locate repo paths ------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PYTHON_VERSION_FILE="${SCRIPT_DIR}/PYTHON_VERSION.txt"
RESOURCES_DIR="${REPO_ROOT}/desktop/src-tauri/resources/python"
CADPY_PKG="${REPO_ROOT}/packages/cadpy"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [[ ! -f "${PYTHON_VERSION_FILE}" ]]; then
  echo "error: ${PYTHON_VERSION_FILE} missing" >&2
  exit 1
fi
PYTHON_VERSION="$(tr -d '[:space:]' < "${PYTHON_VERSION_FILE}")"
# PYTHON_VERSION looks like "3.11.15+20260510" — split into pieces.
PY_SEMVER="${PYTHON_VERSION%+*}"
PBS_TAG="${PYTHON_VERSION#*+}"

# --- detect host triple -----------------------------------------------------
HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"
case "${HOST_OS}-${HOST_ARCH}" in
  Darwin-arm64)  TRIPLE="aarch64-apple-darwin" ;;
  Darwin-x86_64) TRIPLE="x86_64-apple-darwin" ;;
  Linux-x86_64)  TRIPLE="x86_64-unknown-linux-gnu" ;;
  Linux-aarch64) TRIPLE="aarch64-unknown-linux-gnu" ;;
  # Windows: assume MSYS / Git Bash reports MINGW / CYGWIN. Untested.
  MINGW*|MSYS*|CYGWIN*) TRIPLE="x86_64-pc-windows-msvc" ;;
  *)
    echo "error: unsupported host ${HOST_OS}-${HOST_ARCH}" >&2
    exit 1
    ;;
esac

# Dep set as a single string. Hashed into the marker so a change forces a
# rebuild. The cadpy editable install pulls cadpy's own pyproject deps; we
# additionally pin the extras the cadcode skill imports directly.
DEP_SET=(
  "-e" "${CADPY_PKG}"
  "cadquery"
  "numpy"
  "pillow"
  "trimesh"
  "vtk"
)
DEP_HASH="$(printf '%s\n' "${DEP_SET[@]}" "${PYTHON_VERSION}" "${TRIPLE}" | shasum -a 256 | awk '{print $1}')"
MARKER="${RESOURCES_DIR}/.installed"

# --- short-circuit if marker matches AND interpreter is actually present ---
# (A marker alone isn't sufficient — markers are committed as scaffolding,
# so a fresh checkout may have the marker file but no real interpreter.)
EXPECTED_PY="${RESOURCES_DIR}/bin/python3"
if [[ "${FORCE}" -eq 0 && -f "${MARKER}" && -s "${EXPECTED_PY}" ]]; then
  if grep -q "^dep_hash=${DEP_HASH}$" "${MARKER}" 2>/dev/null; then
    echo "python sidecar already installed (dep_hash=${DEP_HASH}); skipping."
    echo "  use --force to rebuild."
    exit 0
  fi
fi

# --- pick install_only.tar.gz URL ------------------------------------------
ASSET="cpython-${PYTHON_VERSION}-${TRIPLE}-install_only.tar.gz"
URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${ASSET}"

echo "==> downloading ${ASSET}"
TMP_DIR="$(mktemp -d -t panda-pysidecar.XXXXXX)"
trap 'rm -rf "${TMP_DIR}"' EXIT
TARBALL="${TMP_DIR}/${ASSET}"
curl -fL --retry 3 --connect-timeout 20 -o "${TARBALL}" "${URL}"

# --- wipe + extract ---------------------------------------------------------
# Preserve the externalBin placeholder file location so we can recreate it as
# a symlink to the real interpreter at the end. We blow away the directory
# contents (except the .installed marker, which we'll rewrite).
echo "==> clearing previous install at ${RESOURCES_DIR}"
mkdir -p "${RESOURCES_DIR}"
# Note: keep the directory itself, just remove its contents.
find "${RESOURCES_DIR}" -mindepth 1 -maxdepth 1 ! -name '.installed' -exec rm -rf {} +

echo "==> extracting tarball"
# The standalone tarball roots at "python/"; strip that prefix.
tar -xzf "${TARBALL}" -C "${RESOURCES_DIR}" --strip-components=1

# --- install wheels ---------------------------------------------------------
PY_BIN="${RESOURCES_DIR}/bin/python3"
if [[ ! -x "${PY_BIN}" ]]; then
  # Windows tarballs put python.exe at the prefix root, not bin/.
  if [[ -x "${RESOURCES_DIR}/python.exe" ]]; then
    PY_BIN="${RESOURCES_DIR}/python.exe"
  else
    echo "error: extracted python interpreter not found under ${RESOURCES_DIR}" >&2
    exit 1
  fi
fi

echo "==> installing dependencies: ${DEP_SET[*]}"
if command -v uv >/dev/null 2>&1; then
  # `uv pip install --python <embedded-python>` installs into that
  # interpreter's site-packages, which is exactly the embedded prefix.
  uv pip install --python "${PY_BIN}" "${DEP_SET[@]}"
else
  echo "  uv not found — falling back to bundled pip (slower)"
  "${PY_BIN}" -m ensurepip --upgrade
  "${PY_BIN}" -m pip install --upgrade pip
  "${PY_BIN}" -m pip install "${DEP_SET[@]}"
fi

# --- create Tauri-named symlink --------------------------------------------
SIDECAR_NAME="python3-${TRIPLE}"
SIDECAR_PATH="${RESOURCES_DIR}/bin/${SIDECAR_NAME}"
echo "==> linking bin/${SIDECAR_NAME} -> python3"
rm -f "${SIDECAR_PATH}"
ln -s "python3" "${SIDECAR_PATH}"

# --- smoke check -----------------------------------------------------------
echo "==> smoke-importing cadpy + deps"
"${PY_BIN}" -c "import cadpy, cadquery, numpy, PIL, trimesh, vtk; print('OK:', cadpy.__file__)"

# --- write marker ----------------------------------------------------------
cat > "${MARKER}" <<EOF
# Generated by scripts/build/build-python-sidecar.sh. Do not edit by hand.
python_version=${PYTHON_VERSION}
triple=${TRIPLE}
dep_hash=${DEP_HASH}
EOF
echo "==> wrote ${MARKER}"
echo "done."
