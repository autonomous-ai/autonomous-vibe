import { transport } from "@/lib/transport.ts";
import { isUpgradeError, splitUpgradeCta } from "./upgradeError.js";

/**
 * Renders a chat error message. When the message signals a billing/subscription
 * problem, its call-to-action (e.g. "Subscribe to continue") is turned into a
 * highlighted, clickable link that opens the hosted plans/pricing page in the
 * system browser (the desktop app has no in-app checkout). Otherwise it renders
 * the message verbatim.
 */
export default function ChatErrorContent({ message }) {
  if (!isUpgradeError(message)) return <>{message}</>;
  const { before, cta, after } = splitUpgradeCta(message);
  return (
    <>
      {before}
      <button
        type="button"
        data-slot="chat-error-upgrade"
        className="font-semibold text-orange-500 underline underline-offset-2 hover:text-orange-600"
        onClick={() => void transport.social_open_pricing()}
      >
        {cta}
      </button>
      {after}
    </>
  );
}
