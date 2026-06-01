"use client";

import { useMemo, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { createDeleteConfirmFlow } from "./deleteConfirmFlow.js";

/**
 * Destructive confirm. Blocks until the user clicks Delete; the action
 * remains disabled while the async `onConfirm` is in flight to prevent
 * double-submits.
 */
export default function DeleteConfirmDialog({
  open,
  projectName = "",
  onCancel,
  onConfirm,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const flow = useMemo(
    () => createDeleteConfirmFlow({ onConfirm, onCancel }),
    [onConfirm, onCancel],
  );

  const handleConfirm = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError("");
    const ok = await flow.confirm();
    if (!ok) {
      setError(flow.state.error || "Delete failed");
    }
    setBusy(false);
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) {
          onCancel?.();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete project?</AlertDialogTitle>
          <AlertDialogDescription>
            {projectName
              ? `“${projectName}” and all of its files will be permanently deleted from this device.`
              : "This project and all of its files will be permanently deleted from this device."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            disabled={busy}
            onClick={(event) => {
              event.preventDefault();
              void handleConfirm();
            }}
          >
            {busy ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
