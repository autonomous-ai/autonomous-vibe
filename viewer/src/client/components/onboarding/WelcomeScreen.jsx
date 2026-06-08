"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  Sparkles,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { transport } from "@/lib/transport.ts";
import {
  buildClaudeInstallFlow,
  buildPandaLoginFlow,
  buildOnboardedSettings,
  CLAUDE_CHECK_POLL_INTERVAL_MS,
  describeClaudeInstallProgress,
  describePandaLoginProgress,
  evaluateWelcomeState,
  PANDA_SETUP_URL,
} from "./onboardingHelpers.js";

/**
 * Single-screen onboarding. Auto-detects the local `claude` CLI + its auth
 * state, then offers three ways to connect Claude:
 *
 *  1. Sign in with Panda — proxy login to Panda's hosted Claude server. The
 *     `claude` binary is still the runtime, so a missing CLI is installed first;
 *     then `app_panda_login` issues a token and we complete with
 *     `usePandaCloud: true`.
 *  2. Use my own Claude Code — bring-your-own auth. Enabled only when the CLI is
 *     detected AND already authenticated (otherwise a chat turn would dead-end).
 *  3. Set up your own Claude — a help link for BYO users who aren't ready.
 *
 * Everything else (slicer / printer / filament) moved out of onboarding into the
 * in-app "Add Printer" flow.
 */
