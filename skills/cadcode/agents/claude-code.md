# Claude Code overrides

These instructions apply when this skill runs inside Claude Code (the CLI
or the desktop subprocess). Other hosts (Cursor, Codex, etc.) should
follow the main ``SKILL.md`` only.

## You are running the loop

The loop in ``SKILL.md`` —

```
understand → inspect → plan → write → render → read failure → fix → repeat
```

— is the entire point of this skill. Close the loop yourself with the
tools Claude Code already gives you:

| Step in the loop | Claude Code tool |
|---|---|
| **understand** | the user's prompt + any attached reference image (`Read`) |
| **inspect** | `Glob` / `Bash ls` on the workspace, `Read` on prior `.py` files |
| **plan** | reasoning (no extended thinking needed if the prompt is concrete) |
| **write** | `Write` — always an absolute path |
| **render** | `Bash` → ``python ~/.claude/skills/cadcode/scripts/cad <abs.py>`` |
| **read failure** | `Read` the resulting `.png`; parse the JSON line from stdout |
| **fix** | `Edit` (or `Write`) — same `.py`, smallest change |
| **repeat** | back to *render* |

If you stop before the PNG looks right, you are leaving the loop
half-run. Don't.

## Thinking budget

Claude Code's default models (Opus 4.7, Sonnet 4.6) activate extended
thinking for any non-trivial prompt. For simple parts (cube, plate, hook
with named dimensions) thinking adds 10–30s with no quality benefit.

**When the prompt has explicit dimensions and a single feature**: tell
yourself in the first internal thought "no extended thinking needed,
write the .py directly." Generation latency drops by ~5×.

**When the prompt is ambiguous or multi-feature** (phone stand, doorbell
mount, anything assembling parts): extended thinking is worth its cost —
it reduces compile-fail iterations.

## File writes

Always pass an **absolute path** to the ``Write`` tool. Claude Code's cwd
inside this subprocess is the user's session workspace, not the skill
directory. If you ``Write("foo.py", ...)`` it lands in the session
workspace — that's correct — but downstream ``Bash`` calls into the
skill scripts must use absolute paths because they shell out and may
have different cwds.

## Reading the render

After running ``scripts/cad``, immediately ``Read`` the produced
``<stem>.png``. Claude Code's Read tool returns images as
multimodal content, so you'll actually see the rendered model. **This
read is mandatory** — compile-success says the geometry is *valid*; only
the PNG tells you it's *right*.

If the PNG looks correct, declare done. If it looks wrong, edit the
``.py`` and re-run — that's the loop. Do not skip the visual check.

## Tool budget

Hard limit: 6 model turns per user message (Claude Code's default).
Past that the user sees stalling. The soft cap of 4 iterations in
``SKILL.md`` keeps you safely under the hard limit.
