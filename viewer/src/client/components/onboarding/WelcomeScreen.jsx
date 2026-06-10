"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, KeyRound, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { transport } from "@/lib/transport.ts";
import {
  buildClaudeInstallFlow,
  buildPandaLoginFlow,
  buildOnboardedSettings,
  CLAUDE_CHECK_POLL_INTERVAL_MS,
  describeClaudeInstallProgress,
  describePandaLoginProgress,
  evaluateWelcomeState,
  installErrorHint,
} from "./onboardingHelpers.js";

/**
 * Single-screen onboarding. The primary, recommended path is "Sign in with
 * Panda" — a proxy login to Panda's hosted AI. The `claude` binary is still the
 * runtime today, so a missing CLI is installed first; then `app_panda_login`
 * issues a token and we complete with `usePandaCloud: true`.
 *
 * Bring-your-own Claude Code is offered too, but deliberately understated — a
 * quiet row, enabled only when the CLI is installed AND signed in — so Panda
 * stays the obvious choice while people already running Claude Code can connect
 * their own (see also the matching chooser in AuthModeControl).
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
  // Deep-link-independent fallback: paste the authorized token from the hosted
  // sign-in page when the OS can't deliver the `myide://` callback.
  const [tokenEntryOpen, setTokenEntryOpen] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [submittingToken, setSubmittingToken] = useState(false);

  const welcomeRef = useRef(null);
  const activeFlowRef = useRef(null);
  const pollTimerRef = useRef(0);
  // Set when the user cancels an in-flight sign-in so the resolving flow returns
  // quietly to idle instead of flashing an error.
  const cancelledRef = useRef(false);
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
  // a user who installs Claude or signs in out-of-band sees the readiness line
  // update without a manual refresh.
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
          if (cancelledRef.current) {
            resolve(false);
          } else if (flow.state === "done") {
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

  // Same wrapper for the Panda proxy sign-in; resolves true on success. The
  // proxy key is persisted Rust-side (app_panda_login → store_panda_session),
  // so the renderer never sees it — finish() just re-reads settings.
  const runPandaLoginStep = useCallback(
    () =>
      new Promise((resolve) => {
        const flow = buildPandaLoginFlow({
          runInstall: () => transport.app_panda_login(),
          subscribe: (handler) => transport.onPandaLoginProgress(handler),
          onChange: ({ progress }) => setPandaProgress(progress),
          onComplete: () => {},
        });
        activeFlowRef.current = flow;
        void flow.start().then(() => {
          if (cancelledRef.current) {
            resolve(false);
          } else if (flow.state === "done") {
            resolve(true);
          } else {
            setPandaError(describePandaLoginProgress(flow.progress));
            setPandaState("error");
            resolve(false);
          }
        });
      }),
    [],
  );

  // Abandon an in-flight sign-in: tell Rust to drop the pending login (so it
  // doesn't wait out the 10-min timeout), stop the local flow, and reset to idle
  // so the sign-in button is immediately usable again.
  const cancelPandaLogin = useCallback(() => {
    cancelledRef.current = true;
    if (activeFlowRef.current) activeFlowRef.current.cancel();
    void transport.app_cancel_panda_login().catch(() => {});
    setPandaState("idle");
    setPandaProgress(null);
    setPandaError("");
  }, []);

  const signInWithPanda = useCallback(async () => {
    if (busy) return;
    cancelledRef.current = false;
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
    const ok = await runPandaLoginStep();
    if (!ok) return;

    // Rust already persisted panda_token/base_url/use_panda_cloud; finish()
    // re-reads settings and only flips hasOnboarded — the token never touches JS.
    await finish({ usePandaCloud: true });
  }, [busy, finish, runInstallStep, runPandaLoginStep]);

  // Deep-link-independent completion: paste the authorized token from the hosted
  // sign-in page. Persists the session Rust-side, releases any in-flight browser
  // sign-in (so its awaiting promise resolves quietly), then finishes onboarding.
  const finishWithPastedToken = useCallback(async () => {
    const token = tokenInput.trim();
    if (!token || submittingToken) return;
    setSubmittingToken(true);
    setPandaError("");
    try {
      await transport.app_submit_panda_token(token);
      // Quietly unwind the still-awaiting app_panda_login (if any): cancelledRef
      // suppresses its "interrupted" error; app_cancel_panda_login frees the Rust
      // receiver so it doesn't sit out the 10-min timeout.
      cancelledRef.current = true;
      if (activeFlowRef.current) activeFlowRef.current.cancel();
      void transport.app_cancel_panda_login().catch(() => {});
      // finish() re-reads settings (now carrying the token) and flips hasOnboarded.
      await finish({ usePandaCloud: true });
    } catch (err) {
      setPandaError(
        err && typeof err === "object" && "message" in err
          ? String(err.message || "Couldn’t sign in with that token")
          : String(err || "Couldn’t sign in with that token"),
      );
      setSubmittingToken(false);
    }
  }, [tokenInput, submittingToken, finish]);

  // Bring-your-own Claude Code: complete onboarding on the local auth path.
  // Enabled only when the CLI is installed AND signed in — otherwise a chat turn
  // would dead-end — which also naturally keeps it an option for people already
  // set up with Claude Code rather than a prompt for everyone.
  const useOwnClaude = useCallback(() => {
    if (busy || !welcomeRef.current?.canUseOwn) return;
    void finish({ usePandaCloud: false });
  }, [busy, finish]);

  const cliFound = welcome?.cliFound ?? false;
  const authed = welcome?.authed ?? false;
  const canUseOwn = welcome?.canUseOwn ?? false;
  const ownBlockedReason = welcome?.ownBlockedReason ?? "";
  const ownBlockedCopy =
    ownBlockedReason === "not_installed"
      ? "Claude Code isn’t installed yet."
      : ownBlockedReason === "not_signed_in"
        ? "Claude Code is installed, but not signed in yet."
        : "";

  const progressLabel = pandaProgress
    ? pandaState === "installing"
      ? describeClaudeInstallProgress(pandaProgress)
      : describePandaLoginProgress(pandaProgress)
    : null;

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
            Panda turns a chat into a printable model. Sign in to get started —
            no account or subscription needed.
          </p>
        </header>

        {/* Readiness — plain language, no CLI / version / auth jargon */}
        <div className="mt-4 flex flex-col gap-1 rounded-md border border-border bg-muted/30 p-3 text-sm">
          {checking ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Getting things ready…
            </span>
          ) : cliFound && authed ? (
            <span className="flex items-center gap-2">
              <CheckCircle2 className="size-4 text-emerald-600" /> You’re all set
              — sign in to start creating
            </span>
          ) : (
            <span className="flex items-center gap-2 text-muted-foreground">
              <CheckCircle2 className="size-4 text-muted-foreground/40" /> Sign in
              below and Panda sets everything up for you.
            </span>
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
                Use Panda’s built-in AI — no subscription needed.
                {!cliFound ? " We’ll get everything ready automatically." : ""}
              </p>
            </div>
          </div>
          {progressLabel ? (
            <div
              className="flex flex-col gap-2 rounded-md border border-border bg-background/60 p-3 text-sm"
              data-testid="panda-login-progress"
            >
              <div className="flex items-center gap-2">
                {pandaState === "error" ? null : (
                  <Loader2 className="size-4 animate-spin" />
                )}
                <span>{progressLabel}</span>
              </div>
              {pandaProgress?.stage === "awaiting_browser" &&
              pandaProgress?.url ? (
                <a
                  href={pandaProgress.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                  data-testid="panda-login-fallback-link"
                >
                  <ExternalLink className="size-3.5" /> Didn’t open? Open the
                  sign-in page
                </a>
              ) : null}
              {pandaProgress?.stage === "awaiting_browser" ? (
                <div className="flex flex-col gap-2 border-t border-border/60 pt-2">
                  {tokenEntryOpen ? (
                    <>
                      <label
                        htmlFor="panda-token-input"
                        className="text-xs text-muted-foreground"
                      >
                        Approved already? Paste the sign-in token from that page
                        to finish.
                      </label>
                      <div className="flex items-center gap-2">
                        <Input
                          id="panda-token-input"
                          value={tokenInput}
                          onChange={(e) => setTokenInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void finishWithPastedToken();
                            }
                          }}
                          placeholder="ccr-…"
                          autoComplete="off"
                          spellCheck={false}
                          disabled={submittingToken}
                          data-testid="panda-token-input"
                          className="h-8 text-sm"
                        />
                        <Button
                          size="sm"
                          onClick={() => void finishWithPastedToken()}
                          disabled={submittingToken || !tokenInput.trim()}
                          data-testid="panda-token-submit"
                        >
                          {submittingToken ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            "Finish"
                          )}
                        </Button>
                      </div>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setTokenEntryOpen(true)}
                      className="inline-flex items-center gap-1 self-start text-primary underline-offset-2 hover:underline"
                      data-testid="panda-token-disclosure"
                    >
                      <KeyRound className="size-3.5" /> Stuck? Paste a sign-in
                      token instead
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
          {pandaError ? (
            <div role="alert" className="flex flex-col gap-1">
              <p className="text-sm text-destructive">{pandaError}</p>
              {installErrorHint(pandaError) ? (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="panda-error-hint"
                >
                  {installErrorHint(pandaError)}
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="flex items-center gap-2">
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
            {pandaState === "installing" || pandaState === "signing_in" ? (
              <Button
                variant="ghost"
                onClick={() => cancelPandaLogin()}
                data-testid="panda-sign-in-cancel"
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </div>

        {/* Secondary: bring your own Claude Code. Deliberately understated — a
            quiet row, not a second call-to-action — so Panda stays the obvious
            path for most, while anyone already running Claude Code can spot it
            and connect their own. Enabled only when the CLI is installed and
            signed in (otherwise a chat turn would dead-end). */}
        <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2.5">
          <div className="space-y-0.5">
            <p className="text-sm font-medium text-muted-foreground">
              Use your own Claude Code
            </p>
            <p className="text-xs text-muted-foreground">
              {canUseOwn
                ? "Detected and signed in — connect it instead of Panda."
                : `Available once Claude Code is installed and signed in. ${ownBlockedCopy}`}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => useOwnClaude()}
            disabled={busy || checking || !canUseOwn}
            data-testid="use-own-claude"
          >
            {finishing ? "Finishing…" : "Connect"}
          </Button>
        </div>

        <div className="mt-3 flex items-center justify-end text-sm">
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
