// Model catalog for the composer's switcher.
//
// `id` is the selection key: it's what gets persisted in AppSettings.model
// (via app_set_model) and mirrored in desktop/src-tauri/src/commands/app.rs.
// `value` is the underlying model the row runs — informational here, since the
// Rust driver resolves the persisted `id` to the real `--model` string (local
// ids map to themselves; both proxy tiers map to PROXY_MODEL_MINIMAX_M3).
//
// Free and Pro deliberately share one `value` (same model; quota is enforced by
// the backend per subscription). They stay distinct rows only because their
// `id`s differ — that's what lets the switcher remember which tier you picked.
// Opus stays first so it reads as the default.
export const MODEL_CHOICES = [
  { id: "opus", value: "opus", label: "Opus", requiresPandaSignIn: false },
  { id: "sonnet", value: "sonnet", label: "Sonnet", requiresPandaSignIn: false },
  { id: "vibe-free", value: "minimax,minimax/minimax-m3", label: "Free", requiresPandaSignIn: true },
  { id: "vibe-pro", value: "minimax,minimax/minimax-m3", label: "Pro", requiresPandaSignIn: true },
];

// Default selection when AppSettings.model is unset; matches the driver's
// `None → "opus"`. This is an `id`, like everything persisted.
export const DEFAULT_MODEL = MODEL_CHOICES[0].id;

export function availableModelChoices({ signedInToPanda = false } = {}) {
  return MODEL_CHOICES.filter(
    (choice) => !choice.requiresPandaSignIn || signedInToPanda,
  );
}

// Friendly label for a stored selection id. Falls back to the default's label
// for an unset or unrecognized id so a legacy/garbage setting still renders.
export function labelForModel(modelId) {
  const found = MODEL_CHOICES.find((choice) => choice.id === modelId);
  return (found ?? MODEL_CHOICES[0]).label;
}
