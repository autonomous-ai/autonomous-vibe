import { useState } from "react";
import { ClipboardList, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/ui/utils";
import { approvePlan, requestPlanChanges, useChatStore } from "@/store/chat";
import { useAutopilot } from "@/lib/autopilot";
import Markdown from "./Markdown";

const STATUS_PILL = {
  proposed: { label: "Awaiting approval", cls: "border-amber-500/35 bg-amber-500/15 text-amber-400" },
  approved: { label: "Approved", cls: "border-emerald-500/40 bg-emerald-500/15 text-emerald-400" },
  superseded: { label: "Superseded", cls: "border-white/10 bg-white/5 text-zinc-400" },
};

// Under autopilot the plan is informational only — the build starts on its own.
const AUTOPILOT_PILL = {
  label: "Building automatically",
  cls: "border-emerald-500/40 bg-emerald-500/15 text-emerald-400",
};

// Plan-body markdown styling. The plan content drives the layout: `###`
// headings become the small uppercase section labels ("What I'll make",
// "Build steps"), inline `code` becomes the dimension chips, and the ordered
// list is rendered as numbered badge steps via CSS counters.
const PLAN_MD = cn(
  "text-[13.5px] leading-relaxed text-zinc-300",
  "[&_strong]:font-semibold [&_strong]:text-white",
  "[&_h3]:mt-5 [&_h3]:mb-2.5 [&_h3]:text-[11px] [&_h3]:font-semibold [&_h3]:uppercase [&_h3]:tracking-[0.09em] [&_h3]:text-zinc-500 [&_h3:first-child]:mt-0",
  "[&_p]:my-0 [&_p]:text-[13.5px] [&_p]:leading-relaxed [&_p]:text-zinc-300",
  "[&_code]:rounded-md [&_code]:bg-white/[0.04] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px] [&_code]:text-zinc-300",
  "[&_ol]:mt-2.5 [&_ol]:mb-0 [&_ol]:flex [&_ol]:list-none [&_ol]:flex-col [&_ol]:gap-2.5 [&_ol]:pl-0 [&_ol]:[counter-reset:step]",
  "[&_ol>li]:m-0 [&_ol>li]:flex [&_ol>li]:items-start [&_ol>li]:gap-3 [&_ol>li]:[counter-increment:step]",
  "[&_ol>li]:before:[content:counter(step)] [&_ol>li]:before:mt-px [&_ol>li]:before:flex [&_ol>li]:before:size-5 [&_ol>li]:before:shrink-0 [&_ol>li]:before:items-center [&_ol>li]:before:justify-center [&_ol>li]:before:rounded-md [&_ol>li]:before:bg-white/[0.04] [&_ol>li]:before:text-[11px] [&_ol>li]:before:font-semibold [&_ol>li]:before:leading-none [&_ol>li]:before:text-zinc-400",
);

/**
 * Inline plan-review card. Renders the proposed plan as markdown with
 * edit / approve / request-changes controls. Modeled on PreflightModal's
 * confirm pattern, but lives in the chat turn rather than a modal.
 *
 * @param {{ plan: string, status: "proposed"|"approved"|"superseded" }} props
 */
export default function PlanBlock({ plan, status }) {
  const turnInProgress = useChatStore((s) => s.turnInProgress);
  const autopilot = useAutopilot();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(plan);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState("");

  // Autopilot: the plan is read-only (the build chains automatically); show a
  // "Building automatically" pill and no approve/edit/feedback footer.
  const pill =
    autopilot && status === "proposed"
      ? AUTOPILOT_PILL
      : STATUS_PILL[status] || STATUS_PILL.proposed;
  const isProposed = status === "proposed" && !autopilot;
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
        "overflow-hidden rounded-2xl border border-white/[0.08] bg-[#16181c] text-sm text-zinc-100",
        "bg-[linear-gradient(to_bottom,rgba(52,211,153,0.1)_0,rgba(52,211,153,0.1)_46px,rgba(52,211,153,0)_64px)]",
        status === "superseded" && "opacity-60",
      )}
    >
      <header className="flex items-center gap-2.5 px-3.5 py-3.5">
        <ClipboardList className="size-[18px] shrink-0 text-emerald-400" aria-hidden />
        <span className="text-[15px] font-semibold text-white">Here&apos;s my plan</span>
        <span className={cn("ml-auto rounded-full border px-2.5 py-1 text-[11px] font-semibold", pill.cls)}>
          {pill.label}
        </span>
      </header>

      <div className="px-3.5 py-3.5">
        {editing ? (
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(20, Math.max(6, draft.split("\n").length + 1))}
            className="scrollbar-thin border-white/10 bg-black/20 text-sm text-zinc-100"
            data-slot="chat-plan-editor"
          />
        ) : (
          <Markdown source={editing ? draft : plan} className={PLAN_MD} />
        )}
      </div>

      {isProposed ? (
        feedbackOpen ? (
          <div className="flex flex-col gap-2 border-t border-white/[0.06] px-5 py-3.5">
            <Textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="What should change? e.g. add 4 screw bosses, make it 5 mm taller…"
              rows={2}
              className="scrollbar-thin border-white/10 bg-black/20 text-sm text-zinc-100 placeholder:text-zinc-500"
              data-slot="chat-plan-feedback"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setFeedbackOpen(false)}
                disabled={busy}
                className="h-9 rounded-lg border-white/10 bg-white/[0.02] px-4 text-zinc-200 hover:bg-white/[0.07] hover:text-zinc-50"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSendFeedback}
                disabled={busy || !feedback.trim()}
                data-slot="chat-plan-feedback-send"
                className="h-9 rounded-lg bg-emerald-400 px-4 text-emerald-950 hover:bg-emerald-300"
              >
                Send feedback
              </Button>
            </div>
          </div>
        ) : (
          <footer className="flex items-center justify-between gap-2 border-t border-white/[0.06] px-3.5 py-3.5">
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditing((v) => !v)}
                disabled={busy}
                data-slot="chat-plan-edit"
                className="h-9 rounded-lg border-white/10 bg-white/[0.02] px-4 text-zinc-200 hover:bg-white/[0.07] hover:text-zinc-50"
              >
                {editing ? "Done editing" : "Edit"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setFeedbackOpen(true)}
                disabled={busy}
                data-slot="chat-plan-request-changes"
                className="h-9 rounded-lg border-white/10 bg-white/[0.02] px-4 text-zinc-200 hover:bg-white/[0.07] hover:text-zinc-50"
              >
                Request changes
              </Button>
            </div>
            <Button
              size="sm"
              onClick={handleApprove}
              disabled={busy}
              data-slot="chat-plan-approve"
              className="h-9 rounded-lg bg-emerald-400 px-4 text-emerald-950 hover:bg-emerald-300"
            >
              <Check className="size-4" aria-hidden />
              {busy ? "Building…" : "Approve & build"}
            </Button>
          </footer>
        )
      ) : null}
    </div>
  );
}
