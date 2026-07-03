// The Claude models the composer's switcher offers. `value` is the exact string
// passed to `claude --model` (the `provider,model` router forms route through
// the Panda proxy). Mirrors `MODEL_CHOICES` in
// desktop/src-tauri/src/commands/app.rs — keep the two in sync. Opus is first so
// it reads as the default.
export const MODEL_CHOICES = [
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "kimi,moonshotai/kimi-k2.6", label: "Kimi K2.6" },
  { value: "minimax,minimax/minimax-m3", label: "MiniMax M3" },
];

// Default when AppSettings.model is unset; matches the driver's `None → "opus"`.
export const DEFAULT_MODEL = MODEL_CHOICES[0].value;

// Friendly label for a stored model value. Falls back to the default's label for
// an unset or unrecognized value so a legacy/garbage setting still renders.
export function labelForModel(model) {
  const found = MODEL_CHOICES.find((choice) => choice.value === model);
  return (found ?? MODEL_CHOICES[0]).label;
}
