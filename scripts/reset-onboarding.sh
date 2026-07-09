#!/usr/bin/env bash
set -euo pipefail

# Reset Panda's local onboarding/auth state so the welcome flow shows again.
#
# Usage:
#   scripts/reset-onboarding.sh
#   scripts/reset-onboarding.sh --app-dir "/custom/app/data/dir"
#   scripts/reset-onboarding.sh --dry-run
#
# Default app data dir on macOS for Panda:
#   ~/Library/Application Support/app.Panda.Panda

APP_DIR_DEFAULT="${HOME}/Library/Application Support/app.Panda.Panda"
APP_DIR="${APP_DIR_DEFAULT}"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir)
      APP_DIR="${2:?--app-dir requires a path}"
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    -h|--help)
      cat <<EOF
Reset Panda onboarding/auth state.

Options:
  --app-dir <path>  Override app data directory (default: ${APP_DIR_DEFAULT})
  --dry-run         Print what would change without writing/deleting files
  -h, --help        Show this help
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

SETTINGS="${APP_DIR}/settings.json"
SOCIAL_AUTH="${APP_DIR}/panda-social-auth.json"

echo "[reset] app dir: ${APP_DIR}"

if [[ ${DRY_RUN} -eq 1 ]]; then
  echo "[dry-run] would ensure directory exists: ${APP_DIR}"
  if [[ -f "${SETTINGS}" ]]; then
    echo "[dry-run] would set hasOnboarded=false in ${SETTINGS}"
  else
    echo "[dry-run] would create ${SETTINGS} with hasOnboarded=false"
  fi
  if [[ -f "${SOCIAL_AUTH}" ]]; then
    echo "[dry-run] would remove ${SOCIAL_AUTH}"
  else
    echo "[dry-run] ${SOCIAL_AUTH} already absent"
  fi
  exit 0
fi

mkdir -p "${APP_DIR}"

if command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("fs");
    const p = process.argv[1];

    // Keep this object schema-valid for Rust AppSettings deserialization:
    // defaultFilament + slicerBinaryPath are required (no serde default).
    const defaults = {
      defaultFilament: "PLA",
      slicerBinaryPath: "",
      slicerSettingsProfile: "",
      slicerFilamentProfile: "",
      defaultPrinterId: "",
      hasOnboarded: false,
      autoUpdate: false,
      autoBuild: true,
    };

    let existing = {};
    try {
      if (fs.existsSync(p)) {
        existing = JSON.parse(fs.readFileSync(p, "utf8"));
      }
    } catch {
      existing = {};
    }

    const merged = { ...defaults, ...existing, hasOnboarded: false };
    fs.writeFileSync(p, JSON.stringify(merged, null, 2) + "\\n");
  ' "${SETTINGS}"
else
  # Node-less fallback: write a schema-valid minimal settings object.
  cat > "${SETTINGS}" <<'EOF'
{
  "defaultFilament": "PLA",
  "slicerBinaryPath": "",
  "slicerSettingsProfile": "",
  "slicerFilamentProfile": "",
  "defaultPrinterId": "",
  "hasOnboarded": false,
  "autoUpdate": false,
  "autoBuild": true
}
EOF
fi

if [[ -f "${SOCIAL_AUTH}" ]]; then
  rm -f "${SOCIAL_AUTH}"
  echo "[reset] removed ${SOCIAL_AUTH}"
else
  echo "[reset] ${SOCIAL_AUTH} already absent"
fi

echo "[reset] updated ${SETTINGS}"
cat "${SETTINGS}"

echo "[reset] done. Restart Panda to see onboarding again."
