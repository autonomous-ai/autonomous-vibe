"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, BadgeCheck, Boxes, Loader2, LogIn, LogOut, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { transport } from "@/lib/transport.ts";
import { cn } from "@/ui/utils";
import PublishSignInDialog from "@/components/project/PublishSignInDialog.jsx";

/** First letters for the avatar fallback. */
function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Large round avatar with initials fallback. */
function LargeAvatar({ profile, user }) {
  const url = profile?.avatarUrl;
  const label = profile?.displayName || user?.displayName || user?.username || "";
  if (url) {
    return (
      <img
        src={url}
        alt={label}
        className="size-20 rounded-full object-cover ring-4 ring-sidebar-border/50"
      />
    );
  }
  return (
    <div className="flex size-20 items-center justify-center rounded-full bg-primary/15 text-2xl font-bold uppercase text-primary ring-4 ring-sidebar-border/50">
      {initials(label)}
    </div>
  );
}

/** Compact stat cell. */
function StatCell({ value, label, icon: Icon }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card/50 px-4 py-3">
      {Icon && <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />}
      <div className="flex flex-col">
        <span className="text-lg font-semibold text-foreground">{value ?? 0}</span>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
    </div>
  );
}

/** One model card in the grid. */
function ModelCard({ model }) {
  return (
    <div
      className="group relative overflow-hidden rounded-lg border border-border bg-card/50 transition-shadow hover:shadow-lg"
      title={model.title || model.slug || "Untitled"}
    >
      <div className="relative aspect-square w-full bg-muted">
        {model.thumbnailUrl ? (
          <img
            src={model.thumbnailUrl}
            alt={model.title || "Model"}
            className="size-full object-cover transition-transform group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground/40">
            <Boxes className="size-10" aria-hidden="true" />
          </div>
        )}
        {/* Status badge */}
        {model.status ? (
          <span
            className={cn(
              "absolute right-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide backdrop-blur-sm",
              model.status === "public"
                ? "bg-emerald-500/20 text-emerald-400"
                : "bg-yellow-500/20 text-yellow-400",
            )}
          >
            {model.status}
          </span>
        ) : null}
      </div>
      <div className="px-3 pb-3 pt-2">
        <p className="truncate text-sm font-medium text-foreground">
          {model.title || "Untitled"}
        </p>
        {model.slug ? (
          <p className="truncate text-xs text-muted-foreground">@{model.slug}</p>
        ) : null}
      </div>
    </div>
  );
}

/** Skeleton card for loading state. */
function SkeletonCard() {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card/30 animate-pulse">
      <div className="aspect-square w-full bg-muted" />
      <div className="px-3 pb-3 pt-2 space-y-1.5">
        <div className="h-3.5 w-3/4 rounded bg-muted" />
        <div className="h-3 w-1/2 rounded bg-muted" />
      </div>
    </div>
  );
}

/**
 * Full-screen account overlay. Shown on top of the 3D viewer when the user
 * clicks their avatar in the sidebar. Displays profile info, creator stats,
 * and a grid of their models from panda-social.
 */
