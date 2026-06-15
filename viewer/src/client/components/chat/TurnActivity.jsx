import { useState } from "react";
import { Loader2, Check, XCircle, Ban, Wrench, ChevronRight, ChevronDown } from "lucide-react";
import { cn } from "@/ui/utils";
import { toolLabel, toolDetail, aggregateActivityStatus, activityDefaultsOpen } from "./activityLabels";
import { SegmentDuration } from "./liveDuration";

// Status glyph for the disclosure header / a tool row. Mirrors the status
// vocabulary the reducer assigns to tool blocks.
function StatusGlyph({ status, className }) {
  if (status === "ok") return <Check className={cn("size-3.5 text-emerald-500", className)} aria-hidden />;
  if (status === "error") return <XCircle className={cn("size-3.5 text-destructive", className)} aria-hidden />;
  if (status === "cancelled") return <Ban className={cn("size-3.5 text-muted-foreground", className)} aria-hidden />;
  return <Loader2 className={cn("size-3.5 animate-spin text-muted-foreground", className)} aria-hidden />;
}

// One tool step: the verb + the specific target it acted on (file, pattern,
// query, command) + status — so the row reads "Searching code · «pattern» ✓"
// instead of a bare "Working".
function ActivityRow({ block }) {
  const detail = toolDetail(block.tool, block.input);
  return (
    <div
      data-slot="chat-activity-row"
      data-tool={block.tool}
      data-status={block.status}
      className="flex min-w-0 items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-2.5 py-1.5 text-sm text-muted-foreground"
    >
      <Wrench className="size-3.5 shrink-0" aria-hidden />
      <span className="shrink-0 font-medium text-foreground">{toolLabel(block.tool, block.input)}</span>
      {detail ? (
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={detail}>
          {detail}
        </span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {block.resultSummary ? (
          <span className="tabular-nums text-xs text-muted-foreground/80">{block.resultSummary}</span>
        ) : null}
        <StatusGlyph status={block.status} />
      </span>
    </div>
  );
}

/**
 * The collapsible "Activity" disclosure for one segment's tool calls. The
 * `active` (live) group auto-expands so progress is watchable and reads
 * "Working… 18s · <current step>"; finished groups collapse to "Worked for 18s
 * · N steps" — unless a tool errored, when they stay open so the failure isn't
 * hidden. Every group shows the turn's total elapsed time (it ticks while the
 * turn runs). The user can toggle any group; their choice sticks for the
 * session.
 *
 * Rendered only when the segment actually has tool activity.
 */
export default function TurnActivity({ segment, active = false }) {
  const [override, setOverride] = useState(null); // null = follow default
  const activity = (segment && segment.activity) || [];
  if (activity.length === 0) return null;

  const open = override ?? activityDefaultsOpen(activity, active);
  const status = aggregateActivityStatus(activity);
  const runningStep = active ? activity.find((b) => b.status === "running") : null;
  const steps = `${activity.length} step${activity.length === 1 ? "" : "s"}`;

  return (
    <div
      data-slot="chat-activity"
      data-open={open ? "true" : "false"}
      data-status={status}
      data-active={active ? "true" : "false"}
    >
      <button
        type="button"
        onClick={() => setOverride(!open)}
        aria-expanded={open ? "true" : "false"}
        className={cn(
          "flex w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 text-left text-xs transition-colors hover:text-foreground",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" aria-hidden />
        )}
        <StatusGlyph status={active ? "running" : status} />
        <span className="font-medium text-foreground/90">
          {active ? "Working… " : "Worked for "}
          <SegmentDuration segment={segment} active={active} />
        </span>
        {runningStep ? (
          <span className="min-w-0 truncate">· {toolLabel(runningStep.tool, runningStep.input)}…</span>
        ) : (
          <span className="shrink-0">· {steps}</span>
        )}
      </button>
      {open ? (
        <div className="mt-1.5 flex flex-col gap-1.5 border-l-2 border-border/50 pl-2.5">
          {activity.map((block, index) => (
            <ActivityRow key={block.toolUseId || index} block={block} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export { ActivityRow, StatusGlyph };
