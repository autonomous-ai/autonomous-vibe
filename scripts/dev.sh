#!/usr/bin/env bash
# Run Panda in dev mode: Vite dev server + the Tauri shell via plain `cargo run`.
#
# Why this exists (and why `cargo run` alone is not enough):
#   - The Tauri CLI (`cargo tauri dev`) is not a project dependency, so its
#     `beforeDevCommand` (which would start Vite) never runs. Plain `cargo run`
#     only builds and launches the Rust binary; it expects a frontend already
#     being served at the config's `devUrl`.
#   - The viewer defaults to port 4178 (DEFAULT_VIEWER_PORT, strictPort), but
#     the shell loads `build.devUrl` from tauri.conf.json (5173). This script
#     reads that port and starts Vite on it via VIEWER_PORT, so the two agree.
#
# This script starts Vite in the background, waits for it to listen, then runs
# the app in the foreground. Quitting the app (or Ctrl-C) stops Vite too.
#
# Usage:
#   scripts/dev.sh [--theme system|light|dark] [-- <extra cargo run args>]
#
# Flags:
#   --theme <system|light|dark>   force the app's color scheme for this dev
#                                  session (default: system — follow the OS).
#                                  Exported to the viewer as VIEWER_COLOR_SCHEME
#                                  and read in src/client/ui/colorScheme.js. It
#                                  seeds the initial theme; in-app toggling still
#                                  works for the session.
#
# Env overrides:
#   VIEWER_PORT   force the Vite port (default: parsed from devUrl)
#   PANDA_DEVTOOLS=1   dock the webview inspector (see CLAUDE.md)
#   PANDA_DEBUG_CLAUDE   mirror the spawned `claude` CLI to this console.
#                        Default in dev: pretty one-line summaries. Set to
#                        `raw` for the full stream-json, or `0` to mute.

set -euo pipefail

# Parse our own flags out of the arg list; anything else is forwarded verbatim
# to `cargo run` at the end. Default theme is "system" so a bare `dev.sh`
# follows the OS appearance (the app's normal default).
PANDA_THEME="system"
CARGO_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --theme) PANDA_THEME="${2:-}"; shift 2 ;;
    --theme=*) PANDA_THEME="${1#--theme=}"; shift ;;
    *) CARGO_ARGS+=("$1"); shift ;;
  esac
done

case "$PANDA_THEME" in
  system | light | dark) ;;
  *)
    echo "[panda dev] invalid --theme '${PANDA_THEME}' (use: system, light, dark)" >&2
    exit 1
    ;;
esac
# Vite's envPrefix is VIEWER_; export so the dev server forwards it to the client.
export VIEWER_COLOR_SCHEME="$PANDA_THEME"

# Stream the spawned `claude` subprocess into this dev console so you can watch
# each turn as it runs — a compact, colorized line per event (▶ turn, ◆ init,
# » text, ⚙ tool + input, ■ result; an empty ExitPlanMode is flagged in red).
# Default on (pretty) in dev; `=raw` shows the full stream-json, `=0` mutes.
export PANDA_DEBUG_CLAUDE="${PANDA_DEBUG_CLAUDE:-1}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_CONF="${REPO_ROOT}/desktop/src-tauri/tauri.conf.json"

# Port the shell will load the frontend from: parse devUrl unless overridden.
if [ -z "${VIEWER_PORT:-}" ]; then
  VIEWER_PORT="$(grep -oE '"devUrl"[^,]*' "$TAURI_CONF" | grep -oE '[0-9]+' | tail -1)"
fi
: "${VIEWER_PORT:?could not determine dev port (set VIEWER_PORT)}"
export VIEWER_PORT

echo "[panda dev] using port ${VIEWER_PORT} (from devUrl in tauri.conf.json)"

# Install viewer deps. npm install is idempotent (no-ops when the lockfile is
# already satisfied) and picks up package.json changes between runs, so run it
# every time rather than only when node_modules is missing.
echo "[panda dev] installing viewer deps (npm install)"
npm --prefix "${REPO_ROOT}/viewer" install

# Vendor cadpy into the skill runtimes so the cadcode generator has a working
# pipeline. The dev install (cargo run) falls back to the repo `skills/` tree;
# if cadpy is empty the generator improvises export/render scripts (clutter +
# non-contract artifacts). Cheap + idempotent, so run it every time.
echo "[panda dev] vendoring skill runtimes (cadpy)"
"${REPO_ROOT}/scripts/build/build-skill-runtimes.sh"

# Start Vite in the background; stop it when this script exits.
echo "[panda dev] starting Vite dev server"
npm --prefix "${REPO_ROOT}/viewer" run dev &
VITE_PID=$!
cleanup() {
  echo "[panda dev] stopping Vite (pid ${VITE_PID})"
  kill "${VITE_PID}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Wait for Vite to accept connections before launching the shell, so the
# webview connects on first load instead of showing a blank/error page.
echo "[panda dev] waiting for http://127.0.0.1:${VIEWER_PORT} ..."
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${VIEWER_PORT}/"; then
    echo "[panda dev] Vite is up"
    break
  fi
  # Bail early if Vite died (e.g. port already in use).
  kill -0 "${VITE_PID}" 2>/dev/null || { echo "[panda dev] Vite exited before becoming ready" >&2; exit 1; }
  sleep 0.5
done

# Run the app in the foreground. Flag order matters: this cargo rejects
# `cargo --manifest-path ... run`; the flag must follow the subcommand.
if [ "${PANDA_DEBUG_CLAUDE}" != "0" ] && [ -n "${PANDA_DEBUG_CLAUDE}" ]; then
  if [ "${PANDA_DEBUG_CLAUDE}" = "raw" ]; then
    echo "[panda dev] streaming claude stdio (raw stream-json); PANDA_DEBUG_CLAUDE=0 to mute"
  else
    echo "[panda dev] streaming claude (pretty); PANDA_DEBUG_CLAUDE=raw for full JSON, =0 to mute"
  fi
fi
echo "[panda dev] launching app (cargo run), theme=${PANDA_THEME}"
# `${CARGO_ARGS[@]+...}` keeps `set -u` happy when no extra args were passed
# (bash 3.2 errors on an empty array expanded under nounset).
cargo run --manifest-path "${REPO_ROOT}/desktop/src-tauri/Cargo.toml" ${CARGO_ARGS[@]+"${CARGO_ARGS[@]}"}
