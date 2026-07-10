// Detection for chat errors the user can resolve by upgrading their plan or
// topping up credit. Kept free of JSX/transport imports so it can be unit
// tested under the plain-Node test runner; the React surface lives in
// ChatErrorContent.jsx.

// Substrings that mark a chat error as a billing / plan problem — either the
// hosted proxy's `subscription_required` payload or a running-low-on-credit
// message. Matched case-insensitively and as substrings so a payload wrapped
// in a longer driver string (e.g. "claude produced no response: {...}") still
// trips.
const UPGRADE_PATTERNS = [
  "subscription_required",
  "paid subscription",
  "subscribe to continue",
  "insufficient credit",
  "insufficient_credit",
  "insufficient balance",
  "insufficient_balance",
  "out of credit",
  "not enough credit",
  "payment_required",
  "quota exceeded",
];

// Call-to-action phrases to turn into the clickable "Subscribe" link, tried in
// order. The first one found inside the message is linkified in place so we
// don't render a duplicate after a message that already ends with it (e.g.
// "API Error: 402 A paid subscription is required… Subscribe to continue.").
const CTA_PHRASES = [
  "Subscribe to continue",
  "Subscribe now",
  "Subscribe",
  "Upgrade to continue",
  "Upgrade now",
  "Upgrade",
];

/** True when an error message signals a subscription/credit problem. */
export function isUpgradeError(message) {
  const text = String(message || "").toLowerCase();
  return UPGRADE_PATTERNS.some((pattern) => text.includes(pattern));
}

/**
 * Pull the human-facing sentence out of an upgrade error. The driver may wrap
 * a JSON payload — e.g.
 * `{"error":"subscription_required","message":"A paid subscription is required..."}` —
 * inside a longer string; unwrap it to the `message` field when present, else
 * return the trimmed original.
 */
export function upgradeErrorMessage(message) {
  const raw = String(message || "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      const msg =
        parsed && typeof parsed.message === "string" ? parsed.message.trim() : "";
      if (msg) return msg;
    } catch {
      // Not JSON — fall through to the raw string.
    }
  }
  return raw.trim();
}

/**
 * Split an upgrade error's display text around its call-to-action so the CTA
 * can be rendered as a clickable link. Returns `{ before, cta, after }`. When
 * the message already contains a CTA phrase (e.g. "…Subscribe to continue.")
 * it is linkified in place; otherwise a "Subscribe to continue" link is
 * appended after the message.
 */
export function splitUpgradeCta(message) {
  const text = upgradeErrorMessage(message);
  const lower = text.toLowerCase();
  for (const phrase of CTA_PHRASES) {
    const idx = lower.indexOf(phrase.toLowerCase());
    if (idx !== -1) {
      return {
        before: text.slice(0, idx),
        cta: text.slice(idx, idx + phrase.length),
        after: text.slice(idx + phrase.length),
      };
    }
  }
  const sep = text && !/\s$/.test(text) ? " " : "";
  return { before: text + sep, cta: "Subscribe to continue", after: "" };
}
