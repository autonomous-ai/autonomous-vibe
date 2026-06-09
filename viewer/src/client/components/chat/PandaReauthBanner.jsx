"use client";

import { useCallback, useRef, useState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { transport } from "@/lib/transport.ts";
import { clearPandaReauth, PANDA_REAUTH_MESSAGE, useChatStore } from "@/store/chat";
import {
  buildPandaLoginFlow,
  describePandaLoginProgress,
} from "@/components/onboarding/onboardingHelpers.js";

/**
 * Shown when a chat turn fails because the Panda proxy rejected auth
 * (revoked/expired key → BE 401 → `auth_expired` event sets `needsPandaReauth`).
 * Offers a one-click re-login that re-runs the browser sign-in; on success it
 * clears the banner and the user can resend their message.
 */
export default function PandaReauthBanner() {
  const needsReauth = useChatStore((s) => s.needsPandaReauth);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState("");
  const flowRef = useRef(null);

  const signInAgain = useCallback(() => {
    if (busy) return;
    setBusy(true);
    setError("");
    setProgress(null);
    const flow = buildPandaLoginFlow({
      runInstall: () => transport.app_panda_login(),
      subscribe: (handler) => transport.onPandaLoginProgress(handler),
      onChange: ({ progress: p }) => setProgress(p),
      onComplete: () => {},
    });
    flowRef.current = flow;
    void flow.start().then(() => {
      if (flow.state === "done") {
        clearPandaReauth();
      } else {
        setError(describePandaLoginProgress(flow.progress));
      }
      setBusy(false);
      setProgress(null);
    });
  }, [busy]);

  if (!needsReauth) return null;

  return (
    <div
      data-slot="panda-reauth-banner"
      className="flex flex-col gap-2 border-t border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
    >
      <div className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>{error || PANDA_REAUTH_MESSAGE}</span>
      </div>
      <div>
        <Button
          size="sm"
          onClick={() => signInAgain()}
          disabled={busy}
          data-testid="panda-reauth-signin"
        >
          {busy ? (
            <>
              <Loader2 className="mr-2 size-3.5 animate-spin" />
              {progress ? describePandaLoginProgress(progress) : "Signing in…"}
            </>
          ) : (
            "Sign in again"
          )}
        </Button>
      </div>
    </div>
  );
}
