"use client";

import { useState } from "react";
import { cn } from "@/ui/utils";

/** First letters for the avatar fallback. */
export function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Account avatar — renders the CDN `url` (the profile's `avatarUrl`) and falls
 * back to initials when it's absent or fails to load. Mirrors panda-website's
 * `Avatar` (`src/components/ui/avatar.tsx`), which the desktop app previously
 * lacked: the sidebar only ever showed initials, and the account screen showed
 * a broken-image glyph when a stored avatar URL 404'd.
 *
 * `className` sizes/shapes both the image and the fallback (e.g. size + rounded
 * + ring); `textClassName` sizes the initials glyph.
 */
export default function UserAvatar({ url, name, className, textClassName }) {
  const [failed, setFailed] = useState(false);

  if (url && !failed) {
    return (
      <img
        src={url}
        alt={name || ""}
        onError={() => setFailed(true)}
        className={cn("shrink-0 object-cover", className)}
      />
    );
  }

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center bg-primary/15 font-semibold uppercase text-primary",
        className,
        textClassName,
      )}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}
