import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { ArrowUp, Plus, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/ui/utils";
import {
  addPendingAttachment,
  cancelTurn,
  consumePendingAttachments,
  consumePendingTokens,
  removePendingAttachment,
  setProject as setChatProject,
  startTurn,
  useChatStore,
} from "@/store/chat";
import { useProjectsStore } from "@/store/projects.ts";
import { buildSendValue, PLACEHOLDER_PROJECT_NAME } from "./chatInputHelpers";
import { blobToAttachment, imageFilesFromDataTransfer, MAX_ATTACHMENTS } from "./attachments";
import ModelControl from "./ModelControl";

export { buildSendValue };

const MAX_TEXTAREA_HEIGHT = 192; // tailwind max-h-48

function ChatInput({ className }, ref) {
  const [value, setValue] = useState("");
  const turnInProgress = useChatStore((state) => state.turnInProgress);
  const pendingTokens = useChatStore((state) => state.pendingTokens);
  const pendingAttachments = useChatStore((state) => state.pendingAttachments);
  const currentProjectId = useChatStore((state) => state.currentProjectId);

  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  // Transient hint shown next to the attach button (wrong type, too many, …).
  const [notice, setNotice] = useState("");

  // A turn needs text, a face-ref token, or at least one attached image.
  const sendDisabled =
    turnInProgress || (!value.trim() && !pendingTokens.length && !pendingAttachments.length);

  // Read image files (from a picker, paste, or drop), validate + encode each,
  // and queue it. Respects the per-turn cap and surfaces a brief notice.
  const ingestFiles = useCallback(
    async (files) => {
      const candidates = Array.from(files || []).filter((file) =>
        String(file.type || "").startsWith("image/"),
      );
      if (!candidates.length) {
        if (files && files.length) setNotice("Only images can be attached");
        return;
      }
      const room = Math.max(0, MAX_ATTACHMENTS - pendingAttachments.length);
      if (room <= 0) {
        setNotice(`Up to ${MAX_ATTACHMENTS} images`);
        return;
      }
      if (candidates.length > room) setNotice(`Up to ${MAX_ATTACHMENTS} images`);
      let attached = false;
      for (const file of candidates.slice(0, room)) {
        try {
          addPendingAttachment(await blobToAttachment(file));
          attached = true;
        } catch (error) {
          setNotice(error instanceof Error ? error.message : "Could not attach image");
        }
      }
      if (attached) {
        window.requestAnimationFrame?.(() => textareaRef.current?.focus());
      }
    },
    [pendingAttachments.length],
  );

  const handleSend = useCallback(async () => {
    const payload = buildSendValue(value, pendingTokens);
    if (!payload.trim() && !pendingAttachments.length) return;
    if (!currentProjectId) {
      try {
        const summary = await useProjectsStore.getState().create(PLACEHOLDER_PROJECT_NAME);
        setChatProject(summary.id);
      } catch {
        // create() surfaces its own error via the projects store; bail so we
        // don't start a turn with no workspace.
        return;
      }
    }
    // startTurn consumes pending tokens + attachments on success and echoes the
    // image thumbnails into the user bubble.
    const response = await startTurn(payload, { attachments: pendingAttachments });
    if (response) {
      setValue("");
      consumePendingTokens();
    }
  }, [value, pendingTokens, pendingAttachments, currentProjectId]);

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

  const handlePaste = useCallback(
    (event) => {
      const images = imageFilesFromDataTransfer(event.clipboardData);
      if (images.length) {
        // Keep the image out of the textarea; queue it as an attachment instead.
        event.preventDefault();
        void ingestFiles(images);
      }
    },
    [ingestFiles],
  );

  const handlePick = useCallback(
    (event) => {
      void ingestFiles(event.target.files);
      // Reset so picking the same file again still fires onChange.
      event.target.value = "";
    },
    [ingestFiles],
  );

  // Drag-drop uses DOM events (tauri.conf.json sets dragDropEnabled:false so the
  // OS webview doesn't swallow them). A depth counter keeps the overlay steady
  // as the cursor moves across child nodes.
  const dragHasFiles = (event) =>
    Array.from(event.dataTransfer?.types || []).includes("Files");
  const handleDragEnter = useCallback((event) => {
    if (!dragHasFiles(event)) return;
    dragDepth.current += 1;
    setDragging(true);
  }, []);
  const handleDragLeave = useCallback(() => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }, []);
  const handleDragOver = useCallback((event) => {
    if (dragHasFiles(event)) event.preventDefault();
  }, []);
  const handleDrop = useCallback(
    (event) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      void ingestFiles(imageFilesFromDataTransfer(event.dataTransfer));
    },
    [ingestFiles],
  );

  const handleCancel = useCallback(() => {
    void cancelTurn();
  }, []);

  const tokenChips = useMemo(() => pendingTokens.slice(0, 6), [pendingTokens]);
  const tokenOverflow = pendingTokens.length - tokenChips.length;

  const clearRefs = useCallback(() => {
    consumePendingTokens();
    consumePendingAttachments();
    window.requestAnimationFrame?.(() => textareaRef.current?.focus());
  }, []);

  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    const nextHeight = Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  }, []);

  useImperativeHandle(ref, () => ({
    focus(options) {
      textareaRef.current?.focus(options);
    },
  }), []);

  // Auto-dismiss the notice so it doesn't linger.
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(""), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!turnInProgress) {
      textareaRef.current?.focus();
    }
  }, [turnInProgress]);

  const hasStrip = pendingTokens.length > 0 || pendingAttachments.length > 0;

  useEffect(() => {
    adjustTextareaHeight();
  }, [value, hasStrip, adjustTextareaHeight]);

  return (
    <div
      data-slot="chat-input"
      data-turn-in-progress={turnInProgress ? "true" : "false"}
      className={cn("bg-background/60 px-3.5 py-2", className)}
    >
      <div
        data-slot="chat-composer"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className={cn(
          "relative flex min-h-24 flex-col gap-2 rounded-[1.35rem] border border-border/50 bg-muted/55 px-[14.5px] py-2.5 shadow-sm transition-colors",
          "focus-within:border-ring/50 focus-within:ring-2 focus-within:ring-ring/20",
          dragging && "border-primary",
        )}
      >
        {hasStrip ? (
          <div
            data-slot="chat-input-strip"
            className="flex flex-wrap items-center gap-1.5"
          >
            {pendingAttachments.map((attachment) => (
              <div
                key={attachment.id}
                data-slot="chat-input-attachment"
                className="group relative size-12 overflow-hidden rounded-md border border-border/70 bg-muted"
              >
                {attachment.objectUrl ? (
                  <img
                    src={attachment.objectUrl}
                    alt={attachment.name}
                    className="size-full object-cover"
                  />
                ) : null}
                <button
                  type="button"
                  onClick={() => removePendingAttachment(attachment.id)}
                  title={`Remove ${attachment.name}`}
                  className="absolute right-0.5 top-0.5 grid size-4 place-items-center rounded-full bg-background/85 text-foreground opacity-0 shadow transition-opacity group-hover:opacity-100"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </div>
            ))}
            {tokenChips.map((token) => (
              <span
                key={token}
                data-slot="chat-input-token"
                title={token}
                className="max-w-56 truncate rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-mono text-foreground"
              >
                {token}
              </span>
            ))}
            {tokenOverflow > 0 ? (
              <span className="text-[11px] text-muted-foreground">+{tokenOverflow} more</span>
            ) : null}
            <button
              type="button"
              onClick={clearRefs}
              className="ml-auto text-[11px] text-muted-foreground hover:text-foreground"
            >
              clear
            </button>
          </div>
        ) : null}

        <Textarea
          ref={textareaRef}
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Make anything"
          rows={2}
          className="scrollbar-thin min-h-10 resize-none border-0 bg-transparent! px-0 py-0 text-sm shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0 dark:bg-transparent!"
          data-slot="chat-input-textarea"
        />

        <div className="flex items-center justify-between gap-2 text-muted-foreground">
          <div className="flex min-w-0 items-center gap-1">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif"
              multiple
              className="hidden"
              onChange={handlePick}
              data-slot="chat-attach-input"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={turnInProgress}
              title="Attach images"
              data-slot="chat-attach-button"
              className="size-7 rounded-full text-muted-foreground hover:bg-background/55 hover:text-foreground"
            >
              <Plus className="size-4" aria-hidden />
            </Button>
            <ModelControl />
            {notice ? (
              <span className="truncate pl-1 text-[11px] text-muted-foreground">{notice}</span>
            ) : null}
          </div>
          {turnInProgress ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={handleCancel}
              title="Stop"
              data-slot="chat-cancel-button"
              className="size-8 rounded-full bg-white text-neutral-900 shadow-sm transition-none hover:bg-white hover:text-neutral-900 dark:bg-white dark:text-neutral-900 dark:hover:bg-white dark:hover:text-neutral-900"
            >
              <Square className="size-3 fill-current stroke-current" aria-hidden />
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
              className="size-8 rounded-full bg-foreground text-background transition-none hover:bg-foreground hover:text-background dark:hover:bg-foreground dark:hover:text-background disabled:opacity-100 disabled:bg-muted-foreground disabled:text-background"
            >
              <ArrowUp className="size-4" aria-hidden />
            </Button>
          )}
        </div>

        {dragging ? (
          <div
            data-slot="chat-input-dropzone"
            aria-hidden
            className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-xl border-2 border-dashed border-primary bg-primary/10 text-xs font-medium text-primary"
          >
            Drop image to attach
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default forwardRef(ChatInput);
