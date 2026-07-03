import { useLayoutEffect, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { cn } from "@/ui/utils";
import Markdown from "./Markdown";
import { SpanDuration } from "./liveDuration";

// Collapsed reasoning shows roughly six lines before fading; the user expands
// for the rest. Kept as a class so the fade height can track it.
const CAP_CLASS = "max-h-36";

function ReasoningBody({ blocks }) {
  // `chat-reasoning-prose` (see prose.css) recolors the markdown to the muted
  // "process" tone — without it the shared `.chat-prose` rules render reasoning
  // at the same foreground weight as the answer, collapsing the hierarchy.
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      {blocks.map((block, index) =>
        block.kind === "thinking" ? (
          <div key={index} data-slot="chat-reasoning-thought" className="italic">
            <Markdown source={block.text} className="chat-reasoning-prose" />
          </div>
        ) : (
          <div key={index} data-slot="chat-reasoning-narration">
            <Markdown source={block.text} className="chat-reasoning-prose" />
          </div>
        ),
      )}
    </div>
  );
}

/**
 * Inline reasoning lane for a turn: the model's private thinking (dim italic)
 * plus any narration it emitted between tool calls (dim, normal weight), shown
 * in the thread rather than hidden behind a modal.
 *
 * While the turn is live the reasoning streams in full so it's watchable; once
 * done it caps to ~6 lines with a fade and a "show more / show less" toggle
 * (only when it actually overflows). When a segment has no tool activity this
 * lane also carries the "Thinking… / Thought for Ns" segment-duration caption,
 * so that signal is never lost.
 */
export default function TurnReasoning({ turn, segment, span, showDuration, active = false }) {
  const ref = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  const reasoning = (segment && segment.reasoning) || [];
  const live = turn.status === "running";
  const capped = !live && !expanded;
  const hasReasoning = reasoning.length > 0;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || live || expanded) return;
    // Measure only while collapsed; once expanded we keep the toggle so the
    // user can re-collapse.
    setOverflowing(el.scrollHeight > el.clientHeight + 4);
  }, [live, expanded, reasoning]);

  if (!hasReasoning && !showDuration) return null;

  const showToggle = !live && hasReasoning && (overflowing || expanded);

  return (
    <div data-slot="chat-reasoning" data-expanded={expanded ? "true" : "false"}>
      {/* Reasoning-only segments own the turn's timer, so they keep a small
          caption ("Thinking…/Thought for Ns"). Tool-bearing segments leave the
          timer to their Activity row and carry no caption — the gutter dot below
          is their only marker, so the word "Reasoning" never repeats per turn. */}
      {showDuration ? (
        <span
          data-slot="chat-reasoning-caption"
          className={cn(
            "mb-1 inline-flex items-center gap-1.5 text-xs",
            active ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {active ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Sparkles className="size-3.5" aria-hidden />
          )}
          {active ? "Thinking… " : "Thought for "}
          <SpanDuration start={span?.start} end={span?.end} active={active} />
        </span>
      ) : null}
      {hasReasoning ? (
        <>
          <div className="flex gap-2">
            {/* Gutter marker: a quiet dot stands in for the old "Reasoning"
                label, marking the lane as the model's process without a repeated
                word. Reasoning-only segments already show the caption above, so
                they get an aligning spacer instead of a second marker — every
                reasoning block then shares one left text edge. */}
            {showDuration ? (
              <span className="w-1 shrink-0" aria-hidden />
            ) : (
              <span
                data-slot="chat-reasoning-dot"
                aria-hidden
                className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/40"
              />
            )}
            <div className="relative min-w-0 flex-1">
              <div ref={ref} className={cn(capped && CAP_CLASS, capped && "overflow-hidden")}>
                <ReasoningBody blocks={reasoning} />
              </div>
              {capped && overflowing ? (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-card/90 to-transparent"
                />
              ) : null}
            </div>
          </div>
          {showToggle ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded ? "true" : "false"}
              className="ml-3 mt-0.5 rounded text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {expanded ? "show less" : "show more"}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
