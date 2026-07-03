---
name: dev-loop
description: Use when the user asks to develop, build, implement, or add a new FEATURE end-to-end in the Panda desktop app and wants it taken all the way to a pull request. Triggers on "build/add/implement a feature", "ship this", "take it to a PR" for multi-step work touching the viewer / cadpy / cadjs / tauri / skills layers. NOT for one-line fixes, bug triage, questions, or edits with no PR.
---

# Dev-Loop: feature request → ready-to-review PR

## Overview

One autonomous engineering loop that carries a feature from a natural-language request to an opened pull request. It **conducts existing skills** — it does not reimplement them. The value is the *sequence* and the *gates*: two adversarial self-review loops that run until they come back empty, mandatory build-run-observe verification, and exactly **one human gate** (PR approval) plus **one conditional pause** (a load-bearing ambiguity).

**Announce at start:** "I'm using the dev-loop skill to take this feature to a PR."

**Core principle:** autonomous in the middle, disciplined at the edges. The loop runs itself, but it may not (a) declare anything working without observed evidence, (b) call review "done" after one pass, or (c) open the PR without the user's approval.

## When to use / not

- **Use when:** the request is a *feature* to be developed and shipped as a PR in this repo.
- **Do NOT use for:** one-line fixes, answering questions, pure exploration, or changes the user does not want turned into a PR. Those skip the loop — just do the work.

## The loop

| # | Phase | Do | Hands off to |
|---|-------|----|-------------|
| 0 | **Intake & isolate** | Slug the feature. Map which layer(s) it touches. Clean tree → `feat/<slug>` branch in place; dirty/conflicting tree → dedicated worktree. | `superpowers:using-git-worktrees` (only if worktree needed) |
| 1 | **Understand** | Fan out read-only `Explore` subagents over the touched subsystem. Read `docs/panda-interfaces.md` **only if the change crosses layers**. Note every source-of-truth ↔ generated-mirror boundary in scope. | `Explore` agents |
| 2 | **Plan** | Weigh 2-3 approaches, pick one, **write down the assumptions**. Blocking ambiguity → pause once (see Gate A). Write the plan. | `superpowers:brainstorming` (self-driven), `superpowers:writing-plans` |
| 3 | **Vet the plan (loop)** | Dispatch an adversarial critic against the plan; fix; **re-dispatch until it returns nothing material**. | `superpowers:requesting-code-review` |
| 4 | **Implement** | TDD where it fits. Edit **source-of-truth** packages, then regenerate mirrors. Commit incrementally. | `superpowers:test-driven-development` |
| 5 | **Verify (loop)** | Run only the gates for touched layers. Then build + run + **observe a screenshot**. Failure → debug → fix → re-verify (see Gate B). | `running-panda`, `superpowers:systematic-debugging`, `superpowers:verification-before-completion` |
| 6 | **Vet the code (loop)** | Adversarial code review; fix findings; **re-review until empty**. | `superpowers:requesting-code-review` |
| 7 | **PR gate** ⏸ | Summarize; get the user's approval (Gate C); only then push and open the PR. | `superpowers:finishing-a-development-branch` |

Loops 3, 5, and 6 are the "review until self-satisfied" the loop is built around — a single pass is never enough.

## Panda guardrails (bake into every phase)

- **Never hand-edit a generated mirror.** `viewer/packages/cadjs/` and vendored `packages/cadpy/` under `skills/*/` are generated. Edit the source-of-truth `packages/cadjs/` or `packages/cadpy/`, then regenerate: `scripts/build/build-viewer-packages.sh` / `scripts/build/build-skill-runtimes.sh`.
- **`docs/panda-interfaces.md` is frozen for v1.** Read before any cross-layer change; do not change the contract to fit an implementation.
- **Scope the gates** (AGENTS.md: run only what the change touches):
  - cadpy: `cd packages/cadpy && python -m pytest`
  - viewer: `npm --prefix viewer test && npm --prefix viewer run build`
  - tauri: `cargo --manifest-path desktop/src-tauri/Cargo.toml test`
- **Respect the CLAUDE.md footguns** — bundle-freshness, launch-PATH, session-dir encoding, dev-server port. Don't reintroduce them.
- **Out of scope for v1:** URDF/SRDF/SDF, SendCutSend, non-Bambu printers. Don't add features there.

## The three gates (do not negotiate)

### Gate A — Ambiguity (conditional pause)
Minor ambiguity → pick the sensible default, **record it in the plan**, continue. Only a *load-bearing* ambiguity (guessing wrong would waste the whole implementation) earns a pause: ask **one** batched `AskUserQuestion`, then continue. Do not turn the autonomous loop into a Q&A.

### Gate B — Verify with observed evidence
"Works" requires **evidence you actually looked at**, per `superpowers:verification-before-completion`:
1. Run the scoped gates and read the real output.
2. Build + run the app via `running-panda` (`.claude/skills/running-panda/launch.sh` — detached; **not** `scripts/dev.sh`, which dies when this task ends).
3. **Capture and Read a screenshot of the window.** The window is often on a second display — if the grab looks blank, check window position (`osascript … get position of window 1`) and capture that region, don't declare failure.
4. Drive a chat turn **only if** the change touches the chat/CAD pipeline.
Never write "tests pass" / "the app works" from commands you did not run or output you did not read.

### Gate C — PR approval (the one human gate)
Before pushing or opening the PR, **STOP and present** to the user:
- what changed and why,
- assumptions made (from Gate A),
- gates run **with their actual output**,
- the verification screenshot.
Open the PR (`superpowers:finishing-a-development-branch` → `gh pr create`) **only after the user approves.** The loop being "autonomous" ends at the PR — pushing to a remote and opening a PR is outward-facing and is the user's call.

**PR body recipe** (fill each slot, in order): *What & why* · *How (which existing pieces were reused)* · *Layers touched + whether mirrors were regenerated* · *Assumptions* · *Tests run, with results* · *Verification (screenshot)* · *Follow-ups*. End with the `gh` PR trailer required by the repo.

## Red flags — STOP, you are cutting a gate

- "The unit tests pass, so it works" → Gate B needs the app built, run, and a screenshot you looked at.
- "I'll use `scripts/dev.sh` to check it" → it dies with this task; use `running-panda`'s detached launch.
- "Code review came back clean on the first pass" → loops 3/6 run *until* empty; one pass is a red flag, not a finish.
- "I'll just open the PR, it's obviously fine" → Gate C is mandatory; the user opens the PR, not you.
- "I'll edit the mirror directly, it's faster" → mirrors are generated; edit source + regenerate.
- "The request is a bit vague but I'll figure it out as I code" → decide Gate A *now*: default+document, or one question if load-bearing.

## Rationalizations answered

| Excuse | Reality |
|--------|---------|
| "Autonomous means I open the PR too" | Autonomous means the *middle* runs unattended. Push/PR is outward-facing — Gate C. |
| "The screenshot is optional confirmation" | It is the confirmation. No observed screenshot = not verified. |
| "One review pass is self-satisfied" | Self-satisfied = the critic returns nothing material. Re-run until then. |
| "Only viewer changed, skip the app run" | Scoped *gates*, yes — but Gate B (build+run+screenshot) still applies to any UI-visible change. |
| "I edited the viewer mirror, tests are green" | Green now, stale on the next mirror regen. Edit source-of-truth. |
| "Reporting the plan is enough at the PR gate" | Report the *evidence* — real gate output + screenshot — not intentions. |
