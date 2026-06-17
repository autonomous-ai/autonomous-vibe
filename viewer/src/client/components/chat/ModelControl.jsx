"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, Cpu, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/ui/utils";
import { transport } from "@/lib/transport.ts";
import { DEFAULT_MODEL, labelForModel, MODEL_CHOICES } from "./modelChoices.js";

/**
 * Compact pill in the chat composer footer showing which Claude model the next
 * turn will use, with a dropdown to switch between the offered models. The
 * choice is persisted in AppSettings (`app_set_model`); the driver reads it
 * fresh at each turn spawn, so a switch takes effect on the next turn — no need
 * to block switching mid-turn (unlike auth mode, which is global).
 */
export default function ModelControl({ className }) {
  // Active model value; null until the first settings read resolves. Falls back
  // to the default for display when unset/unrecognized.
  const [model, setModel] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const settings = await transport.app_settings_read();
      setModel(settings?.model ?? DEFAULT_MODEL);
    } catch {
      // Best-effort; keep prior state (or the default placeholder below).
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = model ?? DEFAULT_MODEL;

  const pick = useCallback(
    async (value) => {
      if (busy || value === active) return;
      setBusy(true);
      try {
        const next = await transport.app_set_model(value);
        setModel(next?.model ?? value);
      } catch {
        // Leave the prior selection in place on failure.
      } finally {
        setBusy(false);
      }
    },
    [busy, active],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-background/55 hover:text-foreground",
            className,
          )}
          data-testid="model-trigger"
          title="Model"
        >
          {busy ? (
            <Loader2 className="size-3 animate-spin" aria-hidden />
          ) : (
            <Cpu className="size-3" aria-hidden />
          )}
          {labelForModel(active)}
          <ChevronDown className="size-3 opacity-60" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-40">
        {MODEL_CHOICES.map((choice) => (
          <DropdownMenuItem
            key={choice.value}
            onSelect={() => void pick(choice.value)}
            data-testid={`model-option-${choice.value}`}
            className="justify-between gap-3"
          >
            {choice.label}
            {choice.value === active ? (
              <Check className="size-3.5" aria-hidden />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