export default function AccountScreen({ open, onOpenChange, onSignOut }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [models, setModels] = useState([]);
  const [modelsState, setModelsState] = useState("idle");
  const [signInOpen, setSignInOpen] = useState(false);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const unsubRef = useRef(null);

  // Listen for login progress so we can refresh after a sign-in.
  useEffect(() => {
    if (!open) return;
    (async () => {
      if (unsubRef.current) unsubRef.current();
      unsubRef.current = await transport.onSocialLoginProgress((event) => {
        if (event.stage === "done") {
          void refresh();
        }
      });
    })();
    return () => {
      unsubRef.current?.();
      unsubRef.current = null;
    };
  }, [open]);

  const loadProfile = useCallback(async () => {
    setLoadingProfile(true);
    try {
      const p = await transport.social_profile();
      setProfile(p ?? null);
    } catch {
      setProfile(null);
    } finally {
      setLoadingProfile(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const u = await transport.social_current_user();
      setUser(u);
      if (u) void loadProfile();
      else setProfile(null);
    } catch {
      setUser(null);
      setProfile(null);
    }
  }, [loadProfile]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

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

  useEffect(() => {
    if (open) void loadModels();
  }, [open, loadModels]);

  const handleSignedIn = async () => {
    setSignInOpen(false);
    void refresh();
    void loadModels();
  };

  const handleSignOut = async () => {
    try {
      await transport.social_logout();
    } catch {
      /* best-effort */
    }
    setUser(null);
    setProfile(null);
    setModels([]);
    setModelsState("idle");
    onSignOut?.();
    onOpenChange?.(false);
  };

  if (!open) return null;

  // ---- Not signed in ------------------------------------------------------
  if (!user) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 bg-background/80 backdrop-blur-sm">
        <User className="size-16 text-muted-foreground/40" aria-hidden="true" />
        <div className="flex flex-col items-center gap-2">
          <h2 className="text-xl font-semibold text-foreground">Sign in to Panda</h2>
          <p className="max-w-xs text-center text-sm text-muted-foreground">
            Sign in to view your profile, models, and creator stats on panda-social.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="ghost" onClick={() => onOpenChange?.(false)}>
            <ArrowLeft className="mr-1.5 size-4" aria-hidden="true" />
            Back
          </Button>
          <Button onClick={() => setSignInOpen(true)}>
            <LogIn className="mr-2 size-4" aria-hidden="true" />
            Sign in
          </Button>
        </div>
        <PublishSignInDialog
          open={signInOpen}
          onOpenChange={setSignInOpen}
          onSignedIn={handleSignedIn}
        />
      </div>
    );
  }

  // ---- Signed in ----------------------------------------------------------
  const displayName = profile?.displayName || user?.displayName || user?.username || "";
  const username = profile?.username || user?.username || "";

  return (
    <div className="flex h-full flex-col bg-background/80 backdrop-blur-sm">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-6 py-4">
        <button
          type="button"
          onClick={() => onOpenChange?.(false)}
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back
        </button>
        <h1 className="text-lg font-semibold text-foreground">Your Account</h1>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-4xl p-6">
          {/* Profile card */}
          <div className="mb-8 flex flex-col gap-6 rounded-xl border border-border bg-card/50 p-6 sm:flex-row sm:items-center sm:gap-8">
            <LargeAvatar profile={profile} user={user} />
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <h2 className="text-2xl font-bold text-foreground">
                  {displayName || username}
                </h2>
                {profile?.verified ? (
                  <BadgeCheck className="size-5 text-primary" aria-label="Verified" />
                ) : null}
              </div>
              {username ? (
                <p className="text-sm text-muted-foreground">@{username}</p>
              ) : null}
              {profile?.email ? (
                <p className="text-sm text-muted-foreground">{profile.email}</p>
              ) : null}
              {profile?.bio ? (
                <p className="mt-2 text-sm text-foreground">{profile.bio}</p>
              ) : null}
            </div>
          </div>

          {/* Stats row */}
          {loadingProfile ? (
            <div className="mb-8 grid gap-3 grid-cols-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-16 rounded-lg border border-border bg-card/30 animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="mb-8 grid gap-3 grid-cols-3">
              <StatCell value={profile?.modelCount} label="Models" icon={Boxes} />
              <StatCell value={profile?.followerCount} label="Followers" icon={User} />
              <StatCell value={profile?.followingCount} label="Following" icon={User} />
            </div>
          )}

          {/* Models grid */}
          <div className="flex items-center gap-2 mb-4">
            <Boxes className="size-5 text-muted-foreground" aria-hidden="true" />
            <h3 className="text-lg font-semibold text-foreground">Your Models</h3>
            {modelsState === "done" && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {models.length}
              </span>
            )}
          </div>

          {modelsState === "loading" ? (
            <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <SkeletonCard key={i} />
              ))}
            </div>
          ) : modelsState === "error" ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <Boxes className="size-8 text-muted-foreground/40" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">Couldn't load your models.</p>
              <Button variant="outline" onClick={() => void loadModels()}>
                Try again
              </Button>
            </div>
          ) : models.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <Boxes className="size-8 text-muted-foreground/40" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">
                No models yet. Your published designs will appear here.
              </p>
            </div>
          ) : (
            <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
              {models.map((m) => (
                <ModelCard key={m.id} model={m} />
              ))}
            </div>
          )}

          {/* Sign out */}
          <div className="mt-12 border-t border-border pt-6">
            <Button
              type="button"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => void handleSignOut()}
            >
              <LogOut className="mr-2 size-4" aria-hidden="true" />
              Sign out
            </Button>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}