import { ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  CLAUDE_INSTALL_URL,
  describeClaudeInstallProgress,
  installErrorHint,
} from "@/components/onboarding/onboardingHelpers.js";
import {
  dismissClaudeSetup,
  recheckClaude,
  retryClaudeInstall,
  useClaudeSetupStore,
} from "@/store/claudeSetup.js";

/**
 * Modal shown when a chat send needs the `claude` CLI but it isn't installed.
 * The in-app installer starts automatically (see store/claudeSetup.js); this
 * renders its progress, and on failure surfaces the distilled error plus an
 * actionable hint, a retry, a manual-install link, and a re-check for users
 * who ran the terminal install themselves. Mounted once in ChatSidebar.
 */
export default function ClaudeSetupDialog() {
  const { open, phase, progress, errorMessage, hasPendingSend } = useClaudeSetupStore();

  const progressLabel = progress
    ? describeClaudeInstallProgress(progress)
    : "Preparing install…";
  const hint = phase === "error" ? installErrorHint(errorMessage) : null;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : dismissClaudeSetup())}>
      <DialogContent data-slot="claude-setup-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Setting up Vibe’s AI engine</DialogTitle>
          <DialogDescription>
            Vibe uses Claude Code to design your models. It isn’t on this
            computer yet, so Vibe is installing it for you — a one-time step.
            {hasPendingSend
              ? " Your message will send automatically once it’s ready."
              : ""}
          </DialogDescription>
        </DialogHeader>

        {phase === "error" ? (
          <div
            className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
            role="alert"
            data-slot="claude-setup-error"
          >
            <div className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
              <span className="text-destructive">{errorMessage || "Install failed"}</span>
            </div>
            {hint ? <p className="text-muted-foreground">{hint}</p> : null}
            <p className="text-muted-foreground">
              You can also install it yourself, then come back and re-check:{" "}
              <a
                href={CLAUDE_INSTALL_URL}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                data-slot="claude-setup-manual-link"
              >
                <ExternalLink className="size-3.5" /> Install Claude Code manually
              </a>
            </p>
          </div>
        ) : (
          <div
            className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm"
            data-slot="claude-setup-progress"
          >
            <Loader2 className="size-4 animate-spin" />
            <span>{progressLabel}</span>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => dismissClaudeSetup()}
            data-slot="claude-setup-dismiss"
          >
            Not now
          </Button>
          {phase === "error" ? (
            <>
              <Button
                variant="outline"
                onClick={() => void recheckClaude()}
                data-slot="claude-setup-recheck"
              >
                Re-check
              </Button>
              <Button
                variant="default"
                onClick={() => retryClaudeInstall()}
                data-slot="claude-setup-retry"
              >
                Try again
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
