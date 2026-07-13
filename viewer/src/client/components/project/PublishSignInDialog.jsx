"use client";

import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ExternalLink, Loader2 } from "lucide-react";
import { transport } from "@/lib/transport.ts";

/** Translate a `social_login_progress` event into a short status label. */
function describeStage(progress) {
  switch (progress?.stage) {
    case "starting":
      return "Starting sign-in…";
    case "awaiting_browser":
      return "Waiting for you to finish signing in in your browser…";
    case "verifying":
      return "Finishing sign-in…";
    case "done":
      return "Signed in";
    case "error":
      return String(progress.message || "Sign-in failed");
    default:
      return "";
  }
}

/**
 * Prompt to sign in to vibe-social. Opened when a publish returns
 * `SOCIAL_TOKEN_REQUIRED` (no session, or the saved one expired). Drives the
 * browser + deep-link PKCE flow (`social_login`) — the app opens the system
 * browser at the hosted login page, the user signs in with Google there, and
 * the page hands control back via a `myide://auth/callback` deep link. On
 * success calls `onSignedIn(user)` so the caller can retry the publish.
 */
export default function PublishSignInDialog({ open, onOpenChange, onSignedIn }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const unsubscribeRef = useRef(null);

  useEffect(() => {
    if (!open) {
      setBusy(false);
      setProgress(null);
    }
  }, [open]);

  // Belt-and-suspenders: drop any live listener if the dialog unmounts
  // mid-flow (e.g. the user navigates away rather than clicking Cancel).
  useEffect(
    () => () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    },
    [],
  );

  const handleSignIn = async () => {
    if (busy) return;
    setBusy(true);
    setProgress({ stage: "starting" });
    try {
      unsubscribeRef.current = await transport.onSocialLoginProgress((event) => {
        setProgress(event);
      });
      const result = await transport.social_login();
      setBusy(false);
      onOpenChange?.(false);
      onSignedIn?.(result?.user);
    } catch (err) {
      setBusy(false);
      setProgress({
        stage: "error",
        message: err?.message || "Sign-in failed. Please try again.",
      });
    } finally {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    }
  };

  const handleCancel = () => {
    if (busy) {
      void transport.social_cancel_login();
    }
    setBusy(false);
    setProgress(null);
    onOpenChange?.(false);
  };

  const stage = progress?.stage;
  const label = describeStage(progress);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && handleCancel()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Sign in to vibe-social</DialogTitle>
          <DialogDescription>
            Publishing designs needs a vibe-social account. Sign in with your
            browser — Vibe never sees your password.
          </DialogDescription>
        </DialogHeader>

        {progress ? (
          <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm">
            <div className="flex items-center gap-2">
              {stage === "error" ? null : (
                <Loader2 className="size-4 animate-spin" />
              )}
              <span
                className={stage === "error" ? "text-destructive" : ""}
                role={stage === "error" ? "alert" : undefined}
              >
                {label}
              </span>
            </div>
            {stage === "awaiting_browser" && progress.url ? (
              <a
                href={progress.url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
              >
                <ExternalLink className="size-3.5" /> Didn't open? Open the
                sign-in page
              </a>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={handleCancel}>
            Cancel
          </Button>
          <Button onClick={() => void handleSignIn()} disabled={busy}>
            {busy
              ? "Signing in…"
              : stage === "error"
                ? "Try again"
                : "Sign in with Vibe"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
