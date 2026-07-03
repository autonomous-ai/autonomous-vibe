#!/usr/bin/env bash
# Launch Panda (Vite + Tauri shell) DETACHED so it outlives the calling shell.
#
# This is the verified "run the app" recipe. It deliberately does NOT use
# scripts/dev.sh: dev.sh runs `cargo run` in the foreground, so when the caller
# (an agent's Bash task, a CI step) ends, the app's EXIT trap stops Vite and the
# window dies. Here Vite and the app are nohup/disown'd and survive.
#
# What this captures that bit us during bring-up (see SKILL.md for detail):
#   - cargo is NOT on the default PATH; it lives in the rustup bin dir.
#   - the Tauri shell loads build.devUrl (5173); a bare `npm run dev` serves the
#     viewer's own default (4178), so the webview loads nothing -> blank window.
#   - shared /tmp logs collide with other users' files (permission denied).
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SKILL_DIR" rev-parse --show-toplevel)"

# 1. cargo is installed via rustup, not Homebrew, so it is not on the PATH a
#    fresh non-login shell inherits. Prepend it.
export PATH="$HOME/.cargo/bin:$PATH"
command -v cargo >/dev/null || { echo "error: cargo not found (expected ~/.cargo/bin/cargo)" >&2; exit 1; }

# 2. Port the shell will load the frontend from — parse it from tauri.conf.json
#    so Vite and the shell always agree. (Do NOT rely on Vite's default 4178.)
PORT="$(grep -oE '"devUrl"[^,]*' "$REPO_ROOT/desktop/src-tauri/tauri.conf.json" | grep -oE '[0-9]+' | tail -1)" || true
: "${PORT:?could not parse devUrl port from tauri.conf.json}"

# 3. Logs go in a dir WE own — never a bare /tmp/<fixed-name> (collides with
#    other users on shared boxes -> "permission denied").
RUN_DIR="$HOME/.panda-run"; mkdir -p "$RUN_DIR"
VLOG="$RUN_DIR/vite.log"; ALOG="$RUN_DIR/app.log"

echo "[run] repo=$REPO_ROOT port=$PORT logs=$RUN_DIR"

# Clean slate — but ONLY recycle a previous instance of THIS dev build. Never
# blind-kill: a packaged Panda.app (or another worktree's dev build) may be a
# real session running a chat turn, and that turn is a CHILD of the app — kill
# the app and you abort the user's in-flight turn with no way to recover it.
DEV_BIN="$REPO_ROOT/desktop/src-tauri/target/debug/panda-desktop"
OTHERS="$(pgrep -fl panda-desktop 2>/dev/null | grep -v -F "$DEV_BIN" || true)"
if [ -n "$OTHERS" ]; then
  echo "[run] refusing to start: another Panda app is already running (not this dev build):" >&2
  echo "$OTHERS" | sed 's/^/[run]   /' >&2
  echo "[run] it may have a chat turn in flight. Quit it yourself, then re-run." >&2
  exit 1
fi
# Recycle only our own prior dev instance. Match with the SAME fixed-string
# filter used for detection above (grep -F on the full dev path), NOT `pkill -f`
# whose pattern is a regex — a REPO_ROOT with a regex metachar (e.g. a worktree
# under a `.`-containing path) would make the two disagree about "our build".
pgrep -fl panda-desktop 2>/dev/null | grep -F "$DEV_BIN" | awk '{print $1}' | xargs kill 2>/dev/null || true
# Free our Vite port if a stale listener holds it (don't pkill all 'vite' on a
# shared box — that's someone else's dev server).
lsof -ti "tcp:$PORT" 2>/dev/null | xargs kill 2>/dev/null || true
sleep 1

# Vendor cadpy into the skill runtimes so the cadcode generator has a real
# pipeline (mirrors dev.sh; cheap + idempotent). Non-fatal if it hiccups.
"$REPO_ROOT/scripts/build/build-skill-runtimes.sh" >>"$RUN_DIR/vendor.log" 2>&1 || \
  echo "[run] warning: build-skill-runtimes.sh failed (see $RUN_DIR/vendor.log)" >&2

# 4. Start Vite on the shell's devUrl port, detached.
: > "$VLOG"
VIEWER_PORT="$PORT" nohup npm --prefix "$REPO_ROOT/viewer" run dev >"$VLOG" 2>&1 &
disown
echo "[run] vite starting on $PORT (pid $!)"
for _ in $(seq 1 60); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break
  sleep 0.5
done
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" || { echo "[run] Vite never came up:" >&2; tail -20 "$VLOG" >&2; exit 1; }
echo "[run] vite up"

# 5. Build (incremental) + launch the app, detached. First build is ~30s; later
#    runs are cached. Foreground compile output streams to the app log.
( cd "$REPO_ROOT/desktop/src-tauri" && cargo build ) || { echo "[run] cargo build failed" >&2; exit 1; }
: > "$ALOG"
nohup "$REPO_ROOT/desktop/src-tauri/target/debug/panda-desktop" >"$ALOG" 2>&1 &
APP_PID=$!
disown
sleep 6
if kill -0 "$APP_PID" 2>/dev/null; then
  echo "[run] APP RUNNING pid=$APP_PID  (window should be open)"
  echo "[run] stop with: kill $APP_PID   (do NOT pkill -f panda-desktop — see SKILL.md Safety)"
else
  echo "[run] app exited immediately; log:" >&2; cat "$ALOG" >&2; exit 1
fi
