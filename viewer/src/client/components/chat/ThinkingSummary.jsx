import { useMemo, useState } from "react";
import { Loader2, Sparkles, Check, XCircle, Ban, Wrench } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/ui/utils";
import { thinkingDurationMs, partitionTurnBlocks } from "@/store/chat";
import Markdown from "./Markdown";
import { toolLabel, toolDetail } from "./activityLabels";

// Human duration: seconds under a minute, "Nm Ns" above. Floors so a fresh
// turn reads "0s" rather than rounding up mid-first-second.
function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

// Small status glyph for an activity (tool) row in the trace dialog. Mirrors
// the status vocabulary used by ToolUseBlock.
function ActivityStatus({ status }) {
  if (status === "ok") return <Check className="size-3.5 text-emerald-500" aria-hidden />;
  if (status === "error") return <XCircle className="size-3.5 text-destructive" aria-hidden />;
  if (status === "cancelled") return <Ban className="size-3.5 text-muted-foreground" aria-hidden />;
  return <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />;
}

// One step in the trace. Reasoning (thinking) and inter-step narration (text)
// render as markdown; reasoning is dimmed/italic so it reads as the model's
// internal thought, narration as plain commentary. A tool step shows the verb
// + the specific target it acted on (file, pattern, query, command) + status —
// so the timeline reads like "Searching code · «pattern»  ✓" instead of a
// bare "Working".
function TraceItem({ block }) {
  if (block.kind === "thinking") {
    return (
      <div
        data-slot="thinking-trace-reasoning"
        className="border-l-2 border-border/60 pl-2.5 text-sm italic text-muted-foreground"
      >
        <Markdown source={block.text} />
      </div>
    );
  }
  if (block.kind === "text") {
    return (
      <div data-slot="thinking-trace-narration" className="text-sm text-foreground/90">
        <Markdown source={block.text} />
      </div>
    );
  }
  // tool_use
  const detail = toolDetail(block.tool, block.input);
  return (
    <div
      data-slot="thinking-trace-activity"
      data-tool={block.tool}
      data-status={block.status}
      className="flex min-w-0 items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-2.5 py-1.5 text-sm text-muted-foreground"
    >
      <Wrench className="size-3.5 shrink-0" aria-hidden />
      <span className="shrink-0 font-medium text-foreground">
        {toolLabel(block.tool, block.input)}
      </span>
      {detail ? (
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={detail}>
          {detail}
        </span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {block.resultSummary ? (
          <span className="tabular-nums text-xs text-muted-foreground/80">{block.resultSummary}</span>
        ) : null}
        <ActivityStatus status={block.status} />
      </span>
    </div>
  );
}

/**
 * Grok-style collapsed indicator for an assistant turn's pre-answer work.
 * Replaces the inline reasoning box and the generic "Working…" spinner: shows
 * one compact pill ("Thinking…" while live → "Thought for Ns" when done) and
 * opens the full reasoning + activity trace in a modal on click.
 */
export default function ThinkingSummary({ turn }) {
  const [open, setOpen] = useState(false);

  const trace = useMemo(() => partitionTurnBlocks(turn.blocks).trace, [turn.blocks]);
  const hasTrace = trace.length > 0;
  const hasTool = useMemo(() => trace.some((b) => b.kind === "tool_use"), [trace]);
  // "Live" the whole time the turn runs — the pill must not freeze to a number
  // mid-run (a build keeps working long after the first token). The duration is
  // shown only once complete, when it reflects the true work span.
  const live = turn.status === "running";

  // Pure-text reply with no reasoning and nothing running → no pill at all.
  if (!hasTrace && !live) return null;

  const duration = formatDuration(thinkingDurationMs(turn));
  const verb = hasTool ? "Working" : "Thinking";
  const label = live ? `${verb}…` : `${hasTool ? "Worked" : "Thought"} for ${duration}`;
  const clickable = hasTrace;

  const pill = (
    <span
      data-slot="thinking-summary"
      data-live={live ? "true" : "false"}
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-muted-foreground transition-colors",
        clickable && "cursor-pointer hover:text-foreground hover:bg-muted/70",
      )}
    >
      {live ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
      ) : (
        <Sparkles className="size-3.5" aria-hidden />
      )}
      {label}
    </span>
  );

  if (!clickable) return pill;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open ? "true" : "false"}
        className="w-fit rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {pill}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-slot="thinking-trace-modal" className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Thinking trace</DialogTitle>
            <DialogDescription>
              {live ? `${verb}…` : `Reasoning and activity · ${duration}`}
            </DialogDescription>
          </DialogHeader>
          <div className="-mr-2 max-h-[60vh] overflow-y-auto pr-2">
            <div className="flex flex-col gap-3">
              {trace.map((block, index) => (
                <TraceItem key={index} block={block} />
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
