#!/usr/bin/env bash
# Stamp the app version into the Tauri bundle config and Rust manifests.
#
# Releases are tag-triggered (see .github/workflows/release.yml): CI runs this
# with the pushed tag so the bundled .app version always matches the git tag —
# no hand-edited "bump version" commit required. The value committed in the repo
# is just a baseline (the last released version) for local dev builds.
#
# Usage:
#   set-version.sh 0.1.12     # explicit
#   set-version.sh v0.1.12    # a leading "v" is stripped
#   set-version.sh            # derive from the latest `git describe --tags`
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

VERSION="${1:-}"
if [ -z "${VERSION}" ]; then
  VERSION="$(git -C "${REPO_ROOT}" describe --tags --abbrev=0 2>/dev/null || true)"
fi
VERSION="${VERSION#v}"

if [ -z "${VERSION}" ]; then
  echo "set-version: no version given and no git tag found" >&2
  exit 1
fi
# Tauri's bundle version must be plain semver (major.minor.patch[-pre/+build]).
if ! printf '%s' "${VERSION}" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+].*)?$'; then
  echo "set-version: '${VERSION}' is not a valid semver version" >&2
  exit 1
fi

TAURI_CONF="${REPO_ROOT}/desktop/src-tauri/tauri.conf.json"
CARGO_TOML="${REPO_ROOT}/desktop/src-tauri/Cargo.toml"
CARGO_LOCK="${REPO_ROOT}/desktop/src-tauri/Cargo.lock"

# tauri.conf.json: the first top-level "version" key (the bundle version).
# BEGIN{shift} pulls VERSION off @ARGV before perl's -i file loop sees it.
perl -0pi -e 'BEGIN{$v=shift @ARGV} s/("version":\s*")[^"]*(")/${1}${v}${2}/' \
  "${VERSION}" "${TAURI_CONF}"

# Cargo.toml + Cargo.lock: the version line directly under the panda-desktop
# package (anchored on the name so unrelated crates with a version line are
# never touched).
perl -0pi -e 'BEGIN{$v=shift @ARGV} s/(name = "panda-desktop"\nversion = ")[^"]*(")/${1}${v}${2}/' \
  "${VERSION}" "${CARGO_TOML}"
perl -0pi -e 'BEGIN{$v=shift @ARGV} s/(name = "panda-desktop"\nversion = ")[^"]*(")/${1}${v}${2}/' \
  "${VERSION}" "${CARGO_LOCK}"

echo "set-version: stamped ${VERSION}"
