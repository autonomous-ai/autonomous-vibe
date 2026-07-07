#!/usr/bin/env bash
# Build the bundled Python sidecar for Panda's Tauri shell.
#
# Downloads python-build-standalone (CPython 3.11.x), extracts it into
# desktop/src-tauri/resources/python/, then installs the cadpy dependency set
# (cadpy + cadquery + numpy + pillow + trimesh + vtk) into its site-packages.
# A symlink at bin/python3-<arch>-<os> matches Tauri's externalBin naming.
#
# Idempotent: re-runs short-circuit if the per-platform .installed-<triple>
# marker matches the current PYTHON_VERSION.txt and dependency-set hash. Pass
# --force to rebuild.
#
# Caches under ~/.cache/panda/pysidecar (override: PANDA_PYSIDECAR_CACHE) keep
# the two-arch upload-gcs run fast. That run wipes the shared resources/python
# prefix on every arch swap; rather than re-download + re-pip-install each time,
# we cache both the downloaded tarball AND the fully-built per-arch prefix, so a
# swap is a local restore. Same-arch reruns still short-circuit on the marker.
#
# Outputs:
#   desktop/src-tauri/resources/python/                  ← Python prefix
#   desktop/src-tauri/resources/python/bin/python3-<triple>  ← Tauri sidecar
#   desktop/src-tauri/resources/python/.installed-<triple>   ← marker (gitignored)
#
# The bare `.installed` is committed scaffolding and is left untouched, so a
# two-arch build no longer rewrites a tracked file.
#
# v1 supports the host platform. Other-platform branches are sketched but
# untested — see scripts/build/README notes.

set -euo pipefail

# --- portable helpers -------------------------------------------------------
# git-bash on Windows ships neither `shasum` nor `rsync`; macOS has `shasum`
# but not `sha256sum` by default. Prefer the tool that exists on each host.
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

# mirror_dir <src/> <dst/> — replace dst's contents with src's. rsync when
# available (fast, --delete semantics), else a clear-then-cp -R fallback for
# git-bash. Both args should be directory paths; a trailing slash is fine.
mirror_dir() {
  local src="${1%/}" dst="${2%/}"
  mkdir -p "${dst}"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "${src}/" "${dst}/"
  else
    find "${dst}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    cp -R "${src}/." "${dst}/"
  fi
}

# --- locate repo paths ------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PYTHON_VERSION_FILE="${SCRIPT_DIR}/PYTHON_VERSION.txt"
RESOURCES_DIR="${REPO_ROOT}/desktop/src-tauri/resources/python"
CADPY_PKG="${REPO_ROOT}/packages/cadpy"

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

if [[ ! -f "${PYTHON_VERSION_FILE}" ]]; then
  echo "error: ${PYTHON_VERSION_FILE} missing" >&2
  exit 1
fi
PYTHON_VERSION="$(tr -d '[:space:]' < "${PYTHON_VERSION_FILE}")"
# PYTHON_VERSION looks like "3.11.15+20260510" — split into pieces.
PY_SEMVER="${PYTHON_VERSION%+*}"
PBS_TAG="${PYTHON_VERSION#*+}"

# --- resolve target triple --------------------------------------------------
# Defaults to the host triple; --target cross-builds another arch (e.g. an
# x86_64 sidecar on an Apple Silicon host, for a universal/Intel release).
# python-build-standalone ships per-triple tarballs, so the only requirement
# for a cross-build is that pip/uv can resolve wheels for the target
# interpreter (it reads the platform tags from that interpreter) and that the
# smoke import can run it (x86_64 on arm needs Rosetta 2).
if [[ -n "${TARGET_TRIPLE}" ]]; then
  TRIPLE="${TARGET_TRIPLE}"
else
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
fi
echo "==> target triple: ${TRIPLE}"

# python-build-standalone lays the interpreter out per-OS: Unix tarballs put it
# at bin/python3 (a symlink to python3.11); the Windows tarball roots it at the
# prefix as python.exe with no bin/. PY_REL is the interpreter's path relative
# to the prefix, used by the short-circuit + cache-restore probes below.
case "${TRIPLE}" in
  *-pc-windows-*) PY_REL="python.exe" ;;
  *)              PY_REL="bin/python3" ;;
