"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  KeyRound,
  Laptop,
  Loader2,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { transport } from "@/lib/transport.ts";
import {
  buildClaudeInstallFlow,
  buildClaudeLoginFlow,
  buildPandaLoginFlow,
  buildOnboardedSettings,
  CLAUDE_CHECK_POLL_INTERVAL_MS,
  CLAUDE_INSTALL_URL,
  describeClaudeInstallProgress,
  describeClaudeLoginProgress,
  describePandaLoginProgress,
  evaluateWelcomeState,
  installErrorHint,
} from "./onboardingHelpers.js";

/**
 * Single-screen onboarding. The primary, recommended path is "Use your own
 * Claude Code" — Panda drives the local `claude` binary directly. We detect it,
 * and guide (never auto-install) when it's missing: a fresh user gets install
 * instructions + link, and once the CLI appears we offer an inline guided
 * sign-in (`app_login_claude` → approve in browser → paste the code). When the
 * CLI is already installed AND signed in, one button connects it.
 *
 * "Sign in with Panda" — the hosted proxy that needs no account of your own —
 * stays available but is tucked under a "More options" disclosure, so it's the
 * fallback for people who don't already run Claude Code (see also the matching
 * chooser in AuthModeControl).
 *
 * Everything else (slicer / printer / filament) moved out of onboarding into the
 * in-app "Add Printer" flow.
 */
