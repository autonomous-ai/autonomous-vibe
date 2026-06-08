import { useEffect, useRef, useState } from "react";
import { Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/ui/utils";
import ToolUseBlock from "./ToolUseBlock";
import ArtifactBadge from "./ArtifactBadge";
import PlanBlock from "./PlanBlock";
import Markdown from "./Markdown";
import ChatCopyButton from "./ChatCopyButton";
import { phaseLabel, toolLabel } from "./activityLabels";
import { useStuck } from "./useStuck";

// Height (px) the pinned user prompt collapses to (~2 lines of text-sm). Above
// this the prompt is considered overflowing and gets a "Show more" toggle.
const CONDENSED_MAX_PX = 44;

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

export default function ChatTurn({ turn, onOpenArtifact, scrollRootRef }) {
  const isUser = turn.role === "user";
  // User prompts stick to the top of the scroll container; once pinned (a
  // response has scrolled underneath) they collapse to a couple of lines with a
  // "Show more" toggle. Assistant turns scroll normally and never stick.
  const sentinelRef = useRef(null);
  const contentRef = useRef(null);
  const stuck = useStuck(isUser ? sentinelRef : null, scrollRootRef);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const condensed = isUser && stuck && !expanded;

  // Re-collapse once the prompt unsticks so the next pin starts condensed.
  useEffect(() => {
    if (!stuck) setExpanded(false);
  }, [stuck]);

  // Measure the full prompt height (contentRef is never clamped — the clamp
  // lives on its wrapper) to decide whether a "Show more" toggle is warranted.
  useEffect(() => {
    if (!isUser) {
      setOverflowing(false);
      return;
    }
    const el = contentRef.current;
    if (!el) return;
    setOverflowing(el.scrollHeight > CONDENSED_MAX_PX + 1);
  }, [isUser, turn, stuck]);

  const showModifyHint =
    !isUser &&
    turn.phase === "implement" &&
    turn.status === "complete" &&
    turn.blocks.some((block) => block.kind === "artifact");
  const copyText = turnCopyText(turn);
  return (
    <>
      {isUser ? (
        // Zero-impact marker at the prompt's natural top. It's absolutely
        // positioned (adds no height or flex gap to the group) and lives
        // OUTSIDE the sticky <article> so it scrolls away while the article
        // pins. useStuck observes it to detect pinning — because it sits above
        // the article and moves independently of it, condensing the pinned
        // prompt never shifts the sentinel, so there's no
        // height→reflow→re-measure feedback loop (the old flicker on tall
        // prompts). Requires the enclosing group to be `position: relative`.
        <div
          ref={sentinelRef}
          aria-hidden
          data-slot="chat-sticky-sentinel"
          className="pointer-events-none absolute left-0 top-0 h-px w-px"
        />
      ) : null}
    <article
      data-slot="chat-turn"
      data-role={turn.role}
      data-turn-id={turn.id}
      data-status={turn.status}
      data-stuck={isUser && stuck ? "true" : undefined}
      // The user prompt is always sticky, so it must stay opaque even before
      // `stuck` flips — an opaque tinted surface keeps the response from
      // bleeding through. Inline style avoids any reliance on a theme var that
      // could resolve translucent.
      style={
        isUser
          ? { backgroundColor: "color-mix(in srgb, var(--primary) 7%, var(--ui-surface-solid))" }
          : undefined
      }
      className={cn(
        "group/turn relative rounded-xl px-3.5 py-2.5 shadow-(--ui-shadow-soft) transition-colors",
        isUser
          ? cn("sticky top-0 z-20 border border-primary/20", stuck && "shadow-md")
          : "border border-border/60 bg-card/65",
      )}
    >
      {isUser ? (
        <ChatCopyButton
          value={copyText}
          className="absolute right-1.5 top-1.5 opacity-0 group-hover/turn:opacity-100 group-focus-within/turn:opacity-100"
        />
      ) : (
        <header className="mb-1.5 flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Claude
            </span>
            <PhaseBadge phase={turn.phase} running={turn.status === "running"} />
          </span>
          <span className="flex items-center gap-1.5">
            <StatusLine turn={turn} />
            <ChatCopyButton
              value={copyText}
              className="opacity-0 group-hover/turn:opacity-100 group-focus-within/turn:opacity-100"
            />
          </span>
        </header>
      )}
      <div className={cn("relative", condensed && "max-h-11 overflow-hidden")}>
        <div ref={isUser ? contentRef : null} className={cn("flex flex-col gap-2", isUser && "pr-7")}>
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
        {condensed && overflowing ? (
          <div
            data-slot="chat-prompt-fade"
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-linear-to-t from-(--ui-surface-solid) to-transparent"
          />
        ) : null}
      </div>
      {isUser && stuck && overflowing ? (
        <button
          type="button"
          data-slot="chat-prompt-toggle"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-primary"
        >
          {expanded ? (
            <ChevronUp className="size-3" aria-hidden />
          ) : (
            <ChevronDown className="size-3" aria-hidden />
          )}
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </article>
    </>
  );
}
