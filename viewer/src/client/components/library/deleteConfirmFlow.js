// Pure flow controller for the destructive-confirm dialog. Wraps the
// onConfirm/onCancel hooks so the test can drive the state machine without
// rendering React.

export function createDeleteConfirmFlow({ onConfirm, onCancel }) {
  const state = {
    busy: false,
    cancelled: false,
    confirmed: false,
    error: "",
  };

  async function confirm() {
    if (state.busy || state.confirmed) {
      return false;
    }
    state.busy = true;
    state.error = "";
    try {
      await onConfirm?.();
      state.confirmed = true;
      return true;
    } catch (err) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String(err.message || "Delete failed")
          : String(err || "Delete failed");
      state.error = message;
      return false;
    } finally {
      state.busy = false;
    }
  }

  function cancel() {
    if (state.busy) {
      // Cancel is blocked while the destructive action is in flight.
      return false;
    }
    state.cancelled = true;
    onCancel?.();
    return true;
  }

  return { state, confirm, cancel };
}
