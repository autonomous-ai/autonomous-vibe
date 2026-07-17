"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, Cpu, ExternalLink, Loader2 } from "lucide-react";
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

// A subscription counts as "paid" (so we drop the Upgrade CTA) only when the
// plan is Pro/Studio *and* the subscription is in an active-ish state. Anything
// else — Free, canceled, past-due, or no subscription — still sees "Upgrade to
// Pro".
const PAID_PLANS = new Set(["pro", "studio"]);
const ACTIVE_PLAN_STATUSES = new Set(["active", "trialing"]);

function hasActivePaidPlan(profile) {
  if (!profile) return false;
  const plan = String(profile.plan ?? "").toLowerCase();
  const status = String(profile.planStatus ?? "").toLowerCase();
  return PAID_PLANS.has(plan) && ACTIVE_PLAN_STATUSES.has(status);
}

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
  // Whether the account is on an active paid (Pro/Studio) plan. Drives whether
  // the "Upgrade to Pro" CTA shows — Free accounts (and signed-out users) see it.
  const [paidPlan, setPaidPlan] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [settingsRes, socialRes] = await Promise.allSettled([
      transport.app_settings_read(),
      transport.social_has_token(),
    ]);

    if (settingsRes.status === "fulfilled") {
      setModel(settingsRes.value?.model ?? DEFAULT_MODEL);
    }

    const signedIn =
      socialRes.status === "fulfilled" && Boolean(socialRes.value);
    setSignedInToPanda(signedIn);

    // Only signed-in accounts carry a subscription; resolve the plan to decide
    // whether to keep offering the upgrade.
    if (!signedIn) {
      setPaidPlan(false);
      return;
    }
    try {
      const profile = await transport.social_profile();
      setPaidPlan(hasActivePaidPlan(profile));
    } catch {
      setPaidPlan(false);
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
  // Show the Pro row only for accounts already on an active paid plan; Free
  // accounts see the "Upgrade to Pro" CTA in its place instead.
  const proxyChoices = MODEL_CHOICES.filter(
    (choice) =>
      choice.requiresPandaSignIn && (choice.id !== "vibe-pro" || paidPlan),
  );
  const selectableChoices = signedInToPanda
    ? MODEL_CHOICES
    : localChoices;

  // `model` is the persisted selection id. Free and Pro share a model but have
  // distinct ids, so keying off id keeps them independently selectable.
  const active = selectableChoices.some((choice) => choice.id === model)
    ? model
    : DEFAULT_MODEL;

  const pick = useCallback(
    async (id) => {
      if (busy || id === active) return;
      setBusy(true);
      try {
        const next = await transport.app_set_model(id);
        setModel(next?.model ?? id);
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
          Bring your own model
        </DropdownMenuLabel>
        {localChoices.map((choice) => (
          <DropdownMenuItem
            key={choice.id}
            onSelect={() => void pick(choice.id)}
            data-testid={`model-option-${choice.id}`}
            className="justify-between gap-3"
          >
            <span>{choice.label}</span>
            {choice.id === active ? <Check className="size-3.5" aria-hidden /> : null}
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Vibe Subscription
        </DropdownMenuLabel>
        {proxyChoices.map((choice) => (
          <DropdownMenuItem
            key={choice.id}
            onSelect={() => {
              if (signedInToPanda) {
                void pick(choice.id);
              } else {
                // Not subscribed: send them to the hosted plans page in the
                // system browser (the desktop app has no in-app checkout).
                void transport.social_open_pricing();
              }
            }}
            data-testid={
              signedInToPanda
                ? `model-option-${choice.id}`
                : `model-option-${choice.id}-locked`
            }
            className="justify-between gap-3"
          >
            <span>{choice.label}</span>
            {signedInToPanda && choice.id === active ? (
              <Check className="size-3.5" aria-hidden />
            ) : null}
          </DropdownMenuItem>
        ))}
        {paidPlan ? null : (
          <DropdownMenuItem
            onSelect={() => void transport.social_open_pricing()}
            data-testid="model-upgrade-pro"
            className="justify-center"
          >
            <span className="inline-flex items-center gap-1 rounded-full border border-orange-500/60 px-2 py-0.5 text-xs font-medium text-orange-500">
              Upgrade to Pro
              <ExternalLink className="size-3" aria-hidden />
            </span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
