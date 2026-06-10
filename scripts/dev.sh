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
# Env overrides:
#   VIEWER_PORT   force the Vite port (default: parsed from devUrl)
#   PANDA_DEVTOOLS=1   dock the webview inspector (see CLAUDE.md)
#   PANDA_DEBUG_CLAUDE   mirror the spawned `claude` CLI to this console.
#                        Default in dev: pretty one-line summaries. Set to
#                        `raw` for the full stream-json, or `0` to mute.

set -euo pipefail

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

# Install viewer deps on first run.
if [ ! -d "${REPO_ROOT}/viewer/node_modules" ]; then
  echo "[panda dev] viewer/node_modules missing — installing"
  npm --prefix "${REPO_ROOT}/viewer" install
fi

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
MANIFEST="${REPO_ROOT}/desktop/src-tauri/Cargo.toml"

# ── Real deep-link OAuth in dev (opt-in: PANDA_DEEPLINK=1) ────────────────────
# Panda sign-in ends with the browser redirecting to `myide://auth/callback?…`.
# macOS routes custom URL schemes only to a *registered .app bundle*, never to a
# bare `cargo run` binary — so the normal dev binary never receives the callback
# and sign-in hangs on "Waiting for you to approve in your browser…". This branch
# wraps the freshly-built debug binary in a throwaway `Panda Dev.app`, makes it
# the default `myide` handler, and runs it so the OS delivers the callback to
# this very process via the deep-link plugin's on_open_url. A distinct bundle id
# (…​.dev) keeps the handler choice unambiguous vs an installed /Applications/
# Panda.app; the compiled identifier is still `app.panda.desktop`, so the running
# app's data dir (and dev state) is unchanged. Restores the previous handler on
# exit so a later production sign-in still routes to the installed app.
if [ "${PANDA_DEEPLINK:-0}" = "1" ]; then
  echo "[panda dev] PANDA_DEEPLINK=1 — building bundled dev app for real myide:// login"
  cargo build --manifest-path "$MANIFEST"

  BIN="${REPO_ROOT}/desktop/src-tauri/target/debug/panda-desktop"
  APP="${REPO_ROOT}/desktop/src-tauri/target/debug/Panda Dev.app"
  DEV_ID="app.panda.desktop.dev"
  LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

  # A tiny Swift helper to read/set the default handler for a URL scheme.
  HANDLER_SWIFT="$(mktemp -t panda-urlhandler).swift"
  cat > "$HANDLER_SWIFT" <<'SWIFT'
import Foundation
import CoreServices
let a = CommandLine.arguments
let scheme = a[2] as CFString
if a[1] == "get" {
  if let id = LSCopyDefaultHandlerForURLScheme(scheme)?.takeRetainedValue() { print(id as String) }
} else if a[1] == "set" {
  exit(LSSetDefaultHandlerForURLScheme(scheme, a[3] as CFString) == 0 ? 0 : 1)
}
SWIFT

  # Build the wrapper bundle: the debug binary lives *inside* the .app so macOS
  # associates the running process with the bundle (and so Apple-Event URL
  # callbacks are delivered) even when we exec it directly for an attached stdout.
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  cp "$BIN" "$APP/Contents/MacOS/panda-desktop"
  cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Panda Dev</string>
  <key>CFBundleDisplayName</key><string>Panda Dev</string>
  <key>CFBundleIdentifier</key><string>${DEV_ID}</string>
  <key>CFBundleExecutable</key><string>panda-desktop</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>${DEV_ID}.myide</string>
      <key>CFBundleURLSchemes</key>
      <array><string>myide</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST

  # Remember the current default handler so we can hand myide:// back on exit.
  PREV_HANDLER="$(swift "$HANDLER_SWIFT" get myide 2>/dev/null || true)"
  case "$PREV_HANDLER" in
    ""|"$DEV_ID") PREV_HANDLER="app.panda.desktop" ;;
  esac

  # Register the wrapper with LaunchServices and claim myide:// for it.
  "$LSREGISTER" -f "$APP" >/dev/null 2>&1 || true
  if swift "$HANDLER_SWIFT" set myide "$DEV_ID"; then
    echo "[panda dev] myide:// now routes to ${DEV_ID} (Panda Dev.app)"
  else
    echo "[panda dev] WARNING: could not set myide handler — sign-in may still hang" >&2
  fi

  # On exit: restore the previous handler and stop Vite.
  cleanup() {
    swift "$HANDLER_SWIFT" set myide "$PREV_HANDLER" >/dev/null 2>&1 || true
    echo "[panda dev] restored myide handler -> ${PREV_HANDLER}"
    rm -f "$HANDLER_SWIFT"
    echo "[panda dev] stopping Vite (pid ${VITE_PID})"
    kill "${VITE_PID}" 2>/dev/null || true
  }
  trap cleanup EXIT INT TERM

  echo "[panda dev] launching bundled dev app (deep-link capable)"
  # Run the inner binary directly: foreground (stdout attached for the claude
  # stream + PANDA_DEVTOOLS), but still bundle-associated for myide:// delivery.
  "$APP/Contents/MacOS/panda-desktop" "$@"
else
  echo "[panda dev] launching app (cargo run)"
  cargo run --manifest-path "$MANIFEST" "$@"
fi
