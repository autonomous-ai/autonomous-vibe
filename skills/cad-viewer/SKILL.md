---
name: cad-viewer
description: Start or reuse CAD Viewer and return review links for explicit CAD, robot-description, and G-code files. Use when visually reviewing `.step`, `.stp`, `.glb`, `.stl`, `.3mf`, `.gcode`, `.dxf`, `.urdf`, `.srdf`, or `.sdf` files, especially when handed off from CAD, G-code, URDF, SRDF, or SDF generation skills.
---

# CAD Viewer

Use this skill to open existing or newly generated CAD, robot-description, DXF, or plain FDM G-code files in CAD Viewer and hand back live review links. The expected input is one or more explicit file paths.

## Start Viewer

Always start CAD Viewer with the root directory that owns the model files (.step, .glb, .stl, .urdf, etc).
Always pass `--root-dir /path/to/root`; the flag is required. This flag is
the full Viewer root directory; do not treat it as a subdirectory inside another
repo root.

Port reuse depends on passing the same resolved root directory every time.
`serve:ensure` probes the Viewer port range, asks each live server what root
directory it serves, and reuses a port only when that server's root directory
matches the current `--root-dir` and the requested file is available in its
catalog. Passing a model subfolder, a different checkout path, or relying on a
different current directory changes the resolved root and can cause
`serve:ensure` to start a new port. Always pass the same project root directory
with `--root-dir` for handoffs from the same project.

New Viewer servers started by `serve:ensure` shut down automatically after 12
hours. Use the default unless the user explicitly asks for a different
lifetime; then pass `--shutdown-after <duration>` with an `ms`, `s`, `m`, or
`h` suffix. This flag only applies when a new server starts; reusing an existing
matching port does not change that server's existing shutdown timer.

If the user has a Viewer URL open, treat that port as the first reuse candidate.
Return a URL on that same port whenever it already serves the same root
directory, changing only the `?file=` query. Do not start a separate Viewer with
a different root directory just to make a file appear faster; wait for the
existing server/catalog, rerun `serve:ensure` with the same project root
directory, or report the startup/catalog failure.

Run from this skill directory with the project root directory explicitly set:

```bash
npm --prefix scripts/viewer run serve:ensure -- \
  --root-dir /path/to/root \
  --file path/to/model.step
```

Use only the URL printed by `serve:ensure`; do not assume a fixed port. By
default, `serve:ensure` starts probing at port `4178` and scans the configured
port range for a reusable server before binding a new port. It reuses a matching
root directory when possible, and otherwise starts the packaged production
server at the requested root directory. In sandboxed agent environments, local
binding/probing failures such as `EPERM` or `EACCES` can be expected; rerun the
same command with the needed permission/escalation instead of choosing an
arbitrary port or changing the root directory.

Pass exactly one `--file` per `serve:ensure` invocation. For multiple requested files, run the command once per file and return each printed URL.

## Links

- Return the printed Viewer link for each requested file.
- If a server is already running for the same root directory, reuse its port and vary the `?file=` query only when that points at the requested file.
- Do not stop an existing Viewer server unless the user asks.
- If Viewer startup fails, report the failure and continue with the owning skill's non-GUI validation or artifacts.

## References

- Read `references/development.md` when the user asks to modify, debug, or
  iterate on CAD Viewer source.
- Read `references/viewer-features.md` when you need supported file types, Viewer controls, or file-specific feature details.
- Read `references/moveit2-server.md` only when the user specifically needs optional SRDF MoveIt2 IK or path-planning controls.
