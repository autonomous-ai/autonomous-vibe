import { memo } from "react";
import { Loader2, Undo2 } from "lucide-react";
import { cn } from "@/ui/utils";
import ArtifactBadge from "./ArtifactBadge";
import PlanBlock from "./PlanBlock";
import Markdown from "./Markdown";
import ChatCopyButton from "./ChatCopyButton";
import ThinkingSummary from "./ThinkingSummary";
import { phaseLabel, toolLabel } from "./activityLabels";
import { partitionTurnBlocks } from "@/store/chat";

function TextBlock({ text, streaming }) {
  if (streaming) {
    // Plain text while a turn is streaming — avoids re-parsing markdown on every delta.
    return (
      <div
        data-slot="chat-text"
        className="chat-prose whitespace-pre-wrap text-sm text-foreground/90"
      >
        {text}
      </div>
    );
  }
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

function turnShowsCopyButton(turn) {
  return (turn.blocks || []).some((block) =>
    block.kind === "text" || block.kind === "thinking" || block.kind === "plan",
  );
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

export default memo(function ChatTurn({ turn, onOpenArtifact }) {
  // A revert marker is its own kind of turn: a single centered, self-explaining
  // line ("↩ Reverted to <label>"), not an assistant message bubble. Render it
  // before the normal turn chrome so it stays visually distinct in the thread.
  if (
    turn.role === "assistant" &&
    turn.blocks.length === 1 &&
    turn.blocks[0].kind === "revert"
  ) {
    return (
      <div
        data-slot="chat-revert-marker"
        className="flex items-center justify-center gap-1.5 py-0.5 text-xs text-muted-foreground"
      >
        <Undo2 className="size-3.5 shrink-0" aria-hidden />
        <span>
          Reverted to{" "}
          <span className="font-medium text-foreground/80">{turn.blocks[0].label}</span>
        </span>
      </div>
    );
  }
  const isUser = turn.role === "user";
  const showModifyHint =
    !isUser &&
    turn.phase === "implement" &&
    turn.status === "complete" &&
    turn.blocks.some((block) => block.kind === "artifact");
  const copyText = turnCopyText(turn);
  const showCopyButton = turnShowsCopyButton(turn);
  // Pre-answer narration (text emitted between tool calls) folds into the
  // ThinkingSummary trace; only the answer body renders inline here.
  const bodyBlocks = isUser ? turn.blocks : partitionTurnBlocks(turn.blocks).body;
  // The ThinkingSummary pill carries the generic "Working…/Thinking…" signal in
  // the header for the whole run. Here in the body we only surface the *specific*
  // in-flight step ("Rendering preview…") when a tool is actually mid-run and no
  // answer text is currently streaming — so there's no dead gap and no duplicate
  // generic spinner.
  const running = !isUser && turn.status === "running";
  const answerStreaming = bodyBlocks[bodyBlocks.length - 1]?.kind === "text";
  const runningTool =
    running && !answerStreaming
      ? [...turn.blocks].reverse().find((b) => b.kind === "tool_use" && b.status === "running")
      : null;
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
        "group/turn relative min-w-0 wrap-break-word rounded-xl px-3.5 py-2.5 shadow-(--ui-shadow-soft) transition-colors",
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
            {!isUser ? <ThinkingSummary turn={turn} /> : null}

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
        {bodyBlocks.map((block, index) => {
          switch (block.kind) {
            case "text":
              return (
                <TextBlock
                  key={index}
                  text={block.text}
                  streaming={turn.status === "running" && index === bodyBlocks.length - 1}
                />
              );
            case "thinking":
            case "tool_use":
              // Reasoning, tool calls, and pre-answer narration are collapsed
              // into the ThinkingSummary pill (full trace in a modal) — never
              // rendered inline. (partitionTurnBlocks keeps them out of body.)
              return null;
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
        {runningTool ? (
          <p
            data-slot="chat-working"
            className="flex items-center gap-1.5 text-sm text-muted-foreground"
          >
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            {`${toolLabel(runningTool.tool, runningTool.input)}…`}
          </p>
        ) : null}
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
      {!isUser && showCopyButton ? (
        <ChatCopyButton
          value={copyText}
          className="absolute bottom-1 right-1 z-10 opacity-0 group-hover/turn:opacity-100 group-focus-within/turn:opacity-100"
        />
      ) : null}
    </article>
  );
}, (prev, next) => prev.turn === next.turn && prev.onOpenArtifact === next.onOpenArtifact);
