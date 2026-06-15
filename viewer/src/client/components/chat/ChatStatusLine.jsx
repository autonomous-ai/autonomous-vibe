import { ArrowUp } from "lucide-react";
import { cn } from "@/ui/utils";
import { useChatStore, selectAwaitingAnswerProjectIds, awaitingNeedsUser } from "@/store/chat";
import { useAutopilot } from "@/lib/autopilot";

// Scroll the most recent unanswered question / proposed-plan card into view, so
// the "Waiting for your answer ↑" affordance lands the user on the thing to act
// on (the cards sit in the scrollback, often just above the composer).
function scrollToAwaitingCard() {
  if (typeof document === "undefined") return;
  const nodes = document.querySelectorAll(
    '[data-slot="chat-questions"], [data-slot="chat-plan"][data-status="proposed"]',
  );
  const last = nodes[nodes.length - 1];
  last?.scrollIntoView({ behavior: "smooth", block: "center" });
}

/**
 * A line just above the composer that flags when the active project is blocked
 * on the user — the one state the chat didn't already make obvious. (The
 * "working" state is left to the turn header's PLANNING/Building badge + the
 * inline reasoning/Activity lanes, so this doesn't duplicate it.)
 *
 *  - waiting: "Waiting for your answer / approval ↑", clickable to jump to the
 *    card. Autopilot-aware via `awaitingNeedsUser` — under autopilot a proposed
 *    plan auto-builds, so only questions surface as a wait.
 *  - otherwise: renders nothing.
 */
export default function ChatStatusLine() {
  const turnInProgress = useChatStore((s) => s.turnInProgress);
  const currentProjectId = useChatStore((s) => s.currentProjectId);
  const awaitingMap = useChatStore(selectAwaitingAnswerProjectIds);
  const autopilot = useAutopilot();

  const reason = awaitingMap[currentProjectId];
  if (turnInProgress || !awaitingNeedsUser(reason, autopilot)) return null;

  const label = reason === "questions" ? "Waiting for your answer" : "Waiting for your approval";
  return (
    <button
      type="button"
      data-slot="chat-status-line"
      data-state="waiting"
      onClick={scrollToAwaitingCard}
      title="Jump to what needs your input"
      className={cn(
        "flex w-full items-center gap-2 px-4 pb-1 pt-1.5 text-left text-xs font-medium",
        "text-amber-600 transition-colors hover:text-amber-500 dark:text-amber-400",
      )}
    >
      <span className="relative flex size-2 shrink-0" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500 opacity-60" />
        <span className="relative inline-flex size-2 rounded-full bg-amber-500" />
      </span>
      <span>{label}</span>
      <ArrowUp className="size-3.5 shrink-0" aria-hidden />
    </button>
  );
}
