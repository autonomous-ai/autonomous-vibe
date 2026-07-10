"use client";

import { useCallback, useEffect, useState } from "react";
import { BadgeCheck, LogIn } from "lucide-react";
import PublishSignInDialog from "@/components/project/PublishSignInDialog.jsx";
import { transport } from "@/lib/transport.ts";
import UserAvatar from "@/components/workbench/UserAvatar.jsx";
import PlanBadge from "@/components/workbench/PlanBadge.jsx";
import { activePlanLabel } from "@/components/workbench/subscription.js";

/**
 * Bottom-left account affordance for the Models sidebar.
 *
 * Signed out → a "Sign in" row. Signed in → the account row (avatar + name +
 * subscription badge); clicking it opens the full AccountScreen via
 * `onOpenAccountScreen`. Mirrors panda-website's sidebar user card: the real
 * `avatarUrl` (with an initials fallback) and a `PlanBadge` for the active tier.
 */
export default function SidebarUserCard({ onOpenAccountScreen }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [signInOpen, setSignInOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const u = await transport.social_current_user();
      setUser(u);
      if (u) {
        // The stored session has no avatar/plan (login only returns id/handle);
        // the profile does. Best-effort — the row still renders from `user`.
        try {
          setProfile(await transport.social_profile());
        } catch {
          setProfile(null);
        }
      } else {
        setProfile(null);
      }
    } catch {
      setUser(null);
      setProfile(null);
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

  const displayName =
    profile?.displayName || user?.displayName || profile?.username || user?.username || "";
  const username = profile?.username || user?.username || "";
  const planLabel = activePlanLabel(profile);
  const verified = profile?.verified;

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
      <UserAvatar
        url={profile?.avatarUrl}
        name={displayName}
        className="size-7 rounded-full ring-1 ring-sidebar-border"
        textClassName="text-[0.6rem]"
      />
      <span className="flex min-w-0 flex-col">
        <span className="flex items-center gap-1 truncate text-sm font-medium text-foreground">
          <span className="truncate">{displayName}</span>
          {verified ? (
            <BadgeCheck className="size-3 shrink-0 text-primary" aria-label="Verified" />
          ) : null}
          {planLabel ? <PlanBadge label={planLabel} /> : null}
        </span>
        {username ? (
          <span className="truncate text-xs text-muted-foreground">@{username}</span>
        ) : null}
      </span>
    </button>
  );
}