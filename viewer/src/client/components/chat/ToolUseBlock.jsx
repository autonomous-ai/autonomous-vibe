import { useState } from "react";
import { ChevronRight, ChevronDown, Wrench, Check, XCircle, Loader2, Ban } from "lucide-react";
import { cn } from "@/ui/utils";
import ChatCodeBlock from "./ChatCodeBlock";

const STATUS_PILL = {
  ok: {
    icon: <Check className="size-3" aria-hidden />,
    label: "OK",
    cls: "border-emerald-400/35 bg-emerald-500/20 text-emerald-400",
  },
  error: {
    icon: <XCircle className="size-3" aria-hidden />,
    label: "Error",
    cls: "border-destructive/35 bg-destructive/15 text-destructive",
  },
  running: {
    icon: <Loader2 className="size-3 animate-spin" aria-hidden />,
    label: "Running",
    cls: "border-white/10 bg-white/5 text-zinc-400",
  },
  cancelled: {
    icon: <Ban className="size-3" aria-hidden />,
    label: "Cancelled",
    cls: "border-white/10 bg-white/5 text-zinc-500",
  },
};

function StatusPill({ status }) {
  const s = STATUS_PILL[status] || STATUS_PILL.running;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium leading-none",
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
        "rounded-lg border border-white/10 bg-[#17181b] px-4 py-3 text-xs text-zinc-400 shadow-sm transition-colors",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-md text-left transition-colors hover:text-zinc-200"
        aria-expanded={open ? "true" : "false"}
      >
        <Wrench className="size-3 shrink-0 text-zinc-500" aria-hidden />
        <span className="truncate font-semibold text-zinc-100">{primary}</span>
        {showRaw ? <span className="shrink-0 text-xs text-zinc-500">{tool}</span> : null}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <StatusPill status={status} />
          {open ? (
            <ChevronDown className="size-4 text-zinc-500" aria-hidden />
          ) : (
            <ChevronRight className="size-4 text-zinc-500" aria-hidden />
          )}
        </span>
      </button>
      {open && detail ? (
        <ChatCodeBlock
          code={detail}
          lang="json"
          showCopy={false}
          className="mt-2"
          maxHeightClassName="max-h-48"
        />
      ) : null}
    </div>
  );
}
