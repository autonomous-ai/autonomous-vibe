import { useEffect } from "react";
import { MessageSquare } from "lucide-react";
import { cn } from "@/ui/utils";
import { attachChatEventStream, useChatStore } from "@/store/chat";
import ChatHistory from "./ChatHistory";
import ChatInput from "./ChatInput";
import ActionButtons from "./ActionButtons";

const SIDEBAR_WIDTH = 440;

// Chat is the primary surface of the app, so the panel is permanent — there's
// no collapse. The collapsible rail is the left "Models" sidebar instead.
export default function ChatSidebar({
  printerList = [],
  defaultFilament = "PLA",
  onOpenArtifact,
  className,
}) {
  const lastError = useChatStore((state) => state.lastError);
  const history = useChatStore((state) => state.history);
  const projectId = useChatStore((state) => state.currentProjectId);

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

  return (
    <aside
      data-slot="chat-sidebar"
      data-project-id={projectId || ""}
      className={cn(
        "pointer-events-auto fixed right-0 top-0 z-30 flex h-svh flex-col border-l border-border/60 bg-background/95 shadow-xl backdrop-blur",
        className,
      )}
      style={{ width: SIDEBAR_WIDTH }}
    >
      <header className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <MessageSquare className="size-4 text-muted-foreground" aria-hidden />
        <span className="text-sm font-semibold tracking-tight">Chat</span>
      </header>

      <div className="min-h-0 flex-1">
        <ChatHistory history={history} onOpenArtifact={onOpenArtifact} />
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

export { SIDEBAR_WIDTH };
