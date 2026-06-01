"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  ShieldAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { transport } from "@/lib/transport.ts";
import {
  buildClaudeInstallFlow,
  CLAUDE_CHECK_POLL_INTERVAL_MS,
  CLAUDE_INSTALL_URL,
  describeClaudeInstallProgress,
  evaluateClaudeCheck,
} from "./onboardingHelpers.js";

export default function ClaudeCheckStep({ onAdvance }) {
  const [status, setStatus] = useState("checking"); // checking | missing | found | error
  const [version, setVersion] = useState("");
  const [error, setError] = useState("");
  // Track I — auto-install flow state.
  const [installState, setInstallState] = useState("idle"); // idle | installing | done | error
  const [installProgress, setInstallProgress] = useState(null);
  const pollTimerRef = useRef(0);
  const advancedRef = useRef(false);
  const installFlowRef = useRef(null);

  const runCheck = useCallback(async () => {
    setStatus((current) => (current === "found" ? current : "checking"));
    setError("");
    try {
      const check = await transport.app_prereq_check();
      const result = evaluateClaudeCheck(check);
      if (result.proceed) {
        setVersion(result.version);
        setStatus("found");
        if (!advancedRef.current) {
          advancedRef.current = true;
          onAdvance?.();
        }
      } else {
        setStatus("missing");
      }
    } catch (err) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String(err.message || "Failed to check prerequisites")
          : String(err || "Failed to check prerequisites");
      setError(message);
      setStatus("error");
    }
  }, [onAdvance]);

  const startInstall = useCallback(() => {
    if (installFlowRef.current) return;
    const flow = buildClaudeInstallFlow({
      runInstall: () => transport.app_install_claude_code(),
      subscribe: (handler) => transport.onClaudeInstallProgress(handler),
      onComplete: (result) => {
        // Treat the post-install probe as authoritative. The Rust side
        // already verified detect_claude_cli, so we can advance the
        // wizard via the same path the missing→found transition uses.
        setVersion(String(result?.version || ""));
        setStatus("found");
        if (!advancedRef.current) {
          advancedRef.current = true;
          onAdvance?.();
        }
      },
      onChange: ({ state, progress }) => {
        setInstallState(state);
        setInstallProgress(progress);
      },
    });
    installFlowRef.current = flow;
    void flow.start();
  }, [onAdvance]);

  useEffect(() => {
    let cancelled = false;
    void runCheck();
    const tick = () => {
      if (cancelled) return;
      void runCheck();
      pollTimerRef.current = setTimeout(tick, CLAUDE_CHECK_POLL_INTERVAL_MS);
    };
    pollTimerRef.current = setTimeout(tick, CLAUDE_CHECK_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
      }
      if (installFlowRef.current) {
        installFlowRef.current.cancel();
        installFlowRef.current = null;
      }
    };
  }, [runCheck]);

  const installing = installState === "installing";
  const installFailed = installState === "error";
  const progressLabel = installProgress
    ? describeClaudeInstallProgress(installProgress)
    : null;

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold">Connect to Claude Code</h2>
        <p className="text-sm text-muted-foreground">
          Panda chats with your printer through the Claude Code app you already
          run. Install it once and you’re done — no API keys, no separate
          sign-in.
        </p>
      </header>
      {status === "checking" ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-4 text-sm">
          <Loader2 className="size-4 animate-spin" />
          Checking for Claude Code on your computer…
        </div>
      ) : null}
      {status === "found" ? (
        <div className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm">
          <CheckCircle2 className="size-4 text-emerald-600" />
          <span>
            Claude Code is installed{version ? ` (${version})` : ""}. Moving on…
          </span>
        </div>
      ) : null}
      {status === "missing" || status === "error" ? (
        <div className="flex flex-col gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
          <div className="flex items-start gap-2 text-sm">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <div className="space-y-1">
              <p className="font-medium">
                {status === "error"
                  ? "Could not check for Claude Code"
                  : "Claude Code is not installed yet"}
              </p>
              <p className="text-muted-foreground">
                {status === "error"
                  ? error
                  : "Install Claude Code in one click below — or grab it yourself from claude.ai and come back."}
              </p>
            </div>
          </div>
          {installing || installFailed || installProgress ? (
            <div
              className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm"
              data-testid="claude-install-progress"
            >
              {installing ? <Loader2 className="size-4 animate-spin" /> : null}
              {installFailed ? (
                <ShieldAlert className="size-4 text-red-600" />
              ) : null}
              <span>{progressLabel}</span>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="default"
              onClick={() => startInstall()}
              disabled={installing}
              data-testid="claude-install-auto"
            >
              {installing ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  {progressLabel ?? "Installing…"}
                </>
              ) : (
                <>
                  <Download className="mr-2 size-4" /> Install for me
                </>
              )}
            </Button>
            <Button asChild variant="outline" disabled={installing}>
              <a
                href={CLAUDE_INSTALL_URL}
                target="_blank"
                rel="noreferrer noopener"
                data-testid="claude-install-manual"
              >
                <ExternalLink className="mr-2 size-4" /> I’ll install it myself
              </a>
            </Button>
            <Button
              variant="ghost"
              onClick={() => void runCheck()}
              disabled={installing}
              data-testid="claude-check-recheck"
            >
              Continue once installed
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
