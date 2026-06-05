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
  buildInstallFlow,
  describeSlicerInstallProgress,
  evaluateSlicerCheck,
  ORCA_DOWNLOAD_URL,
  SLICER_CHECK_POLL_INTERVAL_MS,
} from "./onboardingHelpers.js";

export default function SlicerCheckStep({ onAdvance }) {
  const [status, setStatus] = useState("checking"); // checking | missing | found | error
  const [error, setError] = useState("");
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
      const result = evaluateSlicerCheck(check);
      if (result.proceed) {
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
    const flow = buildInstallFlow({
      runInstall: () => transport.app_install_orcaslicer(),
      subscribe: (handler) => transport.onSlicerInstallProgress(handler),
      onComplete: () => {
        // The Rust side already re-ran detect_slicer, so a successful install
        // is authoritative — advance via the same path the missing→found
        // transition uses.
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
      pollTimerRef.current = setTimeout(tick, SLICER_CHECK_POLL_INTERVAL_MS);
    };
    pollTimerRef.current = setTimeout(tick, SLICER_CHECK_POLL_INTERVAL_MS);
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
    ? describeSlicerInstallProgress(installProgress)
    : null;

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold">Set up OrcaSlicer</h2>
        <p className="text-sm text-muted-foreground">
          Panda turns your models into printable G-code with OrcaSlicer. We’ll
          install it for you — no manual setup needed.
        </p>
      </header>
      {status === "checking" ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-4 text-sm">
          <Loader2 className="size-4 animate-spin" />
          Checking for OrcaSlicer on your computer…
        </div>
      ) : null}
      {status === "found" ? (
        <div className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm">
          <CheckCircle2 className="size-4 text-emerald-600" />
          <span>OrcaSlicer is ready. Moving on…</span>
        </div>
      ) : null}
      {status === "missing" || status === "error" ? (
        <div className="flex flex-col gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
          <div className="flex items-start gap-2 text-sm">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <div className="space-y-1">
              <p className="font-medium">
                {status === "error"
                  ? "Could not check for OrcaSlicer"
                  : "OrcaSlicer is not installed yet"}
              </p>
              <p className="text-muted-foreground">
                {status === "error"
                  ? error
                  : "Install OrcaSlicer in one click below — or grab it yourself and come back."}
              </p>
            </div>
          </div>
          {installing || installFailed || installProgress ? (
            <div
              className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm"
              data-testid="slicer-install-progress"
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
              data-testid="slicer-install-auto"
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
                href={ORCA_DOWNLOAD_URL}
                target="_blank"
                rel="noreferrer noopener"
                data-testid="slicer-install-manual"
              >
                <ExternalLink className="mr-2 size-4" /> I’ll install it myself
              </a>
            </Button>
            <Button
              variant="ghost"
              onClick={() => void runCheck()}
              disabled={installing}
              data-testid="slicer-check-recheck"
            >
              Continue once installed
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
