import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/ui/utils";
import { startTurn, useChatStore } from "@/store/chat";

/**
 * Renders a set of preference questions the model asked during planning
 * (parsed from a `panda-questions` fenced block) as clickable option chips.
 * Submitting sends the formatted answers back as a normal turn — the backend
 * stays in plan mode (session resume), so planning continues.
 *
 * @param {{ questions: Array<{question:string, header?:string, multiSelect?:boolean,
 *   options: Array<{label:string, description?:string}>}> }} props
 */
export default function QuestionCard({ questions }) {
  const turnInProgress = useChatStore((s) => s.turnInProgress);
  // selected: Map question-index -> Set(labels)
  const [selected, setSelected] = useState(() => ({}));
  const [submitted, setSubmitted] = useState(false);

  const list = Array.isArray(questions) ? questions : [];

  const toggle = (qi, label, multi) => {
    setSelected((cur) => {
      const prev = cur[qi] || [];
      let next;
      if (multi) {
        next = prev.includes(label)
          ? prev.filter((l) => l !== label)
          : [...prev, label];
      } else {
        next = prev.includes(label) && prev.length === 1 ? [] : [label];
      }
      return { ...cur, [qi]: next };
    });
  };

  const allAnswered = useMemo(
    () => list.length > 0 && list.every((_, qi) => (selected[qi] || []).length > 0),
    [list, selected],
  );

  const handleSend = async () => {
    if (!allAnswered || turnInProgress || submitted) return;
    const lines = list.map((q, qi) => {
      const picks = (selected[qi] || []).join(", ");
      return `- ${q.header || q.question}: ${picks}`;
    });
    const message = `My answers:\n${lines.join("\n")}`;
    const res = await startTurn(message);
    if (res) setSubmitted(true);
  };

  if (!list.length) return null;

  return (
    <div
      data-slot="chat-questions"
      className="rounded-lg border border-primary/30 bg-primary/[0.06] p-3 text-sm shadow-[var(--ui-shadow-soft)]"
    >
      <div className="flex flex-col gap-3.5">
        {list.map((q, qi) => {
          const multi = !!q.multiSelect;
          const picks = selected[qi] || [];
          return (
            <div key={qi} data-slot="chat-question" className="flex flex-col gap-1.5">
              <p className="font-medium text-foreground/90">{q.question}</p>
              <div className="flex flex-wrap gap-1.5">
                {(q.options || []).map((opt) => {
                  const active = picks.includes(opt.label);
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      disabled={submitted}
                      onClick={() => toggle(qi, opt.label, multi)}
                      title={opt.description || ""}
                      data-slot="chat-question-option"
                      data-active={active ? "true" : "false"}
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-xs transition-colors",
                        active
                          ? "border-primary bg-primary/15 text-foreground ring-1 ring-primary/40"
                          : "border-border/60 bg-background/60 text-muted-foreground hover:border-primary/50 hover:text-foreground",
                        submitted && !active && "opacity-50",
                      )}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex justify-end">
        <Button
          type="button"
          size="sm"
          onClick={handleSend}
          disabled={!allAnswered || turnInProgress || submitted}
          data-slot="chat-questions-send"
          // Fixed width so the label swap can't reflow the button (the swap
          // used to leave a "Send a…"/"Sent" ghost). Sent reads as a quiet,
          // deliberate confirmation rather than a half-disabled button.
          className={cn(
            "min-w-[7.5rem]",
            submitted &&
              "border border-emerald-500/40 bg-emerald-500/10 text-emerald-600 disabled:opacity-100",
          )}
        >
          {submitted ? (
            <>
              <Check className="size-3.5" aria-hidden />
              Sent
            </>
          ) : (
            "Send answers"
          )}
        </Button>
      </div>
    </div>
  );
}
