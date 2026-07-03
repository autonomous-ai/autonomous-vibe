---
name: running-panda
description: Use when launching, starting, running, or driving the Panda desktop app (Tauri shell + Vite viewer) — to see a change live, smoke-test the chat/CAD UI, or keep the app running across steps. Covers cargo-not-on-PATH, the blank-window dev port footgun, and detached/persistent launch.
---

# Running the Panda app

Panda is a Tauri 2 desktop app: a Rust shell (`desktop/src-tauri/`) that loads a
Vite + React frontend (`viewer/`). "Running it" means **both halves up at once**:
Vite serving the frontend, the Rust binary showing a window pointed at it.

## Just run it

```bash
.claude/skills/running-panda/launch.sh
```

This builds (incremental), starts Vite on the shell's `devUrl` port, launches the
app **detached** so it survives the calling shell, waits, and prints the pid.
Logs: `~/.panda-run/{vite,app}.log`. It only recycles a prior instance of *this*
dev build and **refuses to start if another Panda app is already running** (see
Safety below). Stop the instance it started with its printed pid:

```bash
kill <printed-pid>            # the app pid launch.sh reported
```

## Safety: never blind-kill a running Panda

**A chat turn is a child process of the app.** The Rust driver spawns the
`claude` turn (and its Python cadcode generator) as children — they are NOT
detached. Kill the app process and you abort the user's in-flight turn; nothing
keeps running in the background, and the UI freezes waiting on an event stream
from a process that's gone. The on-disk session is preserved (Panda `--resume`s
the same per-project session), so the user can re-send their last message to
continue — but the running turn itself is lost.

Therefore: **never `pkill -f panda-desktop` or `pkill -f vite`.** On a shared box
that also matches a packaged `Panda.app` and other users' dev servers. Target a
specific pid, or the exact dev-build path, or the Vite port — which is what
`launch.sh` does.

## Why not `scripts/dev.sh`?

`scripts/dev.sh` is the repo's hand-launch path and it works — but it runs
`cargo run` in the **foreground**, so when the caller ends (an agent Bash task, a
CI step), its EXIT trap stops Vite and the window dies with it. `launch.sh`
nohup/disowns both halves so the app keeps running across turns. Use `dev.sh`
when you'll babysit it in a real terminal; use `launch.sh` to leave it running.

## The four footguns (all handled by launch.sh)

| Symptom | Cause | Fix |
|---|---|---|
| `cargo: command not found` | cargo is rustup-installed, **not** on a non-login shell's PATH | `export PATH="$HOME/.cargo/bin:$PATH"` (cargo 1.96 lives there) |
| Window opens **blank** | bare `npm run dev` serves Vite on its own default **4178**; the shell loads `build.devUrl` = **5173** → nothing to load | start Vite with `VIEWER_PORT=5173` (parsed from `tauri.conf.json`) |
| `permission denied` writing logs | shared box has stale `/tmp/<fixed-name>` owned by another user (e.g. `nhat`) | write logs under `~/.panda-run/` (a dir you own) |
| App exits right after launch | `cargo run` torn down with the parent foreground task (the `IMKCFRunLoopWakeUpReliable` line is benign) | launch the binary **detached** (`nohup … & disown`) |

## Verify it's actually running (don't just launch)

The binary staying alive proves the entrypoint resolved — it does **not** prove
the window rendered. Check all three:

```bash
pgrep -fl panda-desktop                                   # process alive
lsof -iTCP:5173 -sTCP:LISTEN -n -P | grep -c LISTEN       # Vite serving (expect 1)
osascript -e 'tell application "System Events" to get name of every process whose name contains "panda"'  # GUI process registered
```

A blank window = launch failure (almost always the port footgun). Check
`~/.panda-run/app.log` and `~/.panda-run/vite.log`.

## Do NOT use the production bundle to "run the app"

`scripts/build/build-app.sh` needs the Tauri CLI (not a project dep) plus ~1 GB
of bundled CPython + OrcaSlicer sidecars (`scripts/build/build-all-sidecars.sh`).
That's a **shipping** build, not a dev launch. Only go there when the ask is
specifically for a packaged `.app`.

## Driving the app

The user-facing loop is **chat → CAD → slice → print**. To exercise a change,
type a CAD ask in the chat input (e.g. "phone stand"): plan → approve → build.
Watch the turn land via `~/.claude/projects/<encoded-workspace>/<uuid>.jsonl`
(if it's never created, the launch-PATH footgun ate `claude`/`node` — but that
only bites the packaged `.app`, not this dev launch). The 3D viewer previews the
generated `.stl`.
