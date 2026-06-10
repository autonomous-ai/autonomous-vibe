import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import { cn } from "@/ui/utils";
import ChatTurn from "./ChatTurn";
import { groupTurns } from "./chatHistoryModel";

const GROUP_GAP = 12;
const GROUP_ESTIMATE_HEIGHT = 220;
const BACK_TO_BOTTOM_THRESHOLD = 120;

export { groupTurns } from "./chatHistoryModel";

export default function ChatHistory({
  history,
  onOpenArtifact,
  onRequestInputFocus,
  className,
}) {
  const scrollRef = useRef(null);
  const seenUserTurnIdsRef = useRef(new Set());
  const [showBackToBottom, setShowBackToBottom] = useState(false);

  const groups = useMemo(() => groupTurns(history), [history]);

  const virtualizer = useVirtualizer({
    count: groups.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => GROUP_ESTIMATE_HEIGHT,
    overscan: 4,
    gap: GROUP_GAP,
    getItemKey: (index) => groups[index]?.[0]?.id ?? index,
  });
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;
  const groupCountRef = useRef(groups.length);
  groupCountRef.current = groups.length;

  const updateBackToBottomVisibility = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const hasLongHistory = node.scrollHeight > node.clientHeight + 48;
    const distanceFromBottom = node.scrollHeight - node.clientHeight - node.scrollTop;
    setShowBackToBottom(hasLongHistory && distanceFromBottom > BACK_TO_BOTTOM_THRESHOLD);
  }, []);

  const scrollToBottom = useCallback((behavior = "auto") => {
    const count = groupCountRef.current;
    if (count === 0) return;
    virtualizerRef.current.scrollToIndex(count - 1, {
      align: "end",
      behavior,
    });
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
      scrollToBottom("auto");
    }
  }, [history, scrollToBottom]);

  // Keep the back-to-bottom affordance in sync as virtual row heights change.
  useEffect(() => {
    updateBackToBottomVisibility();
  }, [history, virtualizer.range, updateBackToBottomVisibility]);

  const handleScroll = useCallback(() => {
    updateBackToBottomVisibility();
  }, [updateBackToBottomVisibility]);

  const handleBackToBottom = useCallback(() => {
    scrollToBottom("smooth");
    onRequestInputFocus?.();
  }, [onRequestInputFocus, scrollToBottom]);

  const virtualItems = virtualizer.getVirtualItems();

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
        ref={scrollRef}
        data-slot="chat-history"
        onScroll={handleScroll}
        className="scrollbar-thin h-full min-w-0 overflow-y-auto px-3.5 py-3"
      >
        <div
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualItems.map((virtualItem) => {
            const group = groups[virtualItem.index];
            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                data-slot="chat-turn-group"
                className="absolute top-0 left-0 flex w-full min-w-0 flex-col gap-3"
                style={{ transform: `translateY(${virtualItem.start}px)` }}
              >
                {group.map((turn) => (
                  <ChatTurn
                    key={turn.id}
                    turn={turn}
                    onOpenArtifact={onOpenArtifact}
                  />
                ))}
              </div>
            );
          })}
        </div>
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
