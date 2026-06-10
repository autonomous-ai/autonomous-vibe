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

/**
 * Compact badge in the chat header showing which Claude access the next turn
 * will use. Panda's hosted proxy is the default and stays front-and-centre; the
 * badge is deliberately understated so it reads as a status pill, not a primary
 * control. Clicking it opens a small chooser that toggles between the Panda
 * proxy and the user's own local Claude Code (`app_set_auth_mode`) — subtle
 * enough that casual users ignore it, but plainly discoverable by anyone who
 * knows Claude Code and goes looking. Choosing Panda with no stored token runs
 * the full browser sign-in (`app_panda_login`) first.
 */
export default function AuthModeControl() {
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pandaProgress, setPandaProgress] = useState(null);
  const [open, setOpen] = useState(false);
  const flowRef = useRef(null);
  // Set when the user cancels an in-flight sign-in so the resolving flow returns
  // quietly instead of flashing an error.
  const cancelledRef = useRef(false);

  // Re-read settings + local auth. Cheap and idempotent — runs each time the
  // chooser opens so the badge reflects changes made elsewhere.
  const refresh = useCallback(async () => {
    try {
      setSettings(await transport.app_settings_read());
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

  // Open the chooser on a plain click; re-read first so it reflects the latest
  // mode/auth.
  const handleBadgeClick = useCallback(() => {
    setError("");
    setPandaProgress(null);
    void refresh();
    setOpen(true);
  }, [refresh]);

  const switchTo = useCallback(
    async (panda) => {
      if (busy) return;
      setError("");

      // Enabling Panda without a stored token → run the browser sign-in first;
      // app_panda_login persists the token and flips use_panda_cloud on success.
      if (panda && !hasToken) {
        cancelledRef.current = false;
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
            // Stay quiet when the user cancelled — no error flash for a
            // deliberate abort.
            if (!cancelledRef.current && flow.state !== "done") {
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

  // Sign out of the Panda proxy entirely: clears the stored token and reverts
  // to local Claude. Distinct from switchTo(false), which only flips the mode
  // but keeps the token for a later one-click switch back.
  const signOutPanda = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await transport.app_panda_logout();
      setSettings(next);
    } catch (err) {
      setError(
        err && typeof err === "object" && "message" in err
          ? String(err.message || "Failed to sign out")
          : String(err || "Failed to sign out"),
      );
    } finally {
      setBusy(false);
    }
  }, [busy]);

  // Abort an in-flight "Panda · sign in": stop the local flow and tell Rust to
  // drop the pending login (so app_panda_login returns instead of waiting out
  // the 10-min deep-link timeout). cancelledRef suppresses the error flash.
  const cancelPandaSignIn = useCallback(() => {
    cancelledRef.current = true;
    if (flowRef.current) flowRef.current.cancel();
    void transport.app_cancel_panda_login().catch(() => {});
    setPandaProgress(null);
    setError("");
    setBusy(false);
  }, []);

  const label = usePanda ? "Panda" : "Your Claude";
  const dotClass = usePanda ? "bg-emerald-500" : "bg-sky-500";

  return (
    <>
      <button
        type="button"
        onClick={handleBadgeClick}
        className="inline-flex items-center gap-1.5 rounded-full border border-border/60 px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50"
        data-testid="auth-mode-trigger"
        title="AI access"
      >
        {busy ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <span className={cn("size-2 rounded-full", dotClass)} aria-hidden />
        )}
        {label}
      </button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          // Closing mid-sign-in (X, backdrop, or Esc) must abort the request,
          // not leave it pending behind a dismissed dialog.
          if (!next && busy) cancelPandaSignIn();
          setOpen(next);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>AI access</DialogTitle>
            <DialogDescription>
              Panda’s built-in AI needs no setup of your own. Already have Claude
              Code? You can connect your own instead.
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
                  Use Panda’s built-in AI — no subscription of your own
                </span>
              </span>
              {usePanda ? <Check className="mt-0.5 size-4" aria-hidden /> : null}
            </button>

            {/* Bring-your-own stays a quiet line, not a second card, so Panda
                reads as the default and only Claude Code users go looking. */}
            <button
              type="button"
              disabled={busy}
              onClick={() => void switchTo(false)}
              data-testid="auth-mode-local"
              className="inline-flex items-center gap-1.5 self-start text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline disabled:opacity-50"
            >
              <Laptop className="size-3.5 shrink-0" aria-hidden />
              {usePanda
                ? "Use your own Claude Code instead"
                : "Using your own Claude Code"}
              {!usePanda ? <Check className="size-3.5" aria-hidden /> : null}
            </button>
          </div>

          {hasToken ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void signOutPanda()}
              data-testid="auth-mode-panda-logout"
              className="self-start text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
            >
              Sign out of Panda
            </button>
          ) : null}

          {pandaProgress ? (
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
                {describePandaLoginProgress(pandaProgress)}
              </span>
              {busy ? (
                <button
                  type="button"
                  onClick={cancelPandaSignIn}
                  data-testid="auth-mode-cancel"
                  className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline"
                >
                  Cancel
                </button>
              ) : null}
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
