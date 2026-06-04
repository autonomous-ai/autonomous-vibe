import { useCallback, useEffect, useRef } from "react";
import { MessageSquare } from "lucide-react";
import { cn } from "@/ui/utils";
import { attachChatEventStream, restoreVersion, useChatStore } from "@/store/chat";
import ChatHistory from "./ChatHistory";
import ChatInput from "./ChatInput";
import ActionButtons from "./ActionButtons";

const SIDEBAR_WIDTH = 440;
const SIDEBAR_MIN_WIDTH = 320;
const SIDEBAR_MAX_WIDTH = 720;
const SIDEBAR_WIDTH_STORAGE_KEY = "panda.chatSidebar.width";

function clampSidebarWidth(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return SIDEBAR_WIDTH;
  }
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, numeric));
}

// Restore the persisted width so the panel keeps its size across launches.
function readStoredChatSidebarWidth() {
  if (typeof window === "undefined") {
    return SIDEBAR_WIDTH;
  }
  try {
    const stored = window.localStorage?.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (stored == null) {
      return SIDEBAR_WIDTH;
    }
    return clampSidebarWidth(Number.parseInt(stored, 10));
  } catch {
    return SIDEBAR_WIDTH;
  }
}

function persistChatSidebarWidth(width) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage?.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Ignore storage failures (private mode, quota) — width still applies live.
  }
}

// Chat is the primary surface of the app, so the panel is permanent — there's
// no collapse. The collapsible rail is the left "Models" sidebar instead. The
// panel is resizable from its left edge; the live width is lifted to the parent
// so the workspace's right padding tracks it.
export default function ChatSidebar({
  printerList = [],
  defaultFilament = "PLA",
  onOpenArtifact,
  width = SIDEBAR_WIDTH,
  onWidthChange,
  className,
}) {
  const lastError = useChatStore((state) => state.lastError);
  const history = useChatStore((state) => state.history);
  const projectId = useChatStore((state) => state.currentProjectId);
  const turnInProgress = useChatStore((state) => state.turnInProgress);

  const handleRestoreVersion = useCallback((checkpointId) => {
    void restoreVersion(checkpointId);
  }, []);

  const resizeStateRef = useRef(null);

  // Attach the chat_event stream once the sidebar mounts. The transport's
  // placeholder will throw if the real transport hasn't replaced it — we
  // swallow that error to keep the dev/browser preview usable.
  useEffect(() => {
    let detach;
    try {
      detach = attachChatEventStream();
    } catch (error) {
      if (import.meta?.env?.DEV) {
        // eslint-disable-next-line no-console
        console.info("[chat] transport not wired yet:", error);
      }
    }
    return () => {
      detach?.();
    };
  }, []);

  // Drag the left edge: the panel is anchored right, so a smaller clientX means
  // a wider panel. Pointer move/up listeners live on the window so the drag
  // keeps tracking even when the cursor leaves the thin handle.
  useEffect(() => {
    const handlePointerMove = (event) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState) {
        return;
      }
      const delta = resizeState.startX - event.clientX;
      const nextWidth = clampSidebarWidth(resizeState.startWidth + delta);
      resizeState.latestWidth = nextWidth;
      onWidthChange?.(nextWidth);
    };

    const endResize = () => {
      const resizeState = resizeStateRef.current;
      if (!resizeState) {
        return;
      }
      resizeStateRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      persistChatSidebarWidth(resizeState.latestWidth ?? resizeState.startWidth);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", endResize);
    window.addEventListener("pointercancel", endResize);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", endResize);
      window.removeEventListener("pointercancel", endResize);
    };
  }, [onWidthChange]);

  const handleResizeStart = useCallback(
    (event) => {
      event.preventDefault();
      resizeStateRef.current = {
        startX: event.clientX,
        startWidth: width,
        latestWidth: width,
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [width],
  );

  return (
    <aside
      data-slot="chat-sidebar"
      data-project-id={projectId || ""}
      className={cn(
        "pointer-events-auto fixed right-0 top-0 z-30 flex h-svh flex-col border-l border-border/60 bg-background/95 shadow-xl backdrop-blur",
        className,
      )}
      style={{ width }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat panel"
        data-slot="chat-sidebar-resize-handle"
        onPointerDown={handleResizeStart}
        className="absolute left-0 top-0 z-40 h-full w-1.5 -translate-x-1/2 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-primary/30"
      />

      <header className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <MessageSquare className="size-4 text-muted-foreground" aria-hidden />
        <span className="text-sm font-semibold tracking-tight">Chat</span>
      </header>

      <div className="min-h-0 flex-1">
        <ChatHistory
          history={history}
          onOpenArtifact={onOpenArtifact}
          onRestoreVersion={handleRestoreVersion}
          restoreDisabled={turnInProgress}
        />
      </div>

      {lastError ? (
        <div
          data-slot="chat-error-banner"
          className="border-t border-destructive/40 bg-destructive/10 px-3 py-1 text-xs text-destructive"
        >
          {lastError}
        </div>
      ) : null}

      <ActionButtons printerList={printerList} defaultFilament={defaultFilament} />
      <ChatInput />
    </aside>
  );
}

export {
  SIDEBAR_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  clampSidebarWidth,
  readStoredChatSidebarWidth,
};
