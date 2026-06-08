"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Cloud, Laptop, Loader2, ShieldAlert } from "lucide-react";
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
  buildPandaLoginFlow,
  describePandaLoginProgress,
} from "@/components/onboarding/onboardingHelpers.js";

/**
 * Compact badge in the chat header showing which Claude access the next turn
 * will use — the Panda proxy (`usePandaCloud`) or the user's own local Claude
 * Code — and a dropdown to switch between them without re-onboarding.
 *
 * Switching is a settings flip (`app_set_auth_mode`). Choosing Panda when no
 * token is stored yet runs the full browser sign-in (`app_panda_login`), which
 * persists the token and flips the mode on success.
 */
export default function AuthModeControl() {
  const [settings, setSettings] = useState(null);
  const [localAuthed, setLocalAuthed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pandaProgress, setPandaProgress] = useState(null);
  const flowRef = useRef(null);

  // Re-read settings + local auth. Cheap and idempotent — also runs each time
  // the dropdown opens so the badge reflects changes made elsewhere (e.g. Run
  // Setup Again).
  const refresh = useCallback(async () => {
    try {
      const [s, auth] = await Promise.all([
        transport.app_settings_read(),
        transport.app_auth_check().catch(() => ({ authenticated: false })),
      ]);
      setSettings(s);
      setLocalAuthed(Boolean(auth?.authenticated));
    } catch {
      // Best-effort; keep prior state.
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      if (flowRef.current) flowRef.current.cancel();
    };
  }, [refresh]);

  const usePanda = Boolean(settings?.usePandaCloud);
  const hasToken = Boolean(settings?.pandaToken);

  const switchTo = useCallback(
    async (panda) => {
      if (busy) return;
      setError("");

      // Enabling Panda without a stored token → run the browser sign-in first;
      // app_panda_login persists the token and flips use_panda_cloud on success.
      if (panda && !hasToken) {
        setBusy(true);
        setPandaProgress(null);
        await new Promise((resolve) => {
          const flow = buildPandaLoginFlow({
            runInstall: () => transport.app_panda_login(),
            subscribe: (handler) => transport.onPandaLoginProgress(handler),
            onChange: ({ progress }) => setPandaProgress(progress),
            onComplete: () => {},
          });
          flowRef.current = flow;
          void flow.start().then(() => {
            if (flow.state !== "done") {
              setError(describePandaLoginProgress(flow.progress));
            }
            resolve();
          });
        });
        await refresh();
        setBusy(false);
        setPandaProgress(null);
        return;
      }

      // Already-configured modes: a settings flip.
      setBusy(true);
      try {
        const next = await transport.app_set_auth_mode(panda);
        setSettings(next);
      } catch (err) {
        setError(
          err && typeof err === "object" && "message" in err
            ? String(err.message || "Failed to switch")
            : String(err || "Failed to switch"),
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, hasToken, refresh],
  );

  const label = usePanda ? "Panda" : "Your Claude";
  const dotClass = usePanda ? "bg-emerald-500" : "bg-sky-500";

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) void refresh();
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-full border border-border/60 px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50"
          data-testid="auth-mode-trigger"
          title="Claude access — click to switch"
        >
          {busy ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <span className={cn("size-2 rounded-full", dotClass)} aria-hidden />
          )}
          {label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Claude access for this chat</DropdownMenuLabel>
        <DropdownMenuItem
          disabled={busy}
          onSelect={(e) => {
            e.preventDefault();
            void switchTo(true);
          }}
          data-testid="auth-mode-panda"
        >
          <Cloud className="size-4" aria-hidden />
          <span className="flex flex-1 flex-col">
            <span>Panda{!usePanda && !hasToken ? " · sign in" : ""}</span>
            <span className="text-xs text-muted-foreground">
              Use Panda’s Claude — no subscription of your own
            </span>
          </span>
          {usePanda ? <Check className="size-4" aria-hidden /> : null}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={busy}
          onSelect={(e) => {
            e.preventDefault();
            void switchTo(false);
          }}
          data-testid="auth-mode-local"
        >
          <Laptop className="size-4" aria-hidden />
          <span className="flex flex-1 flex-col">
            <span>Your Claude Code</span>
            <span className="text-xs text-muted-foreground">
              {localAuthed
                ? "Your own local Claude auth"
                : "Heads up: not signed in locally"}
            </span>
          </span>
          {!usePanda ? <Check className="size-4" aria-hidden /> : null}
        </DropdownMenuItem>
        {pandaProgress ? (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1 text-xs text-muted-foreground">
              {describePandaLoginProgress(pandaProgress)}
            </div>
          </>
        ) : null}
        {error ? (
          <>
            <DropdownMenuSeparator />
            <div className="flex items-start gap-1.5 px-2 py-1 text-xs text-destructive">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
