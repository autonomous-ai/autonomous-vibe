// Model catalog for the composer's switcher. `value` is persisted in
// AppSettings.model and mirrored in desktop/src-tauri/src/commands/app.rs.
// Opus stays first so it reads as the default.
export const MODEL_CHOICES = [
  { value: "opus", label: "Opus", requiresPandaSignIn: false },
  { value: "sonnet", label: "Sonnet", requiresPandaSignIn: false },
  { value: "minimax,minimax/minimax-m3", label: "Pro - $20/month", requiresPandaSignIn: true },
];

// Default when AppSettings.model is unset; matches the driver's `None → "opus"`.
export const DEFAULT_MODEL = MODEL_CHOICES[0].value;

export function availableModelChoices({ signedInToPanda = false } = {}) {
  return MODEL_CHOICES.filter(
    (choice) => !choice.requiresPandaSignIn || signedInToPanda,
  );
}

// Friendly label for a stored model value. Falls back to the default's label for
// an unset or unrecognized value so a legacy/garbage setting still renders.
export function labelForModel(model) {
  const found = MODEL_CHOICES.find((choice) => choice.value === model);
  return (found ?? MODEL_CHOICES[0]).label;
}
