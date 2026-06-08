import { useState } from "react";
import { Check, ClipboardList, Pencil, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/ui/utils";
import { approvePlan, requestPlanChanges, useChatStore } from "@/store/chat";
import Markdown from "./Markdown";

const STATUS_PILL = {
  proposed: { label: "Awaiting approval", cls: "border-amber-500/40 bg-amber-500/10 text-amber-600" },
  approved: { label: "Approved", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600" },
  superseded: { label: "Superseded", cls: "border-border/60 bg-muted/30 text-muted-foreground" },
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
        "overflow-hidden rounded-xl border text-sm shadow-[var(--ui-shadow-soft)]",
        isProposed ? "border-primary/40 bg-primary/[0.04]" : "border-border bg-card",
        status === "superseded" && "opacity-60",
      )}
    >
      <header
        className={cn(
          "flex items-center gap-2.5 border-b px-3 py-2.5",
          isProposed ? "border-primary/30 bg-primary/[0.06]" : "border-border/60",
        )}
      >
        <span
          className={cn(
            "grid size-6 shrink-0 place-items-center rounded-full",
            isProposed ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
          )}
        >
          <ClipboardList className="size-3.5" aria-hidden />
        </span>
        <span className="text-[13px] font-semibold text-foreground">Here&apos;s my plan</span>
        <span className={cn("ml-auto rounded-full border px-2 py-0.5 text-[10px] font-medium", pill.cls)}>
          {pill.label}
        </span>
      </header>

      <div className="px-3 py-3">
        {editing ? (
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(20, Math.max(6, draft.split("\n").length + 1))}
            className="text-sm"
            data-slot="chat-plan-editor"
          />
        ) : (
          <Markdown source={editing ? draft : plan} className="leading-relaxed" />
        )}
      </div>

      {isProposed ? (
        feedbackOpen ? (
          <div className="flex flex-col gap-1.5 border-t border-border/60 bg-muted/20 px-3 py-2.5">
            <Textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="What should change? e.g. add 4 screw bosses, make it 5 mm taller…"
              rows={2}
              className="text-sm"
              data-slot="chat-plan-feedback"
            />
            <div className="flex justify-end gap-1.5">
              <Button variant="outline" size="sm" onClick={() => setFeedbackOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSendFeedback}
                disabled={busy || !feedback.trim()}
                data-slot="chat-plan-feedback-send"
              >
                Send feedback
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 bg-muted/20 px-3 py-2.5">
            <span className="mr-auto text-xs text-muted-foreground">
              Approve to build it, or ask for changes.
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing((v) => !v)}
              disabled={busy}
              data-slot="chat-plan-edit"
            >
              <Pencil aria-hidden />
              {editing ? "Done editing" : "Edit"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFeedbackOpen(true)}
              disabled={busy}
              data-slot="chat-plan-request-changes"
            >
              <MessageSquare aria-hidden />
              Request changes
            </Button>
            <Button
              size="sm"
              onClick={handleApprove}
              disabled={busy}
              data-slot="chat-plan-approve"
            >
              <Check aria-hidden />
              {busy ? "Building…" : "Approve & build"}
            </Button>
          </div>
        )
      ) : null}
    </div>
  );
}