esac

# Dep set as a single string. Hashed into the marker so a change forces a
# rebuild. The cadpy editable install pulls cadpy's own pyproject deps; we
# additionally pin the extras the cadcode skill imports directly.
DEP_SET=(
  "-e" "${CADPY_PKG}"
  # <2.8: cadquery 2.8.0 hard-requires numba -> llvmlite, neither of which has a
  # macOS x86_64 (Intel) wheel for the required versions, so the Intel sidecar
  # cross-build compiles llvmlite from source and fails on missing LLVM. Keep in
  # sync with the cap in packages/cadpy/pyproject.toml.
  "cadquery<2.8"
  "numpy"
  "pillow"
  "trimesh"
  "vtk"
)
DEP_HASH="$(printf '%s\n' "${DEP_SET[@]}" "${PYTHON_VERSION}" "${TRIPLE}" | sha256)"

# Per-platform marker. The committed resources/python/.installed must stay
# pristine — a two-arch build that rewrote it (different triple/dep_hash per
# arch) showed up as spurious git churn. resources/python only ever holds ONE
# arch at a time (it's wiped on extract / rsync'd wholesale on restore), so a
# per-triple marker unambiguously records which arch is currently materialized,
# and is gitignored (only the bare `.installed` is tracked).
MARKER_NAME=".installed-${TRIPLE}"
MARKER="${RESOURCES_DIR}/${MARKER_NAME}"

# --- short-circuit if marker matches AND interpreter is actually present ---
# (A marker alone isn't sufficient — a fresh checkout may have a stale marker
# but no real interpreter.)
EXPECTED_PY="${RESOURCES_DIR}/${PY_REL}"
if [[ "${FORCE}" -eq 0 && -f "${MARKER}" && -s "${EXPECTED_PY}" ]]; then
  if grep -q "^dep_hash=${DEP_HASH}$" "${MARKER}" 2>/dev/null; then
    echo "python sidecar already installed (dep_hash=${DEP_HASH}); skipping."
    echo "  use --force to rebuild."
    exit 0
  fi
fi

# --- cache layout -----------------------------------------------------------
# upload-gcs builds BOTH arches into the single shared resources/python prefix,
# so the per-triple marker can never stay satisfied across arches: the prefix is
# wiped and rebuilt on every arch swap (twice per full build). We avoid the slow
# parts of that rebuild with two caches, both keyed by triple (+ version/deps):
#   tarballs/   the downloaded python-build-standalone archive (skips network)
#   prefix-<triple>/  the fully-built install — interpreter + pip deps — so an
#                     arch swap restores via a local copy (skips extract + pip).
# Override the root with PANDA_PYSIDECAR_CACHE.
CACHE_DIR="${PANDA_PYSIDECAR_CACHE:-${HOME}/.cache/panda/pysidecar}"
TARBALL_CACHE="${CACHE_DIR}/tarballs"
PREFIX_CACHE="${CACHE_DIR}/prefix-${TRIPLE}"
mkdir -p "${TARBALL_CACHE}"

# --- fast path: restore a previously-built prefix from cache ----------------
# If this triple's full prefix was built before (matching dep_hash), copy it
# back into resources/python. No download, no extract, no pip — this is what
# makes the two-arch upload-gcs run cheap: each swap is a local rsync.
if [[ "${FORCE}" -eq 0 && -s "${PREFIX_CACHE}/${PY_REL}" ]] \
   && grep -q "^dep_hash=${DEP_HASH}$" "${PREFIX_CACHE}/${MARKER_NAME}" 2>/dev/null; then
  echo "==> restoring cached prefix for ${TRIPLE} (dep_hash=${DEP_HASH})"
  mirror_dir "${PREFIX_CACHE}" "${RESOURCES_DIR}"
  if "${RESOURCES_DIR}/${PY_REL}" -c "import cadpy, cadquery, numpy, PIL, trimesh, vtk" >/dev/null 2>&1; then
    echo "==> restored from cache; done."
    exit 0
  fi
  echo "    cached prefix failed smoke import — rebuilding from scratch" >&2
