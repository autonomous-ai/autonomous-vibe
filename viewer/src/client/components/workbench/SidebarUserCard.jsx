"use client";

import { useCallback, useEffect, useState } from "react";
import { BadgeCheck, LogIn } from "lucide-react";
import PublishSignInDialog from "@/components/project/PublishSignInDialog.jsx";
import { transport } from "@/lib/transport.ts";

/** First letters for the avatar fallback. */
function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Bottom-left account affordance for the Models sidebar.
 *
 * Signed out → a "Sign in" row. Signed in → the account row (avatar + name);
 * clicking it opens the full AccountScreen via `onOpenAccountScreen`.
 */
export default function SidebarUserCard({ onOpenAccountScreen }) {
  const [user, setUser] = useState(null);
  const [signInOpen, setSignInOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const u = await transport.social_current_user();
      setUser(u);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Also listen for login progress so we pick up sign-ins from other entry points.
    let unsub;
    (async () => {
      unsub = await transport.onSocialLoginProgress((event) => {
        if (event.stage === "done") void refresh();
      });
    })();
    return () => unsub?.();
  }, [refresh]);

  const handleSignedIn = () => {
    setSignInOpen(false);
    void refresh();
  };

  const displayName = user?.displayName || user?.username || "";
  const username = user?.username || "";

  // ---- Signed out ---------------------------------------------------------
  if (!user) {
    return (
      <>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
          onClick={() => setSignInOpen(true)}
        >
          <LogIn className="size-4" aria-hidden="true" />
          Sign in to Panda
        </button>
        <PublishSignInDialog
          open={signInOpen}
          onOpenChange={setSignInOpen}
          onSignedIn={handleSignedIn}
        />
      </>
    );
  }

  // ---- Signed in ----------------------------------------------------------
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent"
      aria-label="Account"
      title="View your account"
      onClick={() => onOpenAccountScreen?.()}
    >
      {/* Avatar */}
      <span className="flex shrink-0 items-center justify-center rounded-full bg-primary/15 text-[0.6rem] font-semibold uppercase text-primary ring-1 ring-sidebar-border size-7">
        {initials(displayName)}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="flex items-center gap-1 truncate text-sm font-medium text-foreground">
          {displayName}
          {user?.verified ? (
            <BadgeCheck className="size-3 shrink-0 text-primary" aria-label="Verified" />
          ) : null}
        </span>
        {username ? (
          <span className="truncate text-xs text-muted-foreground">@{username}</span>
        ) : null}
      </span>
    </button>
  );
}