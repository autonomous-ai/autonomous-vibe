import {
  Toast,
  ToastProvider,
  ToastTitle,
  ToastViewport
} from "../ui/toast";

export default function StatusToast({ copyStatus, screenshotStatus, persistenceStatus, motionErrorStatus, sliceStatus, sliceStatusError, printStatus, printStatusError, previewMode, onClear }) {
  const message = motionErrorStatus || sliceStatus || printStatus || copyStatus || screenshotStatus || persistenceStatus;
  const isError = Boolean(motionErrorStatus) || (Boolean(sliceStatus) && sliceStatusError) || (Boolean(printStatus) && printStatusError);
  if (!message || previewMode) {
    return null;
  }

  // Success/info toasts auto-dismiss quickly; errors (e.g. a failed slice) linger
  // far longer, since a 2.2s flash is too easy to miss. (Slice errors also pin a
  // persistent chip on the toolbar, so the toast can still auto-clear.)
  const duration = isError ? 10000 : 2200;

  return (
    <ToastProvider duration={duration} swipeDirection="right">
      <Toast
        open={true}
        className={isError ? "border-destructive/40 text-destructive" : undefined}
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
