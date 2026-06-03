import { useCallback, useEffect, useMemo, useState } from "react";
import { Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/ui/utils";
import {
  cancelTurn,
  consumePendingTokens,
  setProject as setChatProject,
  startTurn,
  useChatStore,
} from "@/store/chat";
import { useProjectsStore } from "@/store/projects.ts";
import { buildSendValue, PLACEHOLDER_PROJECT_NAME } from "./chatInputHelpers";

export { buildSendValue };

export default function ChatInput({ className }) {
  const [value, setValue] = useState("");
  const turnInProgress = useChatStore((state) => state.turnInProgress);
  const pendingTokens = useChatStore((state) => state.pendingTokens);
  const currentProjectId = useChatStore((state) => state.currentProjectId);
  const awaitingApproval = useChatStore((state) => state.awaitingApproval);

  // When tokens are queued by face clicks, prepend them visually so the user
  // sees what they're referring to. We do NOT auto-eat them on every keystroke
  // — they live in store and get attached at send time. No project is needed
  // up front: the first message lazily creates one with a placeholder name
  // that Claude's AI title later replaces, so the user never names anything.
  const sendDisabled = turnInProgress || (
    !value.trim() && !pendingTokens.length
  );

  const handleSend = useCallback(async () => {
    const payload = buildSendValue(value, pendingTokens);
    if (!payload.trim()) return;
    if (!currentProjectId) {
      try {
        const summary = await useProjectsStore
          .getState()
          .create(PLACEHOLDER_PROJECT_NAME);
        setChatProject(summary.id);
      } catch {
        // create() surfaces its own error via the projects store; bail so we
        // don't start a turn with no workspace.
        return;
      }
    }
    const response = await startTurn(payload);
    if (response) {
      setValue("");
      consumePendingTokens();
    }
  }, [value, pendingTokens, currentProjectId]);

  const handleKeyDown = useCallback(
    (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (!sendDisabled) {
          void handleSend();
        }
      }
    },
    [handleSend, sendDisabled],
  );

  const handleCancel = useCallback(() => {
    void cancelTurn();
  }, []);

  const tokenChips = useMemo(() => pendingTokens.slice(0, 6), [pendingTokens]);
  const tokenOverflow = pendingTokens.length - tokenChips.length;

  // Drop selected tokens from the chip row.
  const clearTokens = useCallback(() => {
    consumePendingTokens();
  }, []);

  // Auto-focus is intentionally NOT applied — would steal focus from the 3D
  // viewport during face clicks.
  useEffect(() => {
    // no-op: kept so tests can spy on a future effect if needed
  }, []);

  return (
    <div
      data-slot="chat-input"
      data-turn-in-progress={turnInProgress ? "true" : "false"}
      className={cn("border-t border-border/60 bg-background/60 p-2.5", className)}
    >
      {pendingTokens.length ? (
        <div data-slot="chat-input-tokens" className="mb-1.5 flex flex-wrap items-center gap-1">
          {tokenChips.map((token) => (
            <span
              key={token}
              data-slot="chat-input-token"
              title={token}
              className="max-w-[14rem] truncate rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-mono text-foreground"
            >
              {token}
            </span>
          ))}
          {tokenOverflow > 0 ? (
            <span className="text-[11px] text-muted-foreground">+{tokenOverflow} more</span>
          ) : null}
          <button
            type="button"
            onClick={clearTokens}
            className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          >
            clear refs
          </button>
        </div>
      ) : null}
      <div className="flex items-stretch gap-1.5">
        <Textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            awaitingApproval
              ? "Reply to refine the plan, or use the buttons above"
              : currentProjectId
                ? "Describe the change, then press Enter"
                : "Describe what you want to print, then press Enter"
          }
          rows={2}
          className="min-h-[2.25rem] flex-1 resize-none text-sm"
          data-slot="chat-input-textarea"
        />
        {turnInProgress ? (
          <Button
            type="button"
            variant="destructive"
            size="icon-sm"
            onClick={handleCancel}
            title="Cancel turn"
            data-slot="chat-cancel-button"
            className="h-auto self-stretch"
          >
            <X aria-hidden />
          </Button>
        ) : (
          <Button
            type="button"
            variant="default"
            size="icon-sm"
            onClick={handleSend}
            disabled={sendDisabled}
            title="Send"
            data-slot="chat-send-button"
            className="h-auto self-stretch"
          >
            <Send aria-hidden />
          </Button>
        )}
      </div>
    </div>
  );
}
