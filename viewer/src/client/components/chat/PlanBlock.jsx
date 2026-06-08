import { useState } from "react";
import { ClipboardList, Pencil, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/ui/utils";
import { approvePlan, requestPlanChanges, useChatStore } from "@/store/chat";
import Markdown from "./Markdown";

const STATUS_PILL = {
  proposed: { label: "Awaiting approval", cls: "border-amber-500/35 bg-amber-500/15 text-amber-400" },
  approved: { label: "Approved", cls: "border-emerald-500/40 bg-emerald-500/15 text-emerald-400" },
  superseded: { label: "Superseded", cls: "border-white/10 bg-white/5 text-zinc-400" },
};

/**
 * Inline plan-review card. Renders the proposed plan as markdown with
 * edit / approve / request-changes controls. Modeled on PreflightModal's
 * confirm pattern, but lives in the chat turn rather than a modal.
 *
 * @param {{ plan: string, status: "proposed"|"approved"|"superseded" }} props
 */
export default function PlanBlock({ plan, status }) {
  const turnInProgress = useChatStore((s) => s.turnInProgress);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(plan);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState("");

  const pill = STATUS_PILL[status] || STATUS_PILL.proposed;
  const isProposed = status === "proposed";
  const busy = turnInProgress;

  const handleApprove = () => {
    if (busy) return;
    void approvePlan(editing ? draft : plan);
  };

  const handleSendFeedback = () => {
    if (busy || !feedback.trim()) return;
    void requestPlanChanges(feedback);
  };

  return (
    <div
      data-slot="chat-plan"
      data-status={status}
      className={cn(
        "rounded-xl border border-border/70 bg-[#202124] p-3 text-sm text-zinc-100 shadow-(--ui-shadow-soft)",
        !isProposed && "bg-card/70",
        status === "superseded" && "opacity-60",
      )}
    >
      <header className="mb-3 flex items-center gap-2 border-b border-white/10 pb-2.5">
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full border",
            isProposed
              ? "border-white/10 bg-white/5 text-zinc-300"
              : "border-white/10 bg-white/5 text-zinc-400",
          )}
        >
          <ClipboardList className="size-3.5" aria-hidden />
        </span>
        <span className="text-sm font-semibold text-zinc-100">Here&apos;s my plan</span>
        <span className={cn("ml-auto rounded-full border px-2 py-0.5 text-[10px] font-semibold", pill.cls)}>
          {pill.label}
        </span>
      </header>

      {editing ? (
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={Math.min(20, Math.max(6, draft.split("\n").length + 1))}
          className="border-white/10 bg-black/20 text-sm text-zinc-100"
          data-slot="chat-plan-editor"
        />
      ) : (
        <Markdown
          source={editing ? draft : plan}
          className="text-[13px] font-medium leading-relaxed text-zinc-100 [&_code]:bg-white/8 [&_code]:text-zinc-100 [&_li]:my-1.5 [&_p]:my-1.5 [&_strong]:text-zinc-50"
        />
      )}

      {isProposed ? (
        <>
          {feedbackOpen ? (
            <div className="mt-3 flex flex-col gap-2">
              <Textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="What should change? e.g. add 4 screw bosses, make it 5 mm taller…"
                rows={2}
                className="border-white/10 bg-black/20 text-sm text-zinc-100 placeholder:text-zinc-500"
                data-slot="chat-plan-feedback"
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setFeedbackOpen(false)}
                  disabled={busy}
                  className="border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10 hover:text-zinc-50"
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleSendFeedback}
                  disabled={busy || !feedback.trim()}
                  data-slot="chat-plan-feedback-send"
                  className="bg-zinc-100 text-zinc-950 hover:bg-white"
                >
                  Send feedback
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="mr-auto text-[11px] text-zinc-500">
                Approve to build it, or ask for changes.
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditing((v) => !v)}
                disabled={busy}
                data-slot="chat-plan-edit"
                className="h-8 border-white/10 bg-white/5 px-3 text-zinc-200 hover:bg-white/10 hover:text-zinc-50"
              >
                <Pencil className="size-3.5" aria-hidden />
                {editing ? "Done editing" : "Edit"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setFeedbackOpen(true)}
                disabled={busy}
                data-slot="chat-plan-request-changes"
                className="h-8 border-white/10 bg-white/5 px-3 text-zinc-200 hover:bg-white/10 hover:text-zinc-50"
              >
                <MessageSquare className="size-3.5" aria-hidden />
                Request changes
              </Button>
              <Button
                size="sm"
                onClick={handleApprove}
                disabled={busy}
                data-slot="chat-plan-approve"
                className="h-8 bg-zinc-100 px-3 text-zinc-950 hover:bg-white"
              >
                {busy ? "Building…" : "Approve & build"}
              </Button>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
