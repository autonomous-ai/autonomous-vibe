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

  // One-click delegate: skip every preference and let Panda pick the best.
  const handleDelegate = async () => {
    if (turnInProgress || submitted) return;
    const res = await startTurn(
      "Build the best version — you decide every preference above. Pick the best " +
        "option for each and proceed without asking again.",
    );
    if (res) setSubmitted(true);
  };

  if (!list.length) return null;

  return (
    <div
      data-slot="chat-questions"
      className="rounded-2xl border border-border bg-muted p-3 text-sm text-foreground shadow-(--ui-shadow-soft)"
    >
      <div className="flex flex-col gap-3.5">
        {list.map((q, qi) => {
          const multi = !!q.multiSelect;
          const picks = selected[qi] || [];
          return (
            <div key={qi} data-slot="chat-question" className="flex flex-col gap-2.5">
              <p className="text-sm font-semibold leading-tight text-foreground">{q.question}</p>
              <div className="flex flex-wrap gap-2">
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
                        "inline-flex items-center rounded-full border px-3 py-2 text-[13px] font-medium transition-colors",
                        active
                          ? "border-emerald-500/55 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                          : "border-border bg-foreground/[0.04] text-muted-foreground hover:border-foreground/20 hover:bg-foreground/[0.08] hover:text-foreground",
                        submitted && !active && "opacity-55",
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
      <div className="mt-4 flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleDelegate}
          disabled={turnInProgress || submitted}
          data-slot="chat-questions-delegate"
          className="h-9 rounded-lg border-border bg-foreground/[0.02] px-4 text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground disabled:opacity-55"
        >
          Build the best (you decide)
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={handleSend}
          disabled={!allAnswered || turnInProgress || submitted}
          data-slot="chat-questions-send"
          // Fixed width so the label swap can't reflow the button (the swap
          // used to leave a "Send a…"/"Sent" ghost). Sent reads as a quiet,
          // deliberate green confirmation rather than a half-disabled button.
          className={cn(
            "min-w-20 rounded-lg bg-emerald-600 px-4 font-medium text-white hover:bg-emerald-500 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100",
            submitted &&
              "bg-emerald-500/15 text-emerald-700 ring-1 ring-emerald-500/30 hover:bg-emerald-500/15 disabled:bg-emerald-500/15 disabled:text-emerald-700 dark:text-emerald-300 dark:disabled:text-emerald-300",
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
