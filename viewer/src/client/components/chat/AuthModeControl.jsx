"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Cloud, Laptop, Loader2, ShieldAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/ui/utils";
import { transport } from "@/lib/transport.ts";
import {
  buildPandaLoginFlow,
  describePandaLoginProgress,
} from "@/components/onboarding/onboardingHelpers.js";

// Secret developer gesture: this many clicks on the badge within
// DEV_GESTURE_WINDOW_MS opens the access chooser. v1 forces every user onto the
// Panda proxy, so there is no normal-user switch UI — the chooser is the only
// way to reach local Claude Code, kept deliberately undiscoverable.
const DEV_GESTURE_CLICKS = 5;
const DEV_GESTURE_WINDOW_MS = 1500;

/**
 * Compact badge in the chat header showing which Claude access the next turn
 * will use. v1 forces the Panda proxy, so a normal click does nothing visible —
 * there is no user-facing switch. A developer backdoor remains: clicking the
 * badge {@link DEV_GESTURE_CLICKS} times in quick succession opens a hidden
 * dialog that toggles between the Panda proxy and the user's own local Claude
 * Code (`app_set_auth_mode`). Choosing Panda with no stored token runs the full
 * browser sign-in (`app_panda_login`) first.
 */
export default function AuthModeControl() {
  const [settings, setSettings] = useState(null);
  const [localAuthed, setLocalAuthed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pandaProgress, setPandaProgress] = useState(null);
  const [devOpen, setDevOpen] = useState(false);
  const flowRef = useRef(null);

  // Click-gesture bookkeeping. A ref (not state) so counting never re-renders
  // the badge; the window timer resets the count if the clicks aren't quick.
  const clickCountRef = useRef(0);
  const clickTimerRef = useRef(0);

  // Re-read settings + local auth. Cheap and idempotent — runs each time the
  // dev dialog opens so the badge reflects changes made elsewhere.
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
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
      if (flowRef.current) flowRef.current.cancel();
    };
  }, [refresh]);

  const usePanda = Boolean(settings?.usePandaCloud);
  const hasToken = Boolean(settings?.pandaToken);

  // Count badge clicks; open the dev chooser once the threshold is hit inside
  // the window. Any pause longer than DEV_GESTURE_WINDOW_MS resets the count.
  const handleBadgeClick = useCallback(() => {
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    clickCountRef.current += 1;
    if (clickCountRef.current >= DEV_GESTURE_CLICKS) {
      clickCountRef.current = 0;
      setError("");
      setPandaProgress(null);
      void refresh();
      setDevOpen(true);
      return;
    }
    clickTimerRef.current = setTimeout(() => {
      clickCountRef.current = 0;
    }, DEV_GESTURE_WINDOW_MS);
  }, [refresh]);

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
    <>
      <button
        type="button"
        onClick={handleBadgeClick}
        className="inline-flex items-center gap-1.5 rounded-full border border-border/60 px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50"
        data-testid="auth-mode-trigger"
        title="Claude access"
      >
        {busy ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <span className={cn("size-2 rounded-full", dotClass)} aria-hidden />
        )}
        {label}
      </button>

      <Dialog open={devOpen} onOpenChange={setDevOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Developer · Claude access</DialogTitle>
            <DialogDescription>
              Panda normally handles Claude for everyone. This developer-only
              switch routes chat through the Panda proxy or your own local
              Claude Code.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void switchTo(true)}
              data-testid="auth-mode-panda"
              className="flex items-start gap-2 rounded-md border border-border p-3 text-left transition-colors hover:bg-muted/50 disabled:opacity-50"
            >
              <Cloud className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="flex flex-1 flex-col">
                <span className="text-sm font-medium">
                  Panda{!usePanda && !hasToken ? " · sign in" : ""}
                </span>
                <span className="text-xs text-muted-foreground">
                  Use Panda’s Claude — no subscription of your own
                </span>
              </span>
              {usePanda ? <Check className="mt-0.5 size-4" aria-hidden /> : null}
            </button>

            <button
              type="button"
              disabled={busy}
              onClick={() => void switchTo(false)}
              data-testid="auth-mode-local"
              className="flex items-start gap-2 rounded-md border border-border p-3 text-left transition-colors hover:bg-muted/50 disabled:opacity-50"
            >
              <Laptop className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="flex flex-1 flex-col">
                <span className="text-sm font-medium">Your Claude Code</span>
                <span className="text-xs text-muted-foreground">
                  {localAuthed
                    ? "Your own local Claude auth"
                    : "Heads up: not signed in locally"}
                </span>
              </span>
              {!usePanda ? (
                <Check className="mt-0.5 size-4" aria-hidden />
              ) : null}
            </button>
          </div>

          {pandaProgress ? (
            <div className="text-xs text-muted-foreground">
              {describePandaLoginProgress(pandaProgress)}
            </div>
          ) : null}
          {error ? (
            <div className="flex items-start gap-1.5 text-xs text-destructive">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
