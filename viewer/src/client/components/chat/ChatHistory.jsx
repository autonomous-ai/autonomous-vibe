import { useEffect, useRef } from "react";
import { cn } from "@/ui/utils";
import ChatTurn from "./ChatTurn";

export default function ChatHistory({ history, onOpenArtifact, className }) {
  const ref = useRef(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [history]);

  if (!history.length) {
    return (
      <div
        data-slot="chat-history-empty"
        className={cn(
          "flex h-full flex-col items-center justify-center gap-1 px-4 text-center text-xs text-muted-foreground",
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
    <div
      ref={ref}
      data-slot="chat-history"
      className={cn("flex h-full flex-col gap-3 overflow-y-auto px-3.5 py-3", className)}
    >
      {history.map((turn) => (
        <ChatTurn key={turn.id} turn={turn} onOpenArtifact={onOpenArtifact} />
      ))}
    </div>
  );
}
