import { useState } from "react";
import { ChevronRight, ChevronDown, Wrench, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { cn } from "@/ui/utils";
import ChatCodeBlock from "./ChatCodeBlock";
import { BLOCK_CARD, BLOCK_HEAD } from "./chatTheme";

const STATUS_PILL = {
  ok: {
    icon: <CheckCircle2 className="size-3" aria-hidden />,
    label: "Ok",
    cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600",
  },
  error: {
    icon: <XCircle className="size-3" aria-hidden />,
    label: "Error",
    cls: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  running: {
    icon: <Loader2 className="size-3 animate-spin" aria-hidden />,
    label: "Running",
    cls: "border-border/60 bg-muted/50 text-muted-foreground",
  },
};

function StatusPill({ status }) {
  const s = STATUS_PILL[status] || STATUS_PILL.running;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
        s.cls,
      )}
    >
      {s.icon}
      {s.label}
    </span>
  );
}

function safeStringify(input) {
  if (input == null) return "";
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

export default function ToolUseBlock({ tool, label, input, status }) {
  const [open, setOpen] = useState(false);
  const detail = safeStringify(input);
  const primary = label || tool || "tool";
  const showRaw = !!tool && primary !== tool;
  return (
    <div
      data-slot="chat-tool-use"
      data-tool={tool}
      data-status={status}
      className={cn(BLOCK_CARD, "text-xs text-muted-foreground")}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(BLOCK_HEAD, "hover:text-foreground")}
        aria-expanded={open ? "true" : "false"}
      >
        {open ? <ChevronDown className="size-3.5 shrink-0 opacity-70" aria-hidden /> : <ChevronRight className="size-3.5 shrink-0 opacity-70" aria-hidden />}
        <Wrench className="size-3.5 shrink-0 opacity-70" aria-hidden />
        <span className="truncate text-[13px] font-semibold text-foreground">{primary}</span>
        {showRaw ? <span className="shrink-0 text-[10px] text-muted-foreground/70">{tool}</span> : null}
        <span className="ml-auto shrink-0">
          <StatusPill status={status} />
        </span>
      </button>
      {open && detail ? (
        <div className="px-3 pb-3">
          <ChatCodeBlock
            code={detail}
            lang="json"
            copyLabel="Copy input"
            maxHeightClassName="max-h-48"
          />
        </div>
      ) : null}
    </div>
  );
}
