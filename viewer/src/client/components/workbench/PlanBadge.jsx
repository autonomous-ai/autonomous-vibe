"use client";

import { Crown } from "lucide-react";
import { cn } from "@/ui/utils";

/**
 * Small accent pill marking the account's active subscription tier (the
 * "subscribed type", e.g. a `Pro` badge). Mirrors panda-website's `PlanBadge`
 * (`src/modules/pricing/components/PlanBadge.tsx`). Render only when there's an
 * active plan — see `activePlanLabel` in `./subscription.js`.
 */
export default function PlanBadge({ label, className }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-primary",
        className,
      )}
    >
      <Crown className="size-3" aria-hidden="true" />
      {label}
    </span>
  );
}
