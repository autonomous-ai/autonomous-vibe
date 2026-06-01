"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { transport } from "@/lib/transport.ts";
import { cn } from "@/ui/utils";
import { FILAMENT_CHOICES } from "./onboardingHelpers.js";

export default function FilamentStep({ onAdvance, currentSettings }) {
  const [selected, setSelected] = useState(currentSettings?.defaultFilament || "PLA");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const existing = currentSettings || (await transport.app_settings_read());
      const nextSettings = {
        defaultFilament: selected,
        slicerBinaryPath: existing?.slicerBinaryPath ?? "",
        usePandaCloud: existing?.usePandaCloud ?? false,
        pandaToken: existing?.pandaToken,
        hasOnboarded: existing?.hasOnboarded ?? false,
      };
      await transport.app_settings_write(nextSettings);
      onAdvance?.(nextSettings);
    } catch (err) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String(err.message || "Failed to save filament choice")
          : String(err || "Failed to save filament choice");
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold">Pick your default filament</h2>
        <p className="text-sm text-muted-foreground">
          Panda will assume your printer is loaded with this filament when
          slicing. You can change it any time before a print.
        </p>
      </header>
      <div role="radiogroup" aria-label="Default filament" className="grid gap-2">
        {FILAMENT_CHOICES.map((choice) => {
          const active = selected === choice.value;
          return (
            <button
              key={choice.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setSelected(choice.value)}
              className={cn(
                "flex items-start gap-3 rounded-md border border-border p-3 text-left transition-colors",
                active
                  ? "border-primary bg-primary/5"
                  : "hover:border-primary/60 hover:bg-muted/40",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border",
                  active ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
                )}
                aria-hidden="true"
              >
                {active ? <Check className="size-3" /> : null}
              </span>
              <span className="flex flex-1 flex-col">
                <span className="font-medium">{choice.label}</span>
                <span className="text-xs text-muted-foreground">{choice.helper}</span>
              </span>
            </button>
          );
        })}
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save and continue"}
        </Button>
      </div>
    </section>
  );
}
