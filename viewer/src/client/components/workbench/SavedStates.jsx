import { useCallback, useEffect, useRef, useState } from "react";
import { History, Loader2, RotateCcw, Save, Trash2 } from "lucide-react";
import { refreshCadCatalog } from "cadjs/lib/cadManifestStore";
import { cn } from "@/ui/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { getTransport } from "../../lib/transport.ts";
import { noteRevert, useChatStore } from "../../store/chat.js";

// Friendly "3m ago" / "2h ago" / date for older saves. Kept tiny + local — the
// list is short and only ever shows a project's own save-states.
function relativeTime(ms) {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ms).toLocaleDateString();
}

function defaultLabel(count) {
  return `Version ${count + 1}`;
}

/**
 * Git-tag-style model save-states. An icon button on the active project's
 * sidebar header (inline with the project name) opens a popover to save the
 * current model as a named checkpoint and to revert to an earlier one.
 * Reverting swaps only the model files and drops a linear
 * "↩ Reverted to …" marker into the chat (the backend tells the next turn its
 * files went back); the append-only Claude session is never forked. See
 * `docs/future-work-version-control.md` and `commands/snapshot.rs`.
 */
export default function SavedStates({ projectId }) {
  const transport = getTransport();
  const turnInProgress = useChatStore((s) => s.turnInProgress);

  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState(defaultLabel(0));
  const [saving, setSaving] = useState(false);
  const [confirmingId, setConfirmingId] = useState("");
  const [busyId, setBusyId] = useState("");

  // Avoid a stale-response clobber if the user reopens / switches mid-load.
  const reqRef = useRef(0);

  const load = useCallback(async () => {
    if (!projectId) return;
    const req = ++reqRef.current;
    setLoading(true);
    setError("");
    try {
      const list = await transport.snapshot_list(projectId);
      if (reqRef.current !== req) return;
      const safe = Array.isArray(list) ? list : [];
      setItems(safe);
      setName(defaultLabel(safe.length));
    } catch (err) {
      if (reqRef.current !== req) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (reqRef.current === req) setLoading(false);
    }
  }, [projectId, transport]);

  // Load on open; reset transient UI when it closes.
  useEffect(() => {
    if (open) {
      load();
    } else {
      setConfirmingId("");
      setError("");
    }
  }, [open, load]);

  const handleSave = useCallback(async () => {
    if (!projectId || saving || turnInProgress) return;
    setSaving(true);
    setError("");
    try {
      const label = name.trim() || defaultLabel(items.length);
      const summary = await transport.snapshot_save(projectId, label);
      setItems((prev) => [summary, ...prev]);
      setName(defaultLabel(items.length + 1));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [projectId, saving, turnInProgress, name, items.length, transport]);

  const handleRestore = useCallback(
    async (id) => {
      if (!projectId || busyId || turnInProgress) return;
      setBusyId(id);
      setError("");
      try {
        const summary = await transport.snapshot_restore(projectId, id);
        // Reload the viewer from the reverted files, then mark the chat.
        await refreshCadCatalog({ markRefreshing: true }).catch(() => {});
        noteRevert(summary?.label || "saved state");
        setConfirmingId("");
        setOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId("");
      }
    },
    [projectId, busyId, turnInProgress, transport],
  );

  const handleDelete = useCallback(
    async (id) => {
      if (!projectId || busyId) return;
      setBusyId(id);
      setError("");
      try {
        await transport.snapshot_delete(projectId, id);
        setItems((prev) => prev.filter((s) => s.id !== id));
        if (confirmingId === id) setConfirmingId("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId("");
      }
    },
    [projectId, busyId, confirmingId, transport],
  );

  return (
    <TooltipProvider delayDuration={250}>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Saved states"
                className="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              >
                <History className="size-3.5" strokeWidth={2} aria-hidden />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Saved states
          </TooltipContent>
        </Tooltip>

        <PopoverContent align="start" sideOffset={8} className="w-80 p-0">
          <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
            <span className="text-sm font-medium">Saved states</span>
            <span className="text-[11px] text-muted-foreground">
              like a git tag — revert anytime
            </span>
          </div>

          {/* Save the current model as a named checkpoint. */}
          <div className="flex items-center gap-1.5 px-3 py-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleSave();
                }
              }}
              placeholder="Name this state"
              disabled={saving || turnInProgress}
              className="h-8 text-sm"
            />
            <Button
              type="button"
              size="sm"
              onClick={() => void handleSave()}
              disabled={saving || turnInProgress}
              className="h-8 shrink-0 gap-1.5"
            >
              {saving ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <Save className="size-3.5" aria-hidden />
              )}
              Save
            </Button>
          </div>

          {turnInProgress ? (
            <p className="px-3 pb-2 text-[11px] text-muted-foreground">
              Saving and reverting are paused while a model is generating.
            </p>
          ) : null}

          {error ? (
            <p className="px-3 pb-2 text-xs text-destructive">{error}</p>
          ) : null}

          {/* The list of saved states, newest first. */}
          <div className="max-h-72 overflow-y-auto border-t border-border/60 py-1">
            {loading ? (
              <p className="flex items-center gap-1.5 px-3 py-3 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Loading…
              </p>
            ) : items.length === 0 ? (
              <p className="px-3 py-3 text-xs text-muted-foreground">
                No saved states yet. Save one above to lock in the current model
                before you keep editing.
              </p>
            ) : (
              items.map((snap) => {
                const isConfirming = confirmingId === snap.id;
                const isBusy = busyId === snap.id;
                return (
                  <div
                    key={snap.id}
                    className="group/snap flex items-center gap-2 px-3 py-1.5 hover:bg-accent/50"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{snap.label}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {relativeTime(snap.createdAt)}
                      </p>
                    </div>

                    {isConfirming ? (
                      <div className="flex items-center gap-1">
                        <span className="mr-1 text-[11px] text-muted-foreground">
                          Revert model?
                        </span>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() => setConfirmingId("")}
                          disabled={isBusy}
                          className="h-7"
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          onClick={() => void handleRestore(snap.id)}
                          disabled={isBusy || turnInProgress}
                          className="h-7 gap-1"
                        >
                          {isBusy ? (
                            <Loader2 className="size-3 animate-spin" aria-hidden />
                          ) : (
                            <RotateCcw className="size-3" aria-hidden />
                          )}
                          Revert
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-0.5">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              size="icon-xs"
                              variant="ghost"
                              aria-label={`Revert to ${snap.label}`}
                              onClick={() => setConfirmingId(snap.id)}
                              disabled={Boolean(busyId) || turnInProgress}
                              className="size-7"
                            >
                              <RotateCcw className="size-3.5" aria-hidden />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">Revert to this</TooltipContent>
                        </Tooltip>
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Delete ${snap.label}`}
                          onClick={() => void handleDelete(snap.id)}
                          disabled={Boolean(busyId)}
                          className={cn(
                            "size-7 text-muted-foreground opacity-0 transition-opacity",
                            "group-hover/snap:opacity-100 focus-visible:opacity-100 hover:text-destructive",
                          )}
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}
