import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import { cn } from "@/ui/utils";
import ChatTurn from "./ChatTurn";
import { groupTurns } from "./chatHistoryModel";

const GROUP_GAP = 12;
const GROUP_ESTIMATE_HEIGHT = 220;
const BACK_TO_BOTTOM_THRESHOLD = 120;
// Resuming auto-follow requires the viewport to sit at the *true* bottom, not
// merely within the (generous) back-to-bottom band. Otherwise a small scroll-up
// during streaming gets silently re-pinned and the next delta yanks the user
// back down — the up/down jitter we're guarding against.
const AT_BOTTOM_EPSILON = 8;

export { groupTurns } from "./chatHistoryModel";

export default function ChatHistory({
  history,
  onOpenArtifact,
  onRequestInputFocus,
  className,
}) {
  const scrollRef = useRef(null);
  const seenUserTurnIdsRef = useRef(new Set());
  const pinnedToBottomRef = useRef(false);
  const userDetachedRef = useRef(false);
  const programmaticScrollRef = useRef(false);
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

  const readScrollPin = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return { pinned: false, showBackToBottom: false };
    const hasLongHistory = node.scrollHeight > node.clientHeight + 48;
    const distanceFromBottom = node.scrollHeight - node.clientHeight - node.scrollTop;
    const pinned = !hasLongHistory || distanceFromBottom <= BACK_TO_BOTTOM_THRESHOLD;
    const atBottom = !hasLongHistory || distanceFromBottom <= AT_BOTTOM_EPSILON;
    return {
      pinned,
      atBottom,
      showBackToBottom: hasLongHistory && distanceFromBottom > BACK_TO_BOTTOM_THRESHOLD,
    };
  }, []);

  const applyScrollPin = useCallback((pinned) => {
    pinnedToBottomRef.current = pinned;
    if (!pinned) {
      userDetachedRef.current = true;
    }
  }, []);

  const resumeAutoFollow = useCallback(() => {
    userDetachedRef.current = false;
    pinnedToBottomRef.current = true;
  }, []);

  const updateBackToBottomVisibility = useCallback(() => {
    const { pinned, atBottom, showBackToBottom: show } = readScrollPin();
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false;
      pinnedToBottomRef.current = pinned;
      if (pinned) {
        userDetachedRef.current = false;
      }
      setShowBackToBottom(show);
      return;
    }

    pinnedToBottomRef.current = pinned;
    // Only a user scroll that reaches the true bottom re-arms auto-follow.
    // Within the back-to-bottom band but above the bottom we leave the detach
    // flag untouched: a scroll-up mid-stream must stay detached so the next
    // delta can't force the viewport back down (the up/down race). Detach only
    // hardens further when the user is clearly away from the bottom.
    if (atBottom) {
      userDetachedRef.current = false;
    } else if (!pinned) {
      userDetachedRef.current = true;
    }
    setShowBackToBottom(show);
  }, [readScrollPin]);

  const scrollToBottom = useCallback((behavior = "auto", { force = false } = {}) => {
    if (!force) {
      if (userDetachedRef.current) return;
      const { pinned } = readScrollPin();
      if (!pinned) return;
    }
    const count = groupCountRef.current;
    if (count === 0) return;
    programmaticScrollRef.current = true;
    virtualizerRef.current.scrollToIndex(count - 1, {
      align: "end",
      behavior,
    });
  }, [readScrollPin]);

  const totalSize = virtualizer.getTotalSize();

  // Scroll to bottom when the user sends (or plan feedback arrives). During
  // streaming, follow new content only while the viewport is already pinned
  // to the bottom — never yank the user down if they've scrolled up.
  useLayoutEffect(() => {
    let shouldScrollForUserTurn = false;
    for (const turn of history) {
      if (turn.role !== "user" || seenUserTurnIdsRef.current.has(turn.id)) continue;
      seenUserTurnIdsRef.current.add(turn.id);
      shouldScrollForUserTurn = true;
    }
    if (shouldScrollForUserTurn) {
      resumeAutoFollow();
      scrollToBottom("auto", { force: true });
      return;
    }
    if (userDetachedRef.current) return;
    const { pinned } = readScrollPin();
    if (!pinned) {
      applyScrollPin(false);
      return;
    }
    scrollToBottom("auto");
  }, [
    applyScrollPin,
    history,
    readScrollPin,
    resumeAutoFollow,
    scrollToBottom,
    totalSize,
    virtualizer.range,
  ]);

  // Keep the back-to-bottom affordance in sync as virtual row heights change.
  useEffect(() => {
    updateBackToBottomVisibility();
  }, [history, virtualizer.range, updateBackToBottomVisibility]);

  const handleScroll = useCallback(() => {
    updateBackToBottomVisibility();
  }, [updateBackToBottomVisibility]);

  const handleBackToBottom = useCallback(() => {
    resumeAutoFollow();
    scrollToBottom("smooth", { force: true });
    onRequestInputFocus?.();
  }, [onRequestInputFocus, resumeAutoFollow, scrollToBottom]);

  // Detach before the scroll position updates so a concurrent stream delta
  // cannot win the layout-effect race and flash the viewport back down.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    const detachAutoFollow = () => {
      userDetachedRef.current = true;
      pinnedToBottomRef.current = false;
    };

    const onWheel = (event) => {
      if (event.deltaY < 0) detachAutoFollow();
    };

    let touchStartY = 0;
    const onTouchStart = (event) => {
      touchStartY = event.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (event) => {
      const clientY = event.touches[0]?.clientY ?? touchStartY;
      if (clientY > touchStartY + 2) detachAutoFollow();
    };

    node.addEventListener("wheel", onWheel, { passive: true });
    node.addEventListener("touchstart", onTouchStart, { passive: true });
    node.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("touchstart", onTouchStart);
      node.removeEventListener("touchmove", onTouchMove);
    };
  }, [history.length]);

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
          style={{ height: totalSize }}
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
