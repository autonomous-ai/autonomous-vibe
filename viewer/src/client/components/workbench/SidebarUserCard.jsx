"use client";

import { useCallback, useEffect, useState } from "react";
import { LogIn, LogOut, BadgeCheck, Boxes, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import PublishSignInDialog from "@/components/project/PublishSignInDialog.jsx";
import { transport } from "@/lib/transport.ts";
import { cn } from "@/ui/utils";

/** First letters of the display name / username, for the avatar fallback. */
function initials(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Round avatar: the profile image if we have one, else colored initials. */
function Avatar({ profile, user, className }) {
  const url = profile?.avatarUrl;
  const label = profile?.displayName || user?.displayName || user?.username || "";
  if (url) {
    return (
      <img
        src={url}
        alt={label}
        className={cn(
          "shrink-0 rounded-full object-cover ring-1 ring-sidebar-border",
          className,
        )}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-primary/15 text-[0.65rem] font-semibold uppercase text-primary ring-1 ring-sidebar-border",
        className,
      )}
    >
      {initials(label)}
    </span>
  );
}

/** Compact "N label" stat cell shown in the account panel. */
function Stat({ value, label }) {
  return (
    <div className="flex flex-col items-center rounded-md px-2 py-1">
      <span className="text-sm font-semibold text-foreground">{value ?? 0}</span>
      <span className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

/**
 * Bottom-left account affordance for the Models sidebar.
 *
 * Signed out → a "Sign in" row that opens the panda-social browser OAuth flow
 * (`PublishSignInDialog`). Signed in → the account row (avatar + name); clicking
 * it opens a popover with the full profile (from `social_profile`), the user's
 * models (from `social_my_models`), and a sign-out action.
 */
export default function SidebarUserCard() {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [models, setModels] = useState([]);
  const [modelsState, setModelsState] = useState("idle"); // idle | loading | done | error
  const [signInOpen, setSignInOpen] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);

  const loadProfile = useCallback(async () => {
    try {
      const p = await transport.social_profile();
      setProfile(p ?? null);
    } catch {
      // Offline / browser dev mode / expired session — fall back to the
      // cached user for the row; the popover still works with what we have.
      setProfile(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    let current = null;
    try {
      current = await transport.social_current_user();
    } catch {
      current = null;
    }
    setUser(current);
    if (current) {
      void loadProfile();
    } else {
      setProfile(null);
      setModels([]);
      setModelsState("idle");
    }
  }, [loadProfile]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadModels = useCallback(async () => {
    setModelsState("loading");
    try {
      const list = await transport.social_my_models();
      setModels(Array.isArray(list) ? list : []);
      setModelsState("done");
    } catch {
      setModels([]);
      setModelsState("error");
    }
  }, []);

  const handleOpenChange = (next) => {
    setPopoverOpen(next);
    if (next) {
      // Refresh profile + models each time the panel opens so counts stay live.
      void loadProfile();
      void loadModels();
    }
  };

  const handleSignedIn = () => {
    void refresh();
  };

  const handleSignOut = async () => {
    try {
      await transport.social_logout();
    } catch {
      /* ignore — clearing the local session is best-effort */
    }
    setPopoverOpen(false);
    setUser(null);
    setProfile(null);
    setModels([]);
    setModelsState("idle");
  };

  const displayName =
    profile?.displayName || user?.displayName || user?.username || "";
  const username = profile?.username || user?.username || "";

  // ---- Signed out ---------------------------------------------------------
  if (!user) {
    return (
      <>
        <Button
          type="button"
          variant="ghost"
          className="h-9 w-full justify-start gap-2 px-2 text-sm text-muted-foreground hover:text-foreground"
          onClick={() => setSignInOpen(true)}
        >
          <LogIn className="size-4" aria-hidden="true" />
          Sign in to Panda
        </Button>
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
    <Popover open={popoverOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent"
          aria-label="Account"
          title="Account"
        >
          <Avatar profile={profile} user={user} className="size-7" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-foreground">
              {displayName || username}
            </span>
            {username ? (
              <span className="truncate text-xs text-muted-foreground">
                @{username}
              </span>
            ) : null}
          </span>
        </button>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-72 p-0"
      >
        {/* Identity header */}
        <div className="flex items-center gap-3 border-b border-border p-4">
          <Avatar profile={profile} user={user} className="size-11" />
          <div className="flex min-w-0 flex-col">
            <span className="flex items-center gap-1 truncate text-sm font-semibold text-foreground">
              {displayName || username}
              {profile?.verified ? (
                <BadgeCheck className="size-3.5 shrink-0 text-primary" aria-label="Verified" />
              ) : null}
            </span>
            {username ? (
              <span className="truncate text-xs text-muted-foreground">
                @{username}
              </span>
            ) : null}
            {profile?.email ? (
              <span className="truncate text-xs text-muted-foreground">
                {profile.email}
              </span>
            ) : null}
          </div>
        </div>

        {/* Creator stats */}
        <div className="grid grid-cols-3 gap-1 border-b border-border p-2">
          <Stat value={profile?.modelCount} label="Models" />
          <Stat value={profile?.followerCount} label="Followers" />
          <Stat value={profile?.followingCount} label="Following" />
        </div>

        {/* Their models */}
        <div className="p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Boxes className="size-3.5" aria-hidden="true" />
            Your models
          </div>
          {modelsState === "loading" ? (
            <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : modelsState === "error" ? (
            <p className="py-3 text-center text-xs text-muted-foreground">
              Couldn't load your models.
            </p>
          ) : models.length === 0 ? (
            <p className="py-3 text-center text-xs text-muted-foreground">
              No models yet.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {models.map((m) => (
                <div
                  key={m.id}
                  className="group relative aspect-square overflow-hidden rounded-md border border-border bg-muted"
                  title={m.title || m.slug || "Untitled"}
                >
                  {m.thumbnailUrl ? (
                    <img
                      src={m.thumbnailUrl}
                      alt={m.title || "Model"}
                      className="size-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex size-full items-center justify-center text-muted-foreground">
                      <Boxes className="size-5" aria-hidden="true" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Sign out */}
        <div className="border-t border-border p-2">
          <Button
            type="button"
            variant="ghost"
            className="h-8 w-full justify-start gap-2 px-2 text-sm text-muted-foreground hover:text-destructive"
            onClick={() => void handleSignOut()}
          >
            <LogOut className="size-4" aria-hidden="true" />
            Sign out
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
