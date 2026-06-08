import {
  Toast,
  ToastProvider,
  ToastTitle,
  ToastViewport
} from "../ui/toast";

export default function StatusToast({ copyStatus, screenshotStatus, persistenceStatus, motionErrorStatus, sliceStatus, sliceStatusSeverity, printStatus, printStatusError, previewMode, onClear }) {
  const message = motionErrorStatus || sliceStatus || printStatus || copyStatus || screenshotStatus || persistenceStatus;
  const isError = Boolean(motionErrorStatus) || (Boolean(sliceStatus) && sliceStatusSeverity === "error") || (Boolean(printStatus) && printStatusError);
  // A slice can also succeed *with* warnings the slicer raised about the model
  // (floating regions, unsupported overhangs) — amber, not red: the plate sliced.
  const isWarning = !isError && Boolean(sliceStatus) && sliceStatusSeverity === "warning";
  if (!message || previewMode) {
    return null;
  }

  // Success/info toasts auto-dismiss quickly; errors and warnings (e.g. a failed
  // slice, or floating-region warnings to act on) linger far longer, since a 2.2s
  // flash is too easy to miss. (Slice errors also pin a persistent toolbar chip,
  // so the toast can still auto-clear.)
  const duration = (isError || isWarning) ? 10000 : 2200;

  return (
    <ToastProvider duration={duration} swipeDirection="right">
      <Toast
        open={true}
        className={
          isError
            ? "border-destructive/40 text-destructive"
            : isWarning
              ? "border-amber-500/45 bg-amber-500/10 text-amber-800 dark:text-amber-300"
              : undefined
        }
        onOpenChange={(open) => {
          if (!open) {
            onClear?.();
          }
        }}
      >
        <ToastTitle>{message}</ToastTitle>
      </Toast>
      <ToastViewport />
    </ToastProvider>
  );
}
