import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/ui/utils";
import { copyTextToClipboard } from "@/ui/clipboard";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export default function ChatCopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  className,
}) {
  const [copied, setCopied] = useState(false);
  const text = String(value ?? "");
  const Icon = copied ? Check : Copy;

  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout?.(() => setCopied(false), 1200);
    return () => window.clearTimeout?.(timer);
  }, [copied]);

  if (!text.trim()) return null;

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-slot="chat-copy-button"
            aria-label={copied ? copiedLabel : label}
            className={cn(
              "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors",
              "hover:bg-muted hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45",
              className,
            )}
            onClick={async (event) => {
              event.stopPropagation();
              try {
                await copyTextToClipboard(text);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            <Icon className="size-3.5" aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          {copied ? copiedLabel : label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
