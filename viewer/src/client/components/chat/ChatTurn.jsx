import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Lightbulb,
  Loader2,
  Square,
} from "lucide-react";
import { cn } from "@/ui/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { cancelTurn } from "@/store/chat";
import ToolUseBlock from "./ToolUseBlock";
import ArtifactBadge from "./ArtifactBadge";
import PlanBlock from "./PlanBlock";
import Markdown from "./Markdown";
import ChatCopyButton from "./ChatCopyButton";
import { phaseLabel, toolLabel } from "./activityLabels";
import { useStuck } from "./useStuck";
import { BLOCK_CARD, BLOCK_HEAD } from "./chatTheme";

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

// Assistant identity tile (design meta row): a small gradient square with a
// single letter. Accent is monochrome zinc here, so it reads as a quiet brand
// mark rather than a colored avatar.
function AssistantAvatar() {
  return (
    <span
      data-slot="chat-avatar"
      aria-hidden
      className="grid size-5 shrink-0 place-items-center rounded-md bg-linear-to-br from-primary to-primary/65 text-[11px] font-bold text-primary-foreground"
    >
      C
    </span>
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
      // Design "plain" badge — neutral, low-noise. The live pulse is the single
      // activity signal (no separate STREAMING… line).
      className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
    >
      {running ? (
        <span className="relative flex size-1.5" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
          <span className="relative inline-flex size-1.5 rounded-full bg-current" />
        </span>
      ) : null}
      {label}
    </span>
  );
}

// Collapsible internal reasoning (design thinking block): a disclosure card
// with a lightbulb lead-icon and a dashed inset body. Default collapsed so it
// reads as low-priority "internal" output — the turn's pulse signals activity.
function ThinkingBlock({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-slot="chat-thinking" className={BLOCK_CARD}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open ? "true" : "false"}
        className={cn(BLOCK_HEAD, "text-muted-foreground hover:text-foreground")}
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 opacity-70" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 opacity-70" aria-hidden />
        )}
        <Lightbulb className="size-3.5 shrink-0 opacity-70" aria-hidden />
        <span className="text-[13px] font-semibold text-foreground/90">Thinking</span>
      </button>
      {open ? (
        <div className="px-3 pb-3">
          <p className="whitespace-pre-wrap rounded-lg border border-dashed border-border bg-muted/40 px-3.5 py-3 text-[13px] italic leading-relaxed text-muted-foreground">
            {text}
          </p>
        </div>
      ) : null}
    </div>
  );
}

// Streaming/running placeholder (design running block): spinner + title + Stop,
// over shimmer skeleton lines. Shown only before the first token arrives; once
// content streams, the turn renders its blocks with the header pulse instead.
function RunningBlock({ onStop }) {
  return (
    <div data-slot="chat-working" className={BLOCK_CARD}>
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden />
        <span className="text-[13px] font-semibold text-foreground">Working…</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onStop}
          data-slot="chat-stop"
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-muted-foreground/50 hover:text-foreground"
        >
          <Square className="size-2.5 fill-current" aria-hidden />
          Stop
        </button>
      </div>
      <div className="flex flex-col gap-2 px-3 pb-3.5">
        <Skeleton className="h-2.5 w-[92%] bg-muted" />
        <Skeleton className="h-2.5 w-[74%] bg-muted" />
        <Skeleton className="h-2.5 w-[54%] bg-muted" />
      </div>
    </div>
  );
}

// Danger card (design error block). Retry / View-log are omitted — no backing
// action exists on a generic error block, and the design forbids dead buttons.
function ErrorBlock({ message }) {
  return (
    <div data-slot="chat-error" className={cn(BLOCK_CARD, "border-destructive/35")}>
      <div className="flex items-center gap-2.5 border-b border-destructive/20 bg-destructive/10 px-3 py-2.5">
        <AlertCircle className="size-4 shrink-0 text-destructive" aria-hidden />
        <span className="text-[13px] font-semibold text-foreground">Something went wrong</span>
        <span className="flex-1" />
        <span className="inline-flex items-center rounded-full border border-destructive/45 bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-destructive">
          Error
        </span>
      </div>
      <p className="px-3 py-2.5 text-[13px] leading-relaxed text-muted-foreground">{message}</p>
    </div>
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
    return (
      <span
        data-slot="chat-status"
        className="inline-flex items-center rounded-full border border-destructive/45 bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-destructive"
      >
        Cancelled
      </span>
    );
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
      // `stuck` flips — an opaque surface keeps the response from bleeding
      // through while still matching the compact Codex-style prompt bubble.
      style={
        isUser
          ? { backgroundColor: "color-mix(in srgb, var(--foreground) 7%, var(--ui-surface-solid))" }
          : undefined
      }
      className={cn(
        "group/turn relative transition-colors",
        isUser
          ? cn(
              // Bubble with a tightened bottom-right corner (design tail).
              "sticky top-0 z-20 ml-auto mb-7 w-fit max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2.5 shadow-[var(--ui-shadow-soft)]",
              stuck && "shadow-md",
            )
          : // Assistant turns are flat/full-width — only their blocks are cards.
            "px-0.5",
      )}
    >
      {isUser ? (
        <ChatCopyButton
          value={copyText}
          className="absolute right-1 top-full z-10 mt-1 opacity-0 group-hover/turn:opacity-100 group-focus-within/turn:opacity-100"
        />
      ) : (
        <header className="mb-2 flex items-center gap-2">
          <AssistantAvatar />
          <span className="text-xs font-medium text-muted-foreground">Assistant</span>
          <span className="flex-1" />
          <PhaseBadge phase={turn.phase} running={turn.status === "running"} />
          <StatusLine turn={turn} />
        </header>
      )}
      <div className={cn("relative", condensed && "max-h-11 overflow-hidden")}>
        <div
          ref={isUser ? contentRef : null}
          className={cn(
            "flex flex-col gap-3",
            // Cancelled turns fade their partial output (design cancelled state).
            !isUser && turn.status === "cancelled" && "opacity-70",
          )}
        >
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
          <RunningBlock onStop={() => cancelTurn()} />
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
                <ArtifactBadge
                  key={index}
                  file={block.file}
                  reason={block.reason}
                  onOpen={onOpenArtifact}
                />
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
      {!isUser ? (
        <ChatCopyButton
          value={copyText}
          className="absolute left-1 top-full z-10 mt-1 opacity-0 group-hover/turn:opacity-100 group-focus-within/turn:opacity-100"
        />
      ) : null}
    </article>
    </>
  );
}