export default function WelcomeScreen({ onComplete }) {
  const [checking, setChecking] = useState(true);
  const [welcome, setWelcome] = useState(null);
  const [checkError, setCheckError] = useState("");
  // Panda path: "idle" | "installing" | "signing_in" | "error". The terminal
  // success path completes onboarding rather than parking in a "done" state.
  const [pandaState, setPandaState] = useState("idle");
  const [pandaProgress, setPandaProgress] = useState(null);
  const [pandaError, setPandaError] = useState("");
  const [finishing, setFinishing] = useState(false);

  const welcomeRef = useRef(null);
  const activeFlowRef = useRef(null);
  const pollTimerRef = useRef(0);
  // Mirror pandaState into a ref so the poll loop can read the latest value
  // without taking it as an effect dependency (which would re-subscribe the
  // timer — and cancel the in-flight flow — on every transition).
  const pandaStateRef = useRef("idle");
  useEffect(() => {
    pandaStateRef.current = pandaState;
  }, [pandaState]);

  const busy =
    finishing || pandaState === "installing" || pandaState === "signing_in";

  // Re-run detection. Read-only and idempotent, so it doubles as the poll tick:
  // a user who installs Claude or signs in out-of-band sees the screen update
  // (and "Use my own Claude Code" unlock) without a manual refresh.
  const runDetect = useCallback(async () => {
    try {
      const [check, auth] = await Promise.all([
        transport.app_prereq_check(),
        transport.app_auth_check(),
      ]);
      const next = evaluateWelcomeState({ check, auth });
      welcomeRef.current = next;
      setWelcome(next);
      setCheckError("");
    } catch (err) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String(err.message || "Failed to check your setup")
          : String(err || "Failed to check your setup");
      setCheckError(message);
    } finally {
      setChecking(false);
    }
  }, []);

  // Initial detect + gentle poll. Polling pauses while a Panda flow is in
  // flight so a mid-install probe doesn't churn the UI.
  useEffect(() => {
    let cancelled = false;
    void runDetect();
    const tick = () => {
      if (cancelled) return;
      // Pause polling while a Panda flow is in flight so a mid-install probe
      // doesn't churn the UI.
      if (pandaStateRef.current === "idle" || pandaStateRef.current === "error") {
        void runDetect();
      }
      pollTimerRef.current = setTimeout(tick, CLAUDE_CHECK_POLL_INTERVAL_MS);
    };
    pollTimerRef.current = setTimeout(tick, CLAUDE_CHECK_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      if (activeFlowRef.current) {
        activeFlowRef.current.cancel();
        activeFlowRef.current = null;
      }
    };
  }, [runDetect]);

  // Persist the auth choice + flip hasOnboarded, then hand control to the app.
  // Re-read first so we never clobber a token a sign-in step just stored.
  const finish = useCallback(
    async (overrides) => {
      setFinishing(true);
      try {
        const existing = await transport.app_settings_read();
        const next = buildOnboardedSettings(existing, overrides);
        await transport.app_settings_write(next);
        onComplete?.(next);
      } catch (err) {
        console.warn("Failed to persist onboarding completion", err);
        // Let the user into the app anyway — they can re-run setup later.
        onComplete?.(null);
      } finally {
        setFinishing(false);
      }
    },
    [onComplete],
  );

  // Wrap the generic install state machine in a promise that resolves to
  // whether the install succeeded, surfacing the error inline on failure.
  const runInstallStep = useCallback(
    () =>
      new Promise((resolve) => {
        const flow = buildClaudeInstallFlow({
          runInstall: () => transport.app_install_claude_code(),
          subscribe: (handler) => transport.onClaudeInstallProgress(handler),
          onChange: ({ progress }) => setPandaProgress(progress),
          onComplete: () => {},
        });
        activeFlowRef.current = flow;
        void flow.start().then(() => {
          if (flow.state === "done") {
            resolve(true);
          } else {
            setPandaError(describeClaudeInstallProgress(flow.progress));
            setPandaState("error");
            resolve(false);
          }
        });
      }),
    [],
  );

  // Same wrapper for the Panda proxy sign-in; resolves to the PandaLoginResult
  // (with the token) or null on failure.
  const runPandaLoginStep = useCallback(
    () =>
      new Promise((resolve) => {
        let captured = null;
        const flow = buildPandaLoginFlow({
          runInstall: () => transport.app_panda_login(),
          subscribe: (handler) => transport.onPandaLoginProgress(handler),
          onChange: ({ progress }) => setPandaProgress(progress),
          onComplete: (result) => {
            captured = result;
          },
        });
        activeFlowRef.current = flow;
        void flow.start().then(() => {
          if (flow.state === "done") {
            resolve(captured || { token: "" });
          } else {
            setPandaError(describePandaLoginProgress(flow.progress));
            setPandaState("error");
            resolve(null);
          }
        });
      }),
    [],
  );

  const signInWithPanda = useCallback(async () => {
    if (busy) return;
    setPandaError("");
    setPandaProgress(null);

    // The proxy only redirects the API — the local `claude` binary is still the
    // runtime, so install it first if it's missing.
    if (!welcomeRef.current?.cliFound) {
      setPandaState("installing");
      const installed = await runInstallStep();
      if (!installed) return;
    }

    setPandaState("signing_in");
    const result = await runPandaLoginStep();
    if (!result) return;

    await finish({ usePandaCloud: true, pandaToken: result.token });
  }, [busy, finish, runInstallStep, runPandaLoginStep]);

  const useOwnClaude = useCallback(() => {
    if (busy || !welcomeRef.current?.canUseOwn) return;
    void finish({ usePandaCloud: false });
  }, [busy, finish]);

  const cliFound = welcome?.cliFound ?? false;
  const cliVersion = welcome?.cliVersion ?? "";
  const authed = welcome?.authed ?? false;
  const canUseOwn = welcome?.canUseOwn ?? false;
  const ownBlockedReason = welcome?.ownBlockedReason ?? "";

  const progressLabel = pandaProgress
    ? pandaState === "installing"
      ? describeClaudeInstallProgress(pandaProgress)
      : describePandaLoginProgress(pandaProgress)
    : null;

  const ownBlockedCopy =
    ownBlockedReason === "not_installed"
      ? "Claude Code isn’t installed yet."
      : ownBlockedReason === "not_signed_in"
        ? "Claude Code is installed, but not signed in yet."
        : "";

  return (
    <div
      role="dialog"
      aria-label="Welcome to Panda"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-4"
    >
      <div className="w-full max-w-xl rounded-lg border border-border bg-background p-6 shadow-xl">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Welcome to Panda</h1>
          <p className="text-sm text-muted-foreground">
            Panda turns a chat into a printable model. Choose how you’d like to
            connect Claude — sign in with Panda for the easiest start, or bring
            your own Claude Code.
          </p>
        </header>

        {/* Detection status */}
        <div className="mt-4 flex flex-col gap-1 rounded-md border border-border bg-muted/30 p-3 text-sm">
          {checking ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Checking your computer…
            </span>
          ) : (
            <>
              <span className="flex items-center gap-2">
                <Terminal className="size-4 text-muted-foreground" />
                Claude Code:{" "}
                {cliFound ? (
                  <span className="font-medium text-emerald-600">
                    detected{cliVersion ? ` (${cliVersion})` : ""}
                  </span>
                ) : (
                  <span className="font-medium text-muted-foreground">
                    not found
                  </span>
                )}
              </span>
              <span className="flex items-center gap-2">
                {authed ? (
                  <CheckCircle2 className="size-4 text-emerald-600" />
                ) : (
                  <CheckCircle2 className="size-4 text-muted-foreground/40" />
                )}
                Signed in:{" "}
                <span className="font-medium">{authed ? "yes" : "no"}</span>
              </span>
            </>
          )}
          {checkError ? (
            <span className="text-destructive" role="alert">
              {checkError}
            </span>
          ) : null}
        </div>

        {/* Primary: Sign in with Panda */}
        <div className="mt-4 flex flex-col gap-3 rounded-md border border-primary/40 bg-primary/5 p-4">
          <div className="flex items-start gap-2">
            <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="space-y-1">
              <p className="font-medium">
                Sign in with Panda{" "}
                <span className="ml-1 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold text-primary">
                  Recommended
                </span>
              </p>
              <p className="text-sm text-muted-foreground">
                Use Panda’s Claude — no Claude subscription needed.
                {!cliFound
                  ? " We’ll install the Claude Code runtime first."
                  : ""}
              </p>
            </div>
          </div>
          {progressLabel ? (
            <div
              className="flex items-center gap-2 rounded-md border border-border bg-background/60 p-3 text-sm"
              data-testid="panda-login-progress"
            >
              {pandaState === "error" ? null : (
                <Loader2 className="size-4 animate-spin" />
              )}
              <span>{progressLabel}</span>
            </div>
          ) : null}
          {pandaError ? (
            <p className="text-sm text-destructive" role="alert">
              {pandaError}
            </p>
          ) : null}
          <div>
            <Button
              variant="default"
              onClick={() => void signInWithPanda()}
              disabled={busy || checking}
              data-testid="panda-sign-in"
            >
              {pandaState === "installing" || pandaState === "signing_in" ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  {progressLabel ?? "Signing in…"}
                </>
              ) : pandaState === "error" ? (
                <>
                  <Sparkles className="mr-2 size-4" /> Try again
                </>
              ) : (
                <>
                  <Sparkles className="mr-2 size-4" /> Sign in with Panda
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Secondary: Use my own Claude Code */}
        <div className="mt-3 flex flex-col gap-2 rounded-md border border-border p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <p className="font-medium">Use my own Claude Code</p>
              <p className="text-sm text-muted-foreground">
                {canUseOwn
                  ? "You’re already set up — skip sign-in and use your own Claude."
                  : `Available once Claude Code is installed and signed in. ${ownBlockedCopy}`}
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => useOwnClaude()}
              disabled={busy || checking || !canUseOwn}
              data-testid="use-own-claude"
            >
              {finishing ? "Finishing…" : "Use my own"}
            </Button>
          </div>
        </div>

        {/* Tertiary: set up your own / re-check */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
          <Button asChild variant="link" className="h-auto p-0">
            <a
              href={PANDA_SETUP_URL}
              target="_blank"
              rel="noreferrer noopener"
              data-testid="setup-own-claude"
            >
              <ExternalLink className="mr-1 size-4" /> Set up your own Claude
            </a>
          </Button>
          <Button
            variant="ghost"
            onClick={() => void runDetect()}
            disabled={busy}
            data-testid="welcome-recheck"
          >
            Re-check
          </Button>
        </div>
      </div>
    </div>
  );
}
