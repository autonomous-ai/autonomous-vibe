/**
 * Subscription helpers — mirrors panda-website's
 * `src/modules/pricing/helpers/subscription.ts` so the desktop account panel
 * badges the "subscribed type" the same way the website does. The plan/status
 * come from `social_profile()`'s `plan` / `planStatus` (mapped in Rust from the
 * backend's `GET /profile` → `subscription.{plan,status}`).
 */

/** Statuses we treat as "the user currently has this plan" (mirrors the site). */
const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

/** True when the profile's subscription entitles the user to its plan right now. */
export function isPlanActive(profile) {
  const status = profile?.planStatus;
  const plan = profile?.plan;
  return Boolean(plan) && ACTIVE_STATUSES.has(status);
}

/** Human label for a plan key, e.g. `pro` → `Pro`. Mirrors `planDisplayName`. */
export function planDisplayName(planKey) {
  return planKey ? planKey.charAt(0).toUpperCase() + planKey.slice(1) : "";
}

/** The badge label for an active subscription, or `null` when there's none. */
export function activePlanLabel(profile) {
  return isPlanActive(profile) ? planDisplayName(profile.plan) : null;
}

/**
 * The plan label to always show for the account (never null): the active tier,
 * or "Free" when the account has no active subscription. Use where the plan is
 * shown as an explicit field rather than an accent badge.
 */
export function planLabelOrFree(profile) {
  return activePlanLabel(profile) ?? "Free";
}

/**
 * True when the account is on the free tier — no active PAID subscription. Backs
 * the "Upgrade" affordance (free users see it; Pro/Studio users don't).
 */
export function isFreePlan(profile) {
  return planLabelOrFree(profile).toLowerCase() === "free";
}