export default function WelcomeScreen({ onComplete }) {
  const [checking, setChecking] = useState(true);
  const [welcome, setWelcome] = useState(null);
  const [checkError, setCheckError] = useState("");
  // Local (bring-your-own) sign-in: "idle" | "signing_in" | "error". The
  // terminal success path completes onboarding rather than parking in "done".
  const [localState, setLocalState] = useState("idle");
  const [localProgress, setLocalProgress] = useState(null);
  const [localError, setLocalError] = useState("");
  // The authorization code the hosted sign-in page shows after approval; fed
  // back into the in-flight `claude setup-token` PTY via app_submit_login_code.
  const [codeInput, setCodeInput] = useState("");
  const [submittingCode, setSubmittingCode] = useState(false);
  // Panda path: "idle" | "installing" | "signing_in" | "error".
  const [pandaState, setPandaState] = useState("idle");
  const [pandaProgress, setPandaProgress] = useState(null);
  const [pandaError, setPandaError] = useState("");
  // "More options" disclosure that reveals the Panda fallback. Collapsed by
  // default so your-own-Claude-Code reads as the one obvious path.
  const [moreOpen, setMoreOpen] = useState(false);
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
  // Mirror the in-flight states into refs so the poll loop can read the latest
  // value without taking them as effect dependencies (which would re-subscribe
  // the timer — and cancel the in-flight flow — on every transition).
  const pandaStateRef = useRef("idle");
  const localStateRef = useRef("idle");
  useEffect(() => {
    pandaStateRef.current = pandaState;
  }, [pandaState]);
  useEffect(() => {
    localStateRef.current = localState;
  }, [localState]);

  const busy =
    finishing ||
    pandaState === "installing" ||
    pandaState === "signing_in" ||
    localState === "signing_in";

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

  // Initial detect + gentle poll. Polling pauses while any sign-in flow is in
  // flight so a mid-flow probe doesn't churn the UI.
  useEffect(() => {
    let cancelled = false;
    void runDetect();
    const tick = () => {
      if (cancelled) return;
      const pandaIdle =
        pandaStateRef.current === "idle" || pandaStateRef.current === "error";
      const localIdle = localStateRef.current !== "signing_in";
      if (pandaIdle && localIdle) {
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

  // ----- Bring-your-own Claude Code: guided local sign-in ------------------

  // Wrap the generic login state machine in a promise that resolves to whether
  // sign-in succeeded. Drives `claude setup-token` via app_login_claude; the
  // user pastes the authorization code back through submitLoginCode (below),
  // which completes the in-flight call.
  const runLocalLoginStep = useCallback(
    () =>
      new Promise((resolve) => {
        const flow = buildClaudeLoginFlow({
          runLogin: () => transport.app_login_claude(),
          subscribe: (handler) => transport.onClaudeLoginProgress(handler),
          onChange: ({ progress }) => setLocalProgress(progress),
          onComplete: () => {},
        });
        activeFlowRef.current = flow;
        void flow.start().then(() => {
          if (cancelledRef.current) {
            resolve(false);
          } else if (flow.state === "done") {
            resolve(true);
          } else {
            setLocalError(describeClaudeLoginProgress(flow.progress));
            setLocalState("error");
            resolve(false);
          }
        });
      }),
    [],
  );

  const signInWithOwnClaude = useCallback(async () => {
    if (busy) return;
    cancelledRef.current = false;
    setLocalError("");
    setLocalProgress(null);
    setCodeInput("");
    setLocalState("signing_in");
    const ok = await runLocalLoginStep();
    if (!ok) return;
    // Local OAuth token persisted Rust-side; finish() only flips hasOnboarded.
    await finish({ usePandaCloud: false });
  }, [busy, finish, runLocalLoginStep]);

  // Feed the authorization code into the in-flight `claude setup-token` PTY.
  // On success the awaiting app_login_claude resolves and runLocalLoginStep
  // settles to "done", which drives finish() in signInWithOwnClaude.
  const submitLoginCode = useCallback(async () => {
    const code = codeInput.trim();
    if (!code || submittingCode) return;
    setSubmittingCode(true);
    setLocalError("");
    try {
      await transport.app_submit_login_code(code);
    } catch (err) {
      setLocalError(
        err && typeof err === "object" && "message" in err
          ? String(err.message || "Couldn’t complete sign-in with that code")
          : String(err || "Couldn’t complete sign-in with that code"),
      );
    } finally {
      setSubmittingCode(false);
    }
  }, [codeInput, submittingCode]);

  // Abandon an in-flight local sign-in. There's no Rust cancel handle for
  // `claude setup-token` (unlike Panda), so we just stop the local flow and
  // reset to idle; the abandoned PTY exits on its own.
  const cancelLocalLogin = useCallback(() => {
    cancelledRef.current = true;
    if (activeFlowRef.current) activeFlowRef.current.cancel();
    setLocalState("idle");
    setLocalProgress(null);
    setLocalError("");
    setCodeInput("");
  }, []);

  // Ready path: CLI installed AND already authenticated — connect it directly.
  const connectOwnClaude = useCallback(() => {
    if (busy || !welcomeRef.current?.canUseOwn) return;
    void finish({ usePandaCloud: false });
  }, [busy, finish]);

  // ----- Panda fallback (under "More options") -----------------------------

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

  // Abandon an in-flight Panda sign-in: tell Rust to drop the pending login (so
  // it doesn't wait out the 10-min timeout), stop the local flow, and reset to
  // idle so the sign-in button is immediately usable again.
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

  const cliFound = welcome?.cliFound ?? false;
  const authed = welcome?.authed ?? false;
  const canUseOwn = welcome?.canUseOwn ?? false;
  const ownBlockedReason = welcome?.ownBlockedReason ?? "";

  const localProgressLabel = localProgress
    ? describeClaudeLoginProgress(localProgress)
    : null;
  const pandaProgressLabel = pandaProgress
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
            Panda turns a chat into a printable model. Connect Claude Code to get
            started.
          </p>
        </header>

        {/* Readiness — plain language, no CLI / version / auth jargon. Re-check
            sits on the same line, right-aligned, so it reads as "refresh this
            status" rather than a stray bottom action. */}
        <div className="mt-4 flex flex-col gap-1 rounded-md border border-border bg-muted/30 p-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            {checking ? (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Getting things ready…
              </span>
            ) : canUseOwn ? (
              <span className="flex items-center gap-2">
                <CheckCircle2 className="size-4 text-emerald-600" /> Claude Code
                detected — you’re ready to create
              </span>
            ) : (
              <span className="flex items-center gap-2 text-muted-foreground">
                <CheckCircle2 className="size-4 text-muted-foreground/40" />{" "}
                Connect your own Claude Code below to get started.
              </span>
            )}
            {/* Only offer Re-check while not yet ready — once Claude Code is
                detected and signed in, refreshing the status is pointless. */}
            {!checking && !canUseOwn ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void runDetect()}
                disabled={busy}
                data-testid="welcome-recheck"
                className="-my-1 h-7 shrink-0"
              >
                Re-check
              </Button>
            ) : null}
          </div>
          {checkError ? (
            <span className="text-destructive" role="alert">
              {checkError}
            </span>
          ) : null}
        </div>

        {/* Primary: use your own Claude Code */}
        <div className="mt-4 flex flex-col gap-3 rounded-md border border-primary/40 bg-primary/5 p-4">
          <div className="flex items-start gap-2">
            <Laptop className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="space-y-1">
              <p className="font-medium">Use your own Claude Code</p>
              <p className="text-sm text-muted-foreground">
                {canUseOwn
                  ? "Claude Code is detected and signed in — connect it to start creating."
                  : ownBlockedReason === "not_signed_in"
                    ? "Claude Code is installed. Sign in to connect it."
                    : "Install Claude Code, then sign in — Panda detects it automatically."}
              </p>
            </div>
          </div>

          {/* Guided sign-in progress (installed-but-not-signed-in path). */}
          {localProgressLabel ? (
            <div
              className="flex flex-col gap-2 rounded-md border border-border bg-background/60 p-3 text-sm"
              data-testid="claude-login-progress"
            >
              <div className="flex items-center gap-2">
                {localState === "error" ? null : (
                  <Loader2 className="size-4 animate-spin" />
                )}
                <span>{localProgressLabel}</span>
              </div>
              {localProgress?.stage === "awaiting_browser" &&
              localProgress?.url ? (
                <a
                  href={localProgress.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                  data-testid="claude-login-link"
                >
                  <ExternalLink className="size-3.5" /> Didn’t open? Open the
                  sign-in page
                </a>
              ) : null}
              {localProgress?.stage === "awaiting_browser" ? (
                <div className="flex flex-col gap-2 border-t border-border/60 pt-2">
                  <label
                    htmlFor="claude-code-input"
                    className="text-xs text-muted-foreground"
                  >
                    Approved? Paste the code from that page to finish signing in.
                  </label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="claude-code-input"
                      value={codeInput}
                      onChange={(e) => setCodeInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void submitLoginCode();
                        }
                      }}
                      placeholder="Paste code…"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={submittingCode}
                      data-testid="claude-code-input"
                      className="h-8 text-sm"
                    />
                    <Button
                      size="sm"
                      onClick={() => void submitLoginCode()}
                      disabled={submittingCode || !codeInput.trim()}
                      data-testid="claude-code-submit"
                    >
                      {submittingCode ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        "Finish"
                      )}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {localError ? (
            <p className="text-sm text-destructive" role="alert">
              {localError}
            </p>
          ) : null}

          {/* Not installed → guidance + link (we never auto-install here). */}
          {!checking && ownBlockedReason === "not_installed" ? (
            <a
              href={CLAUDE_INSTALL_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 self-start text-sm text-primary underline-offset-2 hover:underline"
              data-testid="claude-install-link"
            >
              <ExternalLink className="size-3.5" /> Install Claude Code
            </a>
          ) : null}

          {/* The primary action adapts to readiness. */}
          {canUseOwn ? (
            <Button
              variant="default"
              onClick={() => connectOwnClaude()}
              disabled={busy || checking}
              data-testid="use-own-claude"
            >
              {finishing ? "Finishing…" : "Start creating"}
            </Button>
          ) : ownBlockedReason === "not_signed_in" ? (
            <div className="flex items-center gap-2">
              <Button
                variant="default"
                onClick={() => void signInWithOwnClaude()}
                disabled={busy || checking}
                data-testid="claude-sign-in"
              >
                {localState === "signing_in" ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    {localProgressLabel ?? "Signing in…"}
                  </>
                ) : localState === "error" ? (
                  <>
                    <Laptop className="mr-2 size-4" /> Try again
                  </>
                ) : (
                  <>
                    <Laptop className="mr-2 size-4" /> Sign in to Claude Code
                  </>
                )}
              </Button>
              {localState === "signing_in" ? (
                <Button
                  variant="ghost"
                  onClick={() => cancelLocalLogin()}
                  data-testid="claude-sign-in-cancel"
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* More options: the Panda hosted-proxy fallback. Collapsed by default so
            your-own-Claude-Code stays the one obvious path; anyone without Claude
            Code expands this to use Panda's built-in AI instead. */}
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            aria-expanded={moreOpen}
            data-testid="welcome-more-options"
          >
            {moreOpen ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
            More options
          </button>

          {moreOpen ? (
            <div className="mt-2 flex flex-col gap-3 rounded-md border border-border bg-muted/20 p-4">
              <div className="flex items-start gap-2">
                <Sparkles className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="space-y-1">
                  <p className="font-medium">Sign in with Panda</p>
                  <p className="text-sm text-muted-foreground">
                    No Claude Code? Use Panda’s built-in AI — no account or
                    subscription of your own.
                    {!cliFound ? " We’ll get everything ready automatically." : ""}
                  </p>
                </div>
              </div>
              {pandaProgressLabel ? (
                <div
                  className="flex flex-col gap-2 rounded-md border border-border bg-background/60 p-3 text-sm"
                  data-testid="panda-login-progress"
                >
                  <div className="flex items-center gap-2">
                    {pandaState === "error" ? null : (
                      <Loader2 className="size-4 animate-spin" />
                    )}
                    <span>{pandaProgressLabel}</span>
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
                            Approved already? Paste the sign-in token from that
                            page to finish.
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
                  variant="secondary"
                  size="sm"
                  onClick={() => void signInWithPanda()}
                  disabled={busy || checking}
                  data-testid="panda-sign-in"
                >
                  {pandaState === "installing" || pandaState === "signing_in" ? (
                    <>
                      <Loader2 className="mr-2 size-4 animate-spin" />
                      {pandaProgressLabel ?? "Signing in…"}
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
                    size="sm"
                    onClick={() => cancelPandaLogin()}
                    data-testid="panda-sign-in-cancel"
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

      </div>
    </div>
  );
}
