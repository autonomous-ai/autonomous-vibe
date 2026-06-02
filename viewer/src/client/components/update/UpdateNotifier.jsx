"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpCircle, Download, Loader2, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/ui/utils";
import { transport } from "@/lib/transport.ts";

// All four update surfaces in one place, driven by the `update_event` stream
// (see desktop/src-tauri/src/commands/update.rs):
//   - Option 2 "ask before installing" → the `available` banner with
//     Update now / Later.
//   - Option 3 "passive badge"         → collapse the banner with Later; it
//     reappears as a small pill you can reopen.
//   - Option 4 "download progress"     → the `downloading` progress bar.
//   - Option 1 "restart to apply"      → the `ready` banner with Restart now
//     (also how the silent auto-update mode surfaces itself).

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 MB";
  const mb = n / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export default function UpdateNotifier() {
  // phase: idle | available | downloading | ready
  // (no error phase — update failures are best-effort and stay silent)
  const [phase, setPhase] = useState("idle");
  const [info, setInfo] = useState(null);
  const [progress, setProgress] = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const installingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    // events.subscribe returns a *synchronous* unsubscribe thunk (it wraps the
    // async listenEvent internally). Do NOT use transport.onUpdateEvent here —
    // that returns a Promise, and calling it as a function in cleanup throws,
    // which under <StrictMode>'s mount/cleanup/mount cycle crashes the whole
    // tree to a black screen.
    const unsubscribe = transport.events.subscribe("update_event", (event) => {
      if (cancelled || !event || typeof event !== "object") return;
      switch (event.status) {
        case "checking":
          // Keep whatever we're showing; a re-check shouldn't clear a
          // ready/downloading state.
          break;
        case "available":
          setInfo({
            version: event.version,
            currentVersion: event.currentVersion,
            notes: event.notes,
            date: event.date,
          });
          setPhase((p) => (p === "downloading" || p === "ready" ? p : "available"));
          break;
        case "downloading":
          installingRef.current = true;
          setProgress({
            downloadedBytes: event.downloadedBytes,
            totalBytes: event.totalBytes,
          });
          setCollapsed(false);
          setPhase("downloading");
          break;
        case "ready":
          installingRef.current = false;
          setInfo((prev) => prev ?? { version: event.version });
          setCollapsed(false);
          setPhase("ready");
          break;
        case "up_to_date":
          setPhase((p) => (p === "available" ? "idle" : p));
          break;
        case "error":
          // Auto-update is best-effort: never surface a failed/error state.
          // Drop any in-progress UI and go quiet.
          installingRef.current = false;
          setPhase("idle");
          break;
        default:
          break;
      }
    });

    // Tauri events aren't buffered, so a listener attached after the startup
    // check would miss it. Drive our own check on mount to learn the current
    // state (no-op in browser dev — the stub returns null).
    transport.update_check().catch(() => {
      /* best-effort; the updater is absent in dev/browser */
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const startInstall = useCallback(() => {
    if (installingRef.current) return;
    installingRef.current = true;
    setProgress(null);
    setPhase("downloading");
    transport.update_install().catch(() => {
      // Best-effort: swallow install failures silently rather than showing
      // an error banner. Go quiet.
      installingRef.current = false;
      setPhase("idle");
    });
  }, []);

  const relaunch = useCallback(() => {
    transport.update_relaunch().catch(() => {
      /* the process is about to exit; nothing to recover */
    });
  }, []);

  const pct = useMemo(() => {
    if (!progress || !progress.totalBytes) return null;
    return Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100));
  }, [progress]);

  if (phase === "idle") return null;

  // Passive badge (Option 3): a collapsed banner lives here until reopened.
  if (collapsed && (phase === "available" || phase === "ready")) {
    const ready = phase === "ready";
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="cad-glass-popover fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-popover-foreground shadow-lg shadow-black/10 transition hover:bg-muted/40"
        data-testid="update-badge"
      >
        <span className="relative flex size-2">
          <span
            className={cn(
              "absolute inline-flex size-2 animate-ping rounded-full opacity-75",
              ready ? "bg-emerald-500" : "bg-sky-500",
            )}
          />
          <span
            className={cn(
              "relative inline-flex size-2 rounded-full",
              ready ? "bg-emerald-500" : "bg-sky-500",
            )}
          />
        </span>
        {ready ? "Restart to update" : "Update available"}
      </button>
    );
  }

  return (
    <div
      className="cad-glass-popover fixed bottom-4 left-4 z-50 w-[min(calc(100vw-2rem),24rem)] rounded-lg border border-border p-4 text-sm text-popover-foreground shadow-xl shadow-black/15"
      data-testid="update-notifier"
      data-phase={phase}
    >
      {phase === "downloading" ? (
        <div className="flex items-start gap-3">
          <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin text-sky-500" />
          <div className="flex-1 space-y-2">
            <p className="font-medium">
              Downloading update{info?.version ? ` ${info.version}` : ""}…
            </p>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full bg-sky-500 transition-[width] duration-200",
                  pct === null && "animate-pulse",
                )}
                style={{ width: pct === null ? "100%" : `${pct}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {pct === null
                ? progress
                  ? formatBytes(progress.downloadedBytes)
                  : "Starting…"
                : `${pct}% · ${formatBytes(progress.downloadedBytes)} of ${formatBytes(
                    progress.totalBytes,
                  )}`}
            </p>
          </div>
        </div>
      ) : phase === "ready" ? (
        <div className="flex items-start gap-3">
          <RotateCw className="mt-0.5 size-5 shrink-0 text-emerald-500" />
          <div className="flex-1 space-y-2">
            <p className="font-medium">
              Update ready{info?.version ? ` (${info.version})` : ""}
            </p>
            <p className="text-xs text-muted-foreground">
              Restart Panda to finish updating.
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={relaunch} data-testid="update-restart">
                <RotateCw className="mr-1.5 size-3.5" /> Restart now
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCollapsed(true)}>
                Later
              </Button>
            </div>
          </div>
        </div>
      ) : (
        // phase === "available"
        <div className="flex items-start gap-3">
          <ArrowUpCircle className="mt-0.5 size-5 shrink-0 text-sky-500" />
          <div className="flex-1 space-y-2">
            <div>
              <p className="font-medium">Update available</p>
              <p className="text-xs text-muted-foreground">
                Version {info?.version}
                {info?.currentVersion ? ` — you have ${info.currentVersion}` : ""}
              </p>
            </div>
            {info?.notes ? (
              <p className="max-h-24 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">
                {info.notes}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button size="sm" onClick={startInstall} data-testid="update-install">
                <Download className="mr-1.5 size-3.5" /> Update now
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCollapsed(true)}>
                Later
              </Button>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="text-muted-foreground transition hover:text-foreground"
            aria-label="Dismiss"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}
