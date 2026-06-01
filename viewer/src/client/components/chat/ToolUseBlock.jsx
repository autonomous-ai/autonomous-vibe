import { useState } from "react";
import { ChevronRight, ChevronDown, Wrench, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { cn } from "@/ui/utils";

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
      className={cn(
        "rounded-lg border border-border/60 bg-muted/20 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-md text-left transition-colors hover:text-foreground"
        aria-expanded={open ? "true" : "false"}
      >
        {open ? <ChevronDown className="size-3 shrink-0 opacity-70" aria-hidden /> : <ChevronRight className="size-3 shrink-0 opacity-70" aria-hidden />}
        <Wrench className="size-3 shrink-0 opacity-70" aria-hidden />
        <span className="truncate font-medium text-foreground">{primary}</span>
        {showRaw ? <span className="shrink-0 text-[10px] text-muted-foreground/70">{tool}</span> : null}
        <span className="ml-auto shrink-0">
          <StatusPill status={status} />
        </span>
      </button>
      {open && detail ? (
        <pre className="mt-1.5 max-h-48 overflow-auto rounded bg-background/60 p-2 text-[11px] leading-snug text-foreground/80">
          {detail}
        </pre>
      ) : null}
    </div>
  );
}
