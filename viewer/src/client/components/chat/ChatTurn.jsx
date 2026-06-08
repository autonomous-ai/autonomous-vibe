import { Loader2 } from "lucide-react";
import { cn } from "@/ui/utils";
import ToolUseBlock from "./ToolUseBlock";
import ArtifactBadge from "./ArtifactBadge";
import PlanBlock from "./PlanBlock";
import Markdown from "./Markdown";
import ChatCopyButton from "./ChatCopyButton";
import { phaseLabel, toolLabel } from "./activityLabels";

function TextBlock({ text }) {
  return (
    <div data-slot="chat-text">
      <Markdown source={text} />
    </div>
  );
}

function PhaseBadge({ phase, running }) {
  const label = phaseLabel(phase);
  if (!label) return null;
  return (
    <span
      data-slot="chat-phase"
      data-phase={phase}
      data-running={running ? "true" : "false"}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        phase === "plan"
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-emerald-500/40 bg-emerald-500/10 text-emerald-600",
      )}
    >
      {running ? (
        // A single "live" pulse stands in for the old separate STREAMING…
        // line — one activity signal per turn, not two.
        <span className="relative flex size-1.5" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
          <span className="relative inline-flex size-1.5 rounded-full bg-current" />
        </span>
      ) : null}
      {label}
    </span>
  );
}

function ThinkingBlock({ text }) {
  return (
    <p
      data-slot="chat-thinking"
      className="whitespace-pre-wrap rounded-md border border-dashed border-border/60 bg-muted/20 px-2 py-1 text-xs italic text-muted-foreground"
    >
      {text}
    </p>
  );
}

function ErrorBlock({ message }) {
  return (
    <p data-slot="chat-error" className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
      {message}
    </p>
  );
}

function turnCopyText(turn) {
  return (turn.blocks || [])
    .map((block) => {
      switch (block.kind) {
        case "text":
        case "thinking":
          return block.text;
        case "plan":
          return block.plan;
        case "artifact":
          return block.file;
        case "error":
          return block.message;
        case "tool_use":
          return block.tool;
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join("\n\n");
}

function StatusLine({ turn }) {
  if (turn.role !== "assistant") return null;
  // "running" is conveyed by the live pulse inside PhaseBadge — no separate
  // streaming line, so the header shows one activity signal, not two.
  if (turn.status === "cancelled") {
    return <span data-slot="chat-status" className="text-[11px] uppercase tracking-wide text-amber-500">cancelled</span>;
  }
  return null;
}

export default function ChatTurn({ turn, onOpenArtifact }) {
  const isUser = turn.role === "user";
  const showModifyHint =
    !isUser &&
    turn.phase === "implement" &&
    turn.status === "complete" &&
    turn.blocks.some((block) => block.kind === "artifact");
  const copyText = turnCopyText(turn);
  return (
    <article
      data-slot="chat-turn"
      data-role={turn.role}
      data-turn-id={turn.id}
      data-status={turn.status}
      style={
        isUser
          ? { backgroundColor: "color-mix(in srgb, var(--foreground) 7%, var(--ui-surface-solid))" }
          : undefined
      }
      className={cn(
        "group/turn relative rounded-xl px-3.5 py-2.5 shadow-(--ui-shadow-soft) transition-colors",
        isUser
          ? "ml-auto mb-7 w-fit max-w-[85%] rounded-2xl"
          : "bg-card/65",
      )}
    >
      {isUser ? (
        <ChatCopyButton
          value={copyText}
          className="absolute right-1 top-full z-10 mt-1 opacity-0 group-hover/turn:opacity-100 group-focus-within/turn:opacity-100"
        />
      ) : (
        <header className="mb-1.5 flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5">
            <PhaseBadge phase={turn.phase} running={turn.status === "running"} />
          </span>
          <StatusLine turn={turn} />
        </header>
      )}
      <div className="relative">
        <div className="flex flex-col gap-2">
        {isUser && turn.images?.length ? (
          <div data-slot="chat-turn-images" className="flex flex-wrap gap-1.5">
            {turn.images.map((image, index) => (
              <img
                key={index}
                src={image.url}
                alt={image.name || "attachment"}
                className="size-16 rounded-md border border-border/60 object-cover"
              />
            ))}
          </div>
        ) : null}
        {!isUser && turn.status === "running" && turn.blocks.length === 0 ? (
          <p
            data-slot="chat-working"
            className="flex items-center gap-1.5 text-sm text-muted-foreground"
          >
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Working…
          </p>
        ) : null}
        {turn.blocks.map((block, index) => {
          switch (block.kind) {
            case "text":
              return <TextBlock key={index} text={block.text} />;
            case "thinking":
              return <ThinkingBlock key={index} text={block.text} />;
            case "tool_use":
              return (
                <ToolUseBlock
                  key={index}
                  tool={block.tool}
                  label={toolLabel(block.tool, block.input)}
                  input={block.input}
                  status={block.status}
                />
              );
            case "plan":
              return <PlanBlock key={index} plan={block.plan} status={block.status} />;
            case "artifact":
              return (
                <div key={index} className="flex">
                  <ArtifactBadge
                    file={block.file}
                    reason={block.reason}
                    onOpen={onOpenArtifact}
                  />
                </div>
              );
            case "error":
              return <ErrorBlock key={index} message={block.message} />;
            default:
              return null;
          }
        })}
        {showModifyHint ? (
          <p
            data-slot="chat-modify-hint"
            className="mt-0.5 border-t border-border/40 pt-1.5 text-xs text-muted-foreground"
          >
            Done. Want changes? Just describe them below — e.g. “make it 1 cm
            taller” or “add a hole for a screw”.
          </p>
        ) : null}
        </div>
      </div>
      {!isUser ? (
        <ChatCopyButton
          value={copyText}
          className="absolute left-1 top-full z-10 mt-1 opacity-0 group-hover/turn:opacity-100 group-focus-within/turn:opacity-100"
        />
      ) : null}
    </article>
  );
}
