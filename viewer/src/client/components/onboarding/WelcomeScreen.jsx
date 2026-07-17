"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ExternalLink,
  Laptop,
  Loader2,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { transport } from "@/lib/transport.ts";
import {
  buildClaudeLoginFlow,
  buildOnboardedSettings,
  CLAUDE_CHECK_POLL_INTERVAL_MS,
  CLAUDE_INSTALL_URL,
  describeClaudeLoginProgress,
  describeSocialLoginProgress,
  evaluateWelcomeState,
} from "./onboardingHelpers.js";

/**
 * Single-screen onboarding. The path is "Use your own Claude Code" — Panda
 * drives the local `claude` binary directly. We detect it, and guide (never
 * auto-install) when it's missing: a fresh user gets install instructions +
 * link, and once the CLI appears we offer an inline guided sign-in
 * (`app_login_claude` → approve in browser → paste the code). When the CLI is
 * already installed AND signed in, one button connects it.
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
  const [socialState, setSocialState] = useState("idle");
  const [socialProgress, setSocialProgress] = useState(null);
  const [socialError, setSocialError] = useState("");
  // The authorization code the hosted sign-in page shows after approval; fed
  // back into the in-flight `claude setup-token` PTY via app_submit_login_code.
  const [codeInput, setCodeInput] = useState("");
  const [submittingCode, setSubmittingCode] = useState(false);
  const [finishing, setFinishing] = useState(false);
  // Bring-your-own Claude Code is the secondary path — kept collapsed behind a
  // "Have Claude Code? Start here." link so the default screen stays focused on
  // the primary Sign in action.
  const [showOwnClaude, setShowOwnClaude] = useState(false);

  const welcomeRef = useRef(null);
  const activeFlowRef = useRef(null);
  const pollTimerRef = useRef(0);
  // Set when the user cancels an in-flight sign-in so the resolving flow returns
  // quietly to idle instead of flashing an error.
  const cancelledRef = useRef(false);
  // Mirror the in-flight state into a ref so the poll loop can read the latest
  // value without taking it as an effect dependency (which would re-subscribe
  // the timer — and cancel the in-flight flow — on every transition).
  const localStateRef = useRef("idle");
  useEffect(() => {
    localStateRef.current = localState;
  }, [localState]);

  const busy = finishing || localState === "signing_in";
  const socialBusy = socialState === "signing_in";
  const anyBusy = busy || socialBusy;

  // Re-run detection. Read-only and idempotent, so it doubles as the poll tick:
  // a user who installs Claude or signs in out-of-band sees the readiness line
  // update without a manual refresh.
  const runDetect = useCallback(async () => {
    try {
      const [check, auth, user] = await Promise.all([
        transport.app_prereq_check(),
        transport.app_auth_check(),
        transport.social_current_user(),
      ]);
      const next = evaluateWelcomeState({ check, auth, user });
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
      const localIdle = localStateRef.current !== "signing_in";
      const socialIdle = socialState !== "signing_in";
      if (localIdle && socialIdle) {
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
  }, [runDetect, socialState]);

  // Flip hasOnboarded, then hand control to the app. Re-read first so we never
  // clobber a token the sign-in step just stored.
  const finish = useCallback(
    async () => {
      setFinishing(true);
      try {
        const existing = await transport.app_settings_read();
        const next = buildOnboardedSettings(existing);
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
    if (anyBusy) return;
    cancelledRef.current = false;
    setLocalError("");
    setLocalProgress(null);
    setCodeInput("");
    setLocalState("signing_in");
    const ok = await runLocalLoginStep();
    if (!ok) return;
    // Local OAuth token persisted Rust-side; finish() only flips hasOnboarded.
    await finish();
  }, [anyBusy, finish, runLocalLoginStep]);

  const signInWithPanda = useCallback(async () => {
    if (anyBusy) return;
    setSocialState("signing_in");
    setSocialProgress(null);
    setSocialError("");

    let off = null;
    try {
      off = await transport.onSocialLoginProgress((event) => {
        setSocialProgress(event);
      });
      const result = await transport.social_login();
      if (!result?.user) {
        setSocialState("error");
        setSocialError("Sign-in did not complete");
        return;
      }
      setSocialState("done");
      await finish();
    } catch (err) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String(err.message || "Sign-in failed")
          : String(err || "Sign-in failed");
      setSocialState("error");
      setSocialError(message);
    } finally {
      if (typeof off === "function") {
        off();
      }
    }
  }, [anyBusy, finish]);

  const cancelSocialLogin = useCallback(async () => {
    try {
      await transport.social_cancel_login();
    } catch {
      // best-effort; still reset local UI state
    }
    setSocialState("idle");
    setSocialProgress(null);
    setSocialError("");
  }, []);

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
    if (anyBusy || !welcomeRef.current?.canUseOwn) return;
    void finish();
  }, [anyBusy, finish]);

  const canUseOwn = welcome?.canUseOwn ?? false;
  const ownBlockedReason = welcome?.ownBlockedReason ?? "";
  const pandaSignedIn = welcome?.pandaSignedIn ?? false;

  const localProgressLabel = localProgress
    ? describeClaudeLoginProgress(localProgress)
    : null;
  const socialProgressLabel = socialProgress
    ? describeSocialLoginProgress(socialProgress)
    : null;

  // Reveal the Claude Code panel once the user opts in, and keep it open
  // whenever a local flow is live (progress, error, or ready-to-connect) so
  // its controls never vanish mid-sign-in.
  const ownExpanded =
    showOwnClaude ||
    canUseOwn ||
    localState !== "idle" ||
    Boolean(localProgressLabel) ||
    Boolean(localError);

  return (
    <div
      role="dialog"
      aria-label="Welcome to Vibe"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-4"
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-background p-8 shadow-xl">
        <header className="flex flex-col gap-1 text-center">
          <Sparkles className="mx-auto size-7 text-emerald-600" />
          <h1 className="mt-3 text-2xl font-semibold">
            Create magical things by chatting with AI.
          </h1>
        </header>

        {/* Primary action: Sign in with Vibe. */}
        <div className="mt-8 flex flex-col gap-3">
          {pandaSignedIn ? (
            <Button
              variant="default"
              size="lg"
              onClick={() => void finish()}
              disabled={anyBusy || checking}
              data-testid="continue-with-panda"
            >
              {finishing ? "Finishing…" : "Continue"}
            </Button>
          ) : (
            <>
              <Button
                variant="default"
                size="lg"
                onClick={() => void signInWithPanda()}
                disabled={anyBusy || checking}
                data-testid="panda-sign-in"
              >
                {socialState === "signing_in" ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    {socialProgressLabel ?? "Signing in…"}
                  </>
                ) : socialState === "error" ? (
                  "Try again"
                ) : (
                  "Sign in"
                )}
              </Button>
              {socialState === "signing_in" ? (
                <Button
                  variant="ghost"
                  onClick={() => void cancelSocialLogin()}
                  data-testid="panda-sign-in-cancel"
                >
                  Cancel
                </Button>
              ) : null}
            </>
          )}

          {socialProgressLabel ? (
            <div
              className="flex items-center gap-2 rounded-md border border-border bg-background/60 p-3 text-sm"
              data-testid="social-login-progress"
            >
              {socialState === "error" ? null : (
                <Loader2 className="size-4 animate-spin" />
              )}
              <span>{socialProgressLabel}</span>
              {socialProgress?.stage === "awaiting_browser" && socialProgress?.url ? (
                <a
                  href={socialProgress.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="ml-auto inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                >
                  <ExternalLink className="size-3.5" /> Open sign-in
                </a>
              ) : null}
            </div>
          ) : null}

          {socialError ? (
            <p className="text-sm text-destructive" role="alert">
              {socialError}
            </p>
          ) : null}
        </div>

        {/* Secondary path: bring your own Claude Code, revealed on demand. */}
        {!ownExpanded ? (
          <button
            type="button"
            onClick={() => setShowOwnClaude(true)}
            disabled={anyBusy}
            data-testid="reveal-own-claude"
            className="mx-auto mt-6 block text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50"
          >
            Have Claude Code?{" "}
            <span className="text-primary">Start here.</span>
          </button>
        ) : (
        <div className="mt-6 flex flex-col gap-3 rounded-md border border-border bg-card/60 p-4">
          <div className="flex items-start gap-2">
            <Laptop className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="space-y-1">
              <p className="font-medium">Have Claude Code? Start here.</p>
              <p className="text-sm text-muted-foreground">
                {checking
                  ? "Getting things ready…"
                  : canUseOwn
                    ? "Claude Code is detected and signed in — connect it to start creating."
                    : ownBlockedReason === "not_signed_in"
                      ? "Claude Code is installed. Sign in to connect it."
                      : "Install Claude Code, then sign in — Vibe detects it automatically."}
              </p>
            </div>
            {/* Re-check while not yet ready — once detected and signed in,
                refreshing the status is pointless. */}
            {!checking && !canUseOwn ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void runDetect()}
                disabled={anyBusy}
                data-testid="welcome-recheck"
                className="-my-1 ml-auto h-7 shrink-0"
              >
                Re-check
              </Button>
            ) : null}
          </div>

          {checkError ? (
            <p className="text-sm text-destructive" role="alert">
              {checkError}
            </p>
          ) : null}

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
                disabled={anyBusy || checking}
              data-testid="use-own-claude"
            >
              {finishing ? "Finishing…" : "Start creating"}
            </Button>
          ) : ownBlockedReason === "not_signed_in" ? (
            <div className="flex items-center gap-2">
              <Button
                variant="default"
                onClick={() => void signInWithOwnClaude()}
                disabled={anyBusy || checking}
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
        )}
      </div>
    </div>
  );
}
