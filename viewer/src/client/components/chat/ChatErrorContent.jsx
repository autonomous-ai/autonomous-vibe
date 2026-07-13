import { transport } from "@/lib/transport.ts";
import { isUpgradeError, splitUpgradeCta } from "./upgradeError.js";
import { isClaudeMissingError, openClaudeSetup } from "@/store/claudeSetup.js";

/**
 * Renders a chat error message. When the message signals a billing/subscription
 * problem, its call-to-action (e.g. "Subscribe to continue") is turned into a
 * highlighted, clickable link that opens the hosted plans/pricing page in the
 * system browser (the desktop app has no in-app checkout). A missing-`claude`
 * error gets a "Set it up for me" action that opens the in-app installer
 * dialog. Otherwise it renders the message verbatim.
 */
export default function ChatErrorContent({ message }) {
  if (isClaudeMissingError(message)) {
    return (
      <>
        Claude Code isn’t set up on this computer yet.{" "}
        <button
          type="button"
          data-slot="chat-error-claude-setup"
          className="font-semibold text-orange-500 underline underline-offset-2 hover:text-orange-600"
          onClick={() => openClaudeSetup()}
        >
          Set it up for me
        </button>
      </>
    );
  }
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
