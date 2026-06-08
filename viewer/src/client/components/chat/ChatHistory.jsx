import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { cn } from "@/ui/utils";
import ChatTurn from "./ChatTurn";

// Group each user prompt with the assistant turns that answer it. The user
// prompt sticks within its group's container (see ChatTurn), so it pins only
// while its own response is on screen and scrolls away once the next group
// begins — instead of every prompt stacking at the top.
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
  className,
}) {
  const ref = useRef(null);
  const [showBackToBottom, setShowBackToBottom] = useState(false);

  const updateBackToBottomVisibility = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    const hasLongHistory = node.scrollHeight > node.clientHeight + 48;
    const distanceFromBottom = node.scrollHeight - node.clientHeight - node.scrollTop;
    setShowBackToBottom(hasLongHistory && distanceFromBottom > 120);
  }, []);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    updateBackToBottomVisibility();
  }, [history, updateBackToBottomVisibility]);

  const handleScroll = useCallback(() => {
    updateBackToBottomVisibility();
  }, [updateBackToBottomVisibility]);

  const handleBackToBottom = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, []);

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
        // No top padding: a sticky prompt pins to the scrollport's top edge, so
        // any top padding leaves a band where scrolled content shows above it.
        // The first group carries the top breathing room as a margin instead,
        // which scrolls away and doesn't offset the pin.
        className="scrollbar-thin flex h-full flex-col gap-3 overflow-y-auto px-3.5 pb-3"
      >
        {groups.map((group, index) => (
          <div
            key={group[0].id}
            data-slot="chat-turn-group"
            // The last group is at least a viewport tall so its (sticky) user
            // prompt can rest at the top with the streaming response filling the
            // space below — instead of the prompt landing at the bottom under the
            // previous turn. `shrink-0` keeps the spacer from collapsing in flex.
            className={cn(
              // `relative` anchors each user prompt's sticky sentinel (an
              // absolutely-positioned marker at the group's top, see ChatTurn) to
              // this group. It doesn't affect the sticky prompt's scroll
              // container (the outer overflow-y-auto div), only the sentinel.
              "relative flex shrink-0 flex-col gap-3",
              index === 0 && "mt-3",
              index === groups.length - 1 && "min-h-full",
            )}
          >
            {group.map((turn) => (
              <ChatTurn
                key={turn.id}
                turn={turn}
                onOpenArtifact={onOpenArtifact}
                scrollRootRef={ref}
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
