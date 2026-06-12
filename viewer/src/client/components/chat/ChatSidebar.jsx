import { useCallback, useEffect, useRef } from "react";
import { cn } from "@/ui/utils";
import { attachChatEventStream, useChatStore } from "@/store/chat";
import { useProjectsStore } from "@/store/projects.ts";
import { CHAT_MIN_WIDTH, clampChatWidth } from "@/workbench/chatLayout";
import ChatHistory from "./ChatHistory";
import ChatInput from "./ChatInput";
import { FOCUS_CHAT_INPUT_EVENT } from "./chatInputHelpers";
// import ActionButtons from "./ActionButtons";
import AuthModeControl from "./AuthModeControl";
import PandaReauthBanner from "./PandaReauthBanner";
import { MessageSquare } from "lucide-react";

const SIDEBAR_WIDTH = 440;
const SIDEBAR_WIDTH_STORAGE_KEY = "panda.chatSidebar.width";

// Clamp a stored width to the readable minimum only. The dynamic upper bound
// (a fraction of the viewport, minus the space the model viewer and open side
// panels need) depends on live layout, so AppRoot applies it once it knows the
// viewport — see workbench/chatLayout.js and main.jsx.
function clampStoredWidth(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return SIDEBAR_WIDTH;
  }
  return Math.max(CHAT_MIN_WIDTH, Math.round(numeric));
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
    return clampStoredWidth(Number.parseInt(stored, 10));
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
// so the workspace's right padding tracks it. The resize is coordinated with
// the rest of the workspace via the `layout` prop and `onRequestCloseLeftSidebar`
// (see workbench/chatLayout.js): dragging wide enough auto-closes the Models
// sidebar to free space, and the viewer keeps a minimum visible width.
export default function ChatSidebar({
  onOpenArtifact,
  width = SIDEBAR_WIDTH,
  onWidthChange,
  layout,
  onRequestCloseLeftSidebar,
  menuBarVisible = false,
  className,
}) {
  const lastError = useChatStore((state) => state.lastError);
  const needsPandaReauth = useChatStore((state) => state.needsPandaReauth);
  const history = useChatStore((state) => state.history);
  const isHydratingSession = useChatStore((state) => state.isHydratingSession);
  const projectId = useChatStore((state) => state.currentProjectId);
  const currentProjectName = useProjectsStore((state) => {
    const current = state.projects.find((project) => project.id === state.currentProjectId);
    return current?.name || "";
  });
  const isEmpty = history.length === 0;
  const showCenteredEmpty = isEmpty && !isHydratingSession;
  const summaryTitle = currentProjectName.trim() || (history.length ? "Untitled chat" : "New chat");

  const resizeStateRef = useRef(null);
  const chatInputRef = useRef(null);
  // The window-level pointer handlers below are installed once; these refs keep
  // them reading the latest layout and callbacks without re-subscribing.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const onWidthChangeRef = useRef(onWidthChange);
  onWidthChangeRef.current = onWidthChange;
  const onRequestCloseLeftSidebarRef = useRef(onRequestCloseLeftSidebar);
  onRequestCloseLeftSidebarRef.current = onRequestCloseLeftSidebar;

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
      const { width: nextWidth, closeLeftSidebar } = clampChatWidth(
        resizeState.startWidth + delta,
        { ...(layoutRef.current || {}), allowCloseLeftSidebar: true },
      );
      // Reaching past what fits with the Models sidebar open reclaims its space
      // (one-way; it never auto-reopens). Idempotent: once the close round-trips
      // into `layout`, clampChatWidth stops asking.
      if (closeLeftSidebar) {
        onRequestCloseLeftSidebarRef.current?.();
      }
      resizeState.latestWidth = nextWidth;
      onWidthChangeRef.current?.(nextWidth);
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
  }, []);

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

  const handleRequestInputFocus = useCallback(() => {
    window.requestAnimationFrame?.(() => {
      chatInputRef.current?.focus({ preventScroll: true });
    });
  }, []);

  // The top-bar "New project" action focuses the composer through this event:
  // the menu lives in another component, and the textarea's mount-time
  // autoFocus doesn't re-fire when the active project switches in place.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    window.addEventListener(FOCUS_CHAT_INPUT_EVENT, handleRequestInputFocus);
    return () => window.removeEventListener(FOCUS_CHAT_INPUT_EVENT, handleRequestInputFocus);
  }, [handleRequestInputFocus]);

  return (
    <aside
      data-slot="chat-sidebar"
      data-project-id={projectId || ""}
      className={cn(
        "pointer-events-auto fixed right-0 z-30 flex flex-col border-l border-border/60 bg-background/95 shadow-xl backdrop-blur",
        // When the in-window menu bar is shown (Windows only), pin below it
        // (h-7 / 1.75rem) so the menu row isn't overlapped; otherwise fill the
        // viewport. Keep the offset in sync with the menu-bar height in
        // WindowMenuBar / main.jsx.
        menuBarVisible ? "top-7 h-[calc(100svh-1.75rem)]" : "top-0 h-svh",
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

      <header className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border/60 px-3.5">
        <MessageSquare className="size-4 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-sm font-semibold leading-normal tracking-tight "
            title={summaryTitle}
          >
            {summaryTitle}
          </div>
        </div>
        <div className="ml-auto">
          <AuthModeControl />
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {showCenteredEmpty ? (
          <div
            data-slot="chat-empty-composer"
            className="flex h-full flex-col items-center justify-center gap-4 px-3.5 transition-opacity duration-200"
          >
            <div className="flex flex-col items-center gap-1 text-center text-xs text-muted-foreground">
              <p>Describe what you want to print.</p>
              <p className="opacity-70">I'll draft a plan first — you can edit and approve it before I build.</p>
              <p className="opacity-70">Click a face on the model to refer to it in your message.</p>
            </div>
            <ChatInput ref={chatInputRef} className="w-full bg-transparent px-0 py-0" />
          </div>
        ) : isHydratingSession ? (
          <div
            data-slot="chat-history-loading"
            aria-busy="true"
            className="flex h-full flex-col justify-end gap-2 px-3.5 py-4 opacity-70 transition-opacity duration-200"
          >
            <div className="h-3 w-7/12 animate-pulse rounded bg-muted" />
            <div className="h-3 w-10/12 animate-pulse rounded bg-muted" />
            <div className="h-3 w-5/12 animate-pulse rounded bg-muted" />
          </div>
        ) : (
          <ChatHistory
            history={history}
            onOpenArtifact={onOpenArtifact}
            onRequestInputFocus={handleRequestInputFocus}
          />
        )}
      </div>

      <PandaReauthBanner />

      {lastError && !needsPandaReauth ? (
        <div
          data-slot="chat-error-banner"
          className="border-t border-destructive/40 bg-destructive/10 px-3 py-1 text-xs text-destructive"
        >
          {lastError}
        </div>
      ) : null}

      {showCenteredEmpty ? null : <ChatInput ref={chatInputRef} />}
    </aside>
  );
}

export {
  SIDEBAR_WIDTH,
  readStoredChatSidebarWidth,
  persistChatSidebarWidth,
};
