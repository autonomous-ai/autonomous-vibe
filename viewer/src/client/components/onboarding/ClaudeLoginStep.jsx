"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  ShieldAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { transport } from "@/lib/transport.ts";
import {
  buildClaudeLoginFlow,
  CLAUDE_CHECK_POLL_INTERVAL_MS,
  describeClaudeLoginProgress,
  evaluateAuthCheck,
} from "./onboardingHelpers.js";

export default function ClaudeLoginStep({ onAdvance }) {
  const [status, setStatus] = useState("checking"); // checking | signed_out | signed_in | error
  const [error, setError] = useState("");
  const [loginState, setLoginState] = useState("idle"); // idle | signing_in | done | error
  const [loginProgress, setLoginProgress] = useState(null);
  const advancedRef = useRef(false);
  const loginFlowRef = useRef(null);

  const runCheck = useCallback(async () => {
    setStatus((current) => (current === "signed_in" ? current : "checking"));
    setError("");
    try {
      const result = evaluateAuthCheck(await transport.app_auth_check());
      if (result.proceed) {
        setStatus("signed_in");
        if (!advancedRef.current) {
          advancedRef.current = true;
          onAdvance?.();
        }
      } else {
        setStatus("signed_out");
      }
    } catch (err) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String(err.message || "Failed to check sign-in")
          : String(err || "Failed to check sign-in");
      setError(message);
      setStatus("error");
    }
  }, [onAdvance]);

  const startLogin = useCallback(() => {
    if (loginFlowRef.current) return;
    const flow = buildClaudeLoginFlow({
      runLogin: () => transport.app_login_claude(),
      subscribe: (handler) => transport.onClaudeLoginProgress(handler),
      onComplete: () => {
        setStatus("signed_in");
        if (!advancedRef.current) {
          advancedRef.current = true;
          onAdvance?.();
        }
      },
      onChange: ({ state, progress }) => {
        setLoginState(state);
        setLoginProgress(progress);
      },
    });
    loginFlowRef.current = flow;
    void flow.start();
  }, [onAdvance]);

  useEffect(() => {
    void runCheck();
    return () => {
      if (loginFlowRef.current) {
        loginFlowRef.current.cancel();
        loginFlowRef.current = null;
      }
    };
  }, [runCheck]);

  const signingIn = loginState === "signing_in";
  const loginFailed = loginState === "error";
  const progressLabel = loginProgress
    ? describeClaudeLoginProgress(loginProgress)
    : null;
  const browserUrl =
    loginProgress && loginProgress.stage === "awaiting_browser"
      ? loginProgress.url
      : null;

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold">Sign in to Claude</h2>
        <p className="text-sm text-muted-foreground">
          Panda uses your Claude subscription to design and slice your prints.
          Sign in once — your browser opens, you approve, and you’re done. No
          API keys to copy.
        </p>
      </header>

      {status === "checking" ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-4 text-sm">
          <Loader2 className="size-4 animate-spin" />
          Checking your Claude sign-in…
        </div>
      ) : null}

      {status === "signed_in" ? (
        <div className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm">
          <CheckCircle2 className="size-4 text-emerald-600" />
          <span>You’re signed in to Claude. Moving on…</span>
        </div>
      ) : null}

      {status === "signed_out" || status === "error" ? (
        <div className="flex flex-col gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
          <div className="flex items-start gap-2 text-sm">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <div className="space-y-1">
              <p className="font-medium">
                {status === "error"
                  ? "Could not check your sign-in"
                  : "You’re not signed in yet"}
              </p>
              <p className="text-muted-foreground">
                {status === "error"
                  ? error
                  : "Click below to sign in with your Claude account (Pro or Max)."}
              </p>
            </div>
          </div>

          {signingIn || loginFailed || loginProgress ? (
            <div
              className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm"
              data-testid="claude-login-progress"
            >
              <div className="flex items-center gap-2">
                {signingIn ? <Loader2 className="size-4 animate-spin" /> : null}
                {loginFailed ? (
                  <ShieldAlert className="size-4 text-red-600" />
                ) : null}
                <span>{progressLabel}</span>
              </div>
              {browserUrl ? (
                <a
                  href={browserUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-xs text-primary underline"
                  data-testid="claude-login-url"
                >
                  <ExternalLink className="size-3" /> Didn’t open? Click here to
                  sign in
                </a>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="default"
              onClick={() => startLogin()}
              disabled={signingIn}
              data-testid="claude-login-start"
            >
              {signingIn ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  {progressLabel ?? "Signing in…"}
                </>
              ) : (
                <>
                  <KeyRound className="mr-2 size-4" /> Sign in with Claude
                </>
              )}
            </Button>
            <Button
              variant="ghost"
              onClick={() => void runCheck()}
              disabled={signingIn}
              data-testid="claude-login-recheck"
            >
              I’ve already signed in
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
