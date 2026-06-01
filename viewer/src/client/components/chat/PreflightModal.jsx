import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/ui/utils";
import { PREFLIGHT_ITEMS, preflightAllChecked } from "./preflightItems";

export { PREFLIGHT_ITEMS, preflightAllChecked };

export default function PreflightModal({
  open,
  onOpenChange,
  printerLabel,
  gcodeFile,
  onConfirm,
  busy = false,
}) {
  const [checked, setChecked] = useState({});

  const handleToggle = (id) => {
    setChecked((current) => ({ ...current, [id]: !current[id] }));
  };

  const allChecked = preflightAllChecked(checked);

  const handleConfirm = () => {
    if (!allChecked || busy) return;
    onConfirm?.();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="chat-preflight-modal" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Confirm before printing</DialogTitle>
          <DialogDescription>
            About to start <span className="font-medium">{gcodeFile || "the print job"}</span>
            {printerLabel ? <> on <span className="font-medium">{printerLabel}</span></> : null}.
            Confirm every safety check before the printer starts heating.
          </DialogDescription>
        </DialogHeader>
        <ul className="my-3 flex flex-col gap-2 text-sm">
          {PREFLIGHT_ITEMS.map((item) => (
            <li key={item.id} className="flex items-center gap-2">
              <input
                id={`preflight-${item.id}`}
                type="checkbox"
                checked={!!checked[item.id]}
                onChange={() => handleToggle(item.id)}
                data-slot="chat-preflight-check"
                data-id={item.id}
                className="size-4 accent-primary"
              />
              <label
                htmlFor={`preflight-${item.id}`}
                className={cn(
                  "cursor-pointer select-none",
                  checked[item.id] ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {item.label}
              </label>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange?.(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="default"
            onClick={handleConfirm}
            disabled={!allChecked || busy}
            data-slot="chat-preflight-confirm"
          >
            {busy ? "Starting…" : "Start print"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

