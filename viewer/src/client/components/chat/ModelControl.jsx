"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, Cpu, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/ui/utils";
import { transport } from "@/lib/transport.ts";
import {
  DEFAULT_MODEL,
  labelForModel,
  MODEL_CHOICES,
} from "./modelChoices.js";

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
  const [signedInToPanda, setSignedInToPanda] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [settingsRes, socialRes] = await Promise.allSettled([
      transport.app_settings_read(),
      transport.social_has_token(),
    ]);

    if (settingsRes.status === "fulfilled") {
      setModel(settingsRes.value?.model ?? DEFAULT_MODEL);
    }
    if (socialRes.status === "fulfilled") {
      setSignedInToPanda(Boolean(socialRes.value));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep proxy-model availability in sync if sign-in completes while the
  // composer is already mounted.
  useEffect(() => {
    let off = null;
    (async () => {
      try {
        off = await transport.onSocialLoginProgress((event) => {
          if (event?.stage === "done") {
            void refresh();
          }
        });
      } catch {
        // Best-effort only.
      }
    })();
    return () => {
      if (typeof off === "function") {
        off();
      }
    };
  }, [refresh]);

  const localChoices = MODEL_CHOICES.filter((choice) => !choice.requiresPandaSignIn);
  const proxyChoices = MODEL_CHOICES.filter((choice) => choice.requiresPandaSignIn);
  const selectableChoices = signedInToPanda
    ? MODEL_CHOICES
    : localChoices;

  const active = selectableChoices.some((choice) => choice.value === model)
    ? model
    : DEFAULT_MODEL;

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
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          void refresh();
        }
      }}
    >
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
      <DropdownMenuContent align="start" className="cad-solid-popover min-w-40">
        <DropdownMenuLabel className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Local Claude
        </DropdownMenuLabel>
        {localChoices.map((choice) => (
          <DropdownMenuItem
            key={choice.value}
            onSelect={() => void pick(choice.value)}
            data-testid={`model-option-${choice.value}`}
            className="justify-between gap-3"
          >
            <span>{choice.label}</span>
            {choice.value === active ? <Check className="size-3.5" aria-hidden /> : null}
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Subscription
        </DropdownMenuLabel>
        {proxyChoices.map((choice) => (
          <DropdownMenuItem
            key={choice.value}
            onSelect={() => {
              if (signedInToPanda) {
                void pick(choice.value);
              }
            }}
            disabled={!signedInToPanda}
            data-testid={
              signedInToPanda
                ? `model-option-${choice.value}`
                : `model-option-${choice.value}-locked`
            }
            className="justify-between gap-3 data-[disabled]:opacity-100 data-[disabled]:bg-background data-[disabled]:text-muted-foreground"
          >
            <span>{choice.label}</span>
            {signedInToPanda && choice.value === active ? (
              <Check className="size-3.5" aria-hidden />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