fi

# --- pick install_only.tar.gz URL ------------------------------------------
ASSET="cpython-${PYTHON_VERSION}-${TRIPLE}-install_only.tar.gz"
URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${ASSET}"
TARBALL="${TARBALL_CACHE}/${ASSET}"

if [[ -s "${TARBALL}" ]]; then
  echo "==> using cached ${ASSET} (${TARBALL_CACHE})"
else
  echo "==> downloading ${ASSET}"
  # Download to a temp file in the cache dir, then atomically rename in — a
  # ^C'd or failed curl never leaves a truncated tarball that a later run would
  # trust because of the -s (non-empty) check above.
  TMP_TARBALL="$(mktemp "${TARBALL_CACHE}/.${ASSET}.XXXXXX")"
  trap 'rm -f "${TMP_TARBALL}"' EXIT
  curl -fL --retry 3 --connect-timeout 20 -o "${TMP_TARBALL}" "${URL}"
  mv -f "${TMP_TARBALL}" "${TARBALL}"
  trap - EXIT
fi

# --- wipe + extract ---------------------------------------------------------
# Blow away the directory contents, but keep the committed `.installed` (exact
# name) pristine — it's tracked scaffolding we must never modify. Per-platform
# `.installed-<triple>` markers are intentionally NOT preserved: wiping any
# stale other-arch marker here is what prevents a false short-circuit, and the
# current arch's marker is rewritten at the end.
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

# --- create Tauri-named sidecar symlinks -----------------------------------
# Tauri's externalBin needs a bin/python3-<triple> for every target we might
# bundle, and these are tracked (gitignore allow-list) so a fresh checkout
# resolves them. Recreate the symlink for EVERY such triple — not just the one
# we built — so an arch swap never DELETES a tracked sidecar and shows up as a
# git rename. The symlink is one line pointing at the relative `python3`; only
# the interpreter it resolves to is arch-specific, and that (python3.11) is
# gitignored. Whichever arch is currently materialized, bundling uses just its
# own python3-<target>; the sibling symlink is inert until that arch is built.
SIDECAR_TRIPLES=(aarch64-apple-darwin x86_64-apple-darwin)
case " ${SIDECAR_TRIPLES[*]} " in
  *" ${TRIPLE} "*) ;;                       # darwin target — already listed
  *) SIDECAR_TRIPLES=("${TRIPLE}") ;;       # non-darwin (linux/windows) — only its own
esac
mkdir -p "${RESOURCES_DIR}/bin"
for t in "${SIDECAR_TRIPLES[@]}"; do
  case "${t}" in
    *-pc-windows-*)
      # Windows: Tauri's externalBin resolves to bin/python3-<triple>.exe and
      # must be a REAL file (git-bash symlinks don't survive the bundler, and
      # there's no bin/python3 to point at — the interpreter is python.exe at
      # the prefix root). Copy it. (It won't find its stdlib from here, but the
      # bundled sidecar isn't runtime-wired yet — same as macOS; we only need a
      # correctly-named file so the bundler's externalBin check passes.)
      sp="${RESOURCES_DIR}/bin/python3-${t}.exe"
      echo "==> copying bin/python3-${t}.exe <- python.exe"
      rm -f "${sp}"
      cp "${PY_BIN}" "${sp}"
      ;;
    *)
      sp="${RESOURCES_DIR}/bin/python3-${t}"
      echo "==> linking bin/python3-${t} -> python3"
      rm -f "${sp}"
      ln -s "python3" "${sp}"
      ;;
  esac
done

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

# --- snapshot the built prefix into the cache -------------------------------
# So the next time this arch is requested — e.g. the other arch's build in a
# two-arch upload-gcs run wiped resources/python — the fast path above restores
# it with a local copy instead of re-downloading and re-running pip.
echo "==> caching built prefix -> ${PREFIX_CACHE}"
mirror_dir "${RESOURCES_DIR}" "${PREFIX_CACHE}"

echo "done."
