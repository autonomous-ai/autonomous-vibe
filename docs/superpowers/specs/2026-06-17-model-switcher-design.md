# Model switcher in the chat composer

**Date:** 2026-06-17
**Status:** Approved design, pending spec review

## Problem

The Claude model passed to the `claude` CLI is hardcoded in the chat driver
([claude_driver.rs:1342-1343](../../../desktop/src-tauri/src/commands/claude_driver.rs#L1342)):

```rust
// model: Some("opus".into()),
model: Some("kimi,moonshotai/kimi-k2.6".into()),   // hoặc minimax,minimax/minimax-m3
```

There is no way to switch models without editing source and recompiling. We want
a UI control in the chat composer to switch between three models, with the
choice persisted across restarts.

## Goals

- A small chooser pill in the chat composer footer to switch the active model.
- Persist the choice in `AppSettings` so it survives restarts.
- A fixed list of three models with friendly labels.
- No behavior change for a fresh install (default stays `opus`).

## Non-goals (YAGNI)

- Custom / free-text model entry.
- Per-project or per-turn model overrides distinct from the persisted default.
- Exposing the model choice in the settings/onboarding panels (composer only).

## Models

Fixed list. The stored value is the exact string passed to `claude --model`.

| Label       | `--model` value               |
| ----------- | ----------------------------- |
| Opus        | `opus`                        |
| Kimi K2.6   | `kimi,moonshotai/kimi-k2.6`   |
| MiniMax M3  | `minimax,minimax/minimax-m3`  |

These three values are the single source of truth, defined once on the Rust side
(for `app_set_model` validation) and mirrored once on the JS side (for the
chooser). `opus` is the default.

## Architecture

Mirrors the existing auth-mode control end-to-end:

- Persisted field on `AppSettings` (like `use_panda_cloud`).
- A dedicated setter command returning the updated settings (like
  `app_set_auth_mode`).
- A composer pill that reads settings, shows the active choice, and calls the
  setter on pick (like `AuthModeControl`).

The model is read fresh from settings at each turn spawn, so a switch takes
effect on the **next** turn. Because it is per-turn (not global mutable state
shared with a running turn), switching mid-turn is harmless and is **not**
blocked — unlike auth mode, which is global and gated while a turn runs.

### Backend (Rust)

1. **`AppSettings`** ([ipc/types.rs](../../../desktop/src-tauri/src/ipc/types.rs#L792)):
   add

   ```rust
   /// Selected Claude model passed to `claude --model`. `None` means use the
   /// built-in default (`opus`). One of the three values from `MODEL_CHOICES`.
   #[serde(default)]
   pub model: Option<String>,
   ```

   Default to `None` in the `Default` impl. `None` (absent in legacy settings
   files) means "built-in default", so no migration is needed.

2. **Allowed-models constant** ([commands/app.rs](../../../desktop/src-tauri/src/commands/app.rs)):
   a `const MODEL_CHOICES: [&str; 3]` holding the three `--model` values, used to
   validate `app_set_model` input.

3. **`app_set_model` command** (next to `app_set_auth_mode` in `app.rs`):

   ```rust
   #[tauri::command]
   pub async fn app_set_model(model: String) -> IpcResult<AppSettings> {
       if !MODEL_CHOICES.contains(&model.as_str()) {
           return Err(IpcError::new("INVALID_MODEL", format!("Unknown model: {model}")));
       }
       let mut settings = load_settings().await.unwrap_or_default();
       settings.model = Some(model);
       app_settings_write(settings.clone()).await?;
       Ok(settings)
   }
   ```

   Register it in [lib.rs](../../../desktop/src-tauri/src/lib.rs) alongside the
   other `app_*` commands.

4. **Driver** ([claude_driver.rs:1342-1343](../../../desktop/src-tauri/src/commands/claude_driver.rs#L1342)):
   replace the hardcoded line with

   ```rust
   model: settings.as_ref().and_then(|s| s.model.clone()),
   ```

   Read it from `settings` before the value is consumed for `panda_token`
   (currently `settings.and_then(...)` at line 1336 moves `settings`; reorder so
   `model` is captured first). `build_command` already defaults `None → "opus"`
   ([claude_driver.rs:420-421](../../../desktop/src-tauri/src/commands/claude_driver.rs#L420)),
   so a fresh install is unchanged. Delete the obsolete comments.

### Frontend (React)

5. **`transport.ts`** ([viewer/src/client/lib/transport.ts](../../../viewer/src/client/lib/transport.ts)):
   - Add `model?: string` to the `AppSettings` TS type.
   - Add the dev-HTTP router case for `app_set_model` (mirroring
     `app_set_auth_mode` at line 771).
   - Add the helper:
     ```ts
     app_set_model: (model: string) =>
       invoke<AppSettings>("app_set_model", { model }),
     ```

6. **`ModelControl.jsx`** (new, in `viewer/src/client/components/chat/`):
   modeled on `AuthModeControl`. Reads `app_settings_read()` on mount, derives
   the active label from `settings.model` (falling back to "Opus" when unset or
   unrecognized), renders a pill showing the active label, and opens a chooser
   listing the three models. On pick, calls `transport.app_set_model(value)` and
   updates local state from the returned settings. Uses the existing
   `dropdown-menu` UI component for the chooser. The three label/value pairs live
   in a module-level constant in this file (the JS mirror of `MODEL_CHOICES`).

7. **Placement** — render `<ModelControl />` in the **ChatInput composer footer**,
   in the left button group next to the `+` attach button
   ([ChatInput.jsx:286-312](../../../viewer/src/client/components/chat/ChatInput.jsx#L286)).

## Edge cases

- **Legacy/unknown `model` value:** the chooser shows "Opus" as active but does
  not overwrite settings until the user explicitly picks. `app_set_model`
  rejects unknown values, so settings can never be written to an invalid model
  through the UI.
- **Fresh install:** `model` is `None` → driver passes `opus` → unchanged.
- **Mid-turn switch:** allowed; takes effect next turn. Pill stays enabled.

## Testing

- **Rust:** `app_set_model` rejects an unknown value (returns `INVALID_MODEL`)
  and accepts each of the three; the existing `--model` `build_command` test
  ([claude_driver.rs:2917](../../../desktop/src-tauri/src/commands/claude_driver.rs#L2917))
  confirms the settings model reaches the `--model` flag.
- **JS:** a transport test for `app_set_model` routing, mirroring the existing
  `app_set_auth_mode` coverage.

## Contract impact

`docs/panda-interfaces.md` lists the Tauri IPC commands. Add `app_set_model` to
the command list there (the contract doc is frozen for v1, but the IPC schema
section is the source-of-truth mirror that must stay in sync; this is an
additive command).
