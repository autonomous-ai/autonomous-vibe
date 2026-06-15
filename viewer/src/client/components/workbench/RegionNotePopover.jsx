import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

// Inline action card for a region, anchored next to its numbered badge in the
// viewport, shown the moment a circle/rectangle/freehand is drawn. The user
// types the change for the highlight in a roomy multi-line box (empty by
// default, just a placeholder prompt), then sends it straight to the AI with the
// annotated screenshot. Screen-space and `position: fixed`, matching
// getBoundingClientRect's viewport coordinates.
//
// Mount one per region via `key={strokeId}` at the call site so `autoFocus`
// fires each time the card retargets to a freshly drawn highlight.
//
// Props:
//   number       region badge number (1-based; 0/undefined for freehand)
//   initialNote  pre-filled text (a previously-typed note; "" for a fresh region)
//   anchor       { left, top } viewport px of the region badge
//   onSave(text) persist the text as the region note (called on blur)
//   onSend(text) attach the annotated view + this text to the chat
//   onClose()    dismiss (Escape)
const POPOVER_WIDTH = 320;

export default function RegionNotePopover({ number, initialNote = "", anchor, onSave, onSend, onClose }) {
  const [value, setValue] = useState(initialNote);

  if (!anchor) {
    return null;
  }

  // Place to the badge's right, flipping left near the viewport edge so the card
  // never runs off-screen.
  const flipLeft =
    typeof window !== "undefined" && anchor.left > window.innerWidth - (POPOVER_WIDTH + 28);
  const style = {
    position: "fixed",
    left: Math.round(anchor.left + (flipLeft ? -12 : 12)),
    top: Math.round(anchor.top),
    width: POPOVER_WIDTH,
    transform: `translate(${flipLeft ? "-100%" : "0"}, -50%)`,
    zIndex: 60,
  };

  const send = () => {
    const text = value.trim();
    if (text) onSend?.(text);
  };

  return (
    <div
      style={style}
      className="cad-glass-surface pointer-events-auto flex flex-col gap-2 rounded-md border border-sidebar-border p-2.5 text-sidebar-foreground shadow-md"
      role="dialog"
      aria-label={number ? `Send region ${number} to the AI` : "Send highlight to the AI"}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-start gap-2">
        {/* Numbered badge only for the numbered regions (circle/rectangle) that
            also get a baked badge in the screenshot; freehand has none. */}
        {number ? (
          <span
            className="mt-1 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
            style={{ backgroundColor: "#ef4444" }}
            aria-hidden="true"
          >
            {number}
          </span>
        ) : null}
        <Textarea
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => onSave?.(value.trim())}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter inserts a newline (room for detail).
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose?.();
            }
          }}
          placeholder="Describe the change for this highlight…"
          rows={3}
          className="max-h-40 min-h-20 flex-1 resize-none text-sm leading-snug"
          aria-label={number ? `Instruction for region ${number}` : "Instruction for this highlight"}
        />
      </div>
      <Button
        type="button"
        size="sm"
        onClick={send}
        disabled={!value.trim()}
        className="h-8 w-fit gap-1.5 self-end px-3 text-xs"
      >
        <Sparkles className="size-3.5" strokeWidth={2} aria-hidden="true" />
        Send
      </Button>
    </div>
  );
}
