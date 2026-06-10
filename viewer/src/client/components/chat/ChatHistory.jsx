import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { cn } from "@/ui/utils";
import ChatTurn from "./ChatTurn";

// Group each user prompt with the assistant turns that answer it so related
// messages keep their spacing as a unit in the history.
function groupTurns(history) {
  const groups = [];
  for (const turn of history) {
    if (turn.role === "user" || groups.length === 0) {
      groups.push([turn]);
    } else {
      groups[groups.length - 1].push(turn);
    }
  }
  return groups;
}

export default function ChatHistory({
  history,
  onOpenArtifact,
  onRequestInputFocus,
  className,
}) {
  const ref = useRef(null);
  const seenUserTurnIdsRef = useRef(new Set());
  const [showBackToBottom, setShowBackToBottom] = useState(false);

  const updateBackToBottomVisibility = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    const hasLongHistory = node.scrollHeight > node.clientHeight + 48;
    const distanceFromBottom = node.scrollHeight - node.clientHeight - node.scrollTop;
    setShowBackToBottom(hasLongHistory && distanceFromBottom > 120);
  }, []);

  // Scroll to bottom when the user sends (or plan feedback arrives), not on stream deltas.
  useLayoutEffect(() => {
    let shouldScroll = false;
    for (const turn of history) {
      if (turn.role !== "user" || seenUserTurnIdsRef.current.has(turn.id)) continue;
      seenUserTurnIdsRef.current.add(turn.id);
      shouldScroll = true;
    }
    if (shouldScroll) {
      const node = ref.current;
      if (node) node.scrollTop = node.scrollHeight;
    }
  }, [history]);

  // Refresh the back-to-bottom affordance when content grows; never auto-scroll.
  useEffect(() => {
    updateBackToBottomVisibility();
  }, [history, updateBackToBottomVisibility]);

  const handleScroll = useCallback(() => {
    updateBackToBottomVisibility();
  }, [updateBackToBottomVisibility]);

  const handleBackToBottom = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    onRequestInputFocus?.();
  }, [onRequestInputFocus]);

  const groups = groupTurns(history);

  if (!history.length) {
    return (
      <div
        data-slot="chat-history-empty"
        className={cn(
          "flex h-full flex-col items-center justify-center gap-1 px-3.5 text-center text-xs text-muted-foreground",
          className,
        )}
      >
        <p>Describe what you want to print.</p>
        <p className="opacity-70">I'll draft a plan first — you can edit and approve it before I build.</p>
        <p className="opacity-70">Click a face on the model to refer to it in your message.</p>
      </div>
    );
  }

  return (
    <div className={cn("relative h-full", className)}>
      <div
        ref={ref}
        data-slot="chat-history"
        onScroll={handleScroll}
        className="scrollbar-thin flex h-full min-w-0 flex-col gap-3 overflow-y-auto px-3.5 py-3"
      >
        {groups.map((group) => (
          <div
            key={group[0].id}
            data-slot="chat-turn-group"
            className="flex min-w-0 shrink-0 flex-col gap-3"
          >
            {group.map((turn) => (
              <ChatTurn
                key={turn.id}
                turn={turn}
                onOpenArtifact={onOpenArtifact}
              />
            ))}
          </div>
        ))}
      </div>
      {showBackToBottom ? (
        <button
          type="button"
          data-slot="chat-back-to-bottom"
          aria-label="Back to bottom"
          onClick={handleBackToBottom}
          className="absolute bottom-3 left-1/2 z-30 inline-flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border/70 bg-background/90 text-muted-foreground shadow-lg backdrop-blur transition hover:translate-y-0.5 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
        >
          <ArrowDown className="size-4" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
