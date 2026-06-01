import assert from "node:assert/strict";
import test from "node:test";
import { createDeleteConfirmFlow } from "../deleteConfirmFlow.js";

test("delete remains pending until the user confirms", async () => {
  let confirms = 0;
  const flow = createDeleteConfirmFlow({
    onConfirm: () => {
      confirms += 1;
      return Promise.resolve();
    },
  });

  assert.equal(flow.state.confirmed, false, "starts unconfirmed");
  assert.equal(confirms, 0, "no transport calls before confirm()");
});

test("confirm awaits onConfirm and then flips state", async () => {
  let resolveDelete = () => {};
  const deletePromise = new Promise((resolve) => {
    resolveDelete = resolve;
  });
  const flow = createDeleteConfirmFlow({
    onConfirm: () => deletePromise,
  });

  const confirming = flow.confirm();
  // While the action is in flight, busy is true and cancel is blocked.
  await Promise.resolve();
  assert.equal(flow.state.busy, true);
  assert.equal(flow.cancel(), false, "cancel is ignored while busy");
  resolveDelete();
  const ok = await confirming;
  assert.equal(ok, true);
  assert.equal(flow.state.confirmed, true);
  assert.equal(flow.state.busy, false);
});

test("confirm captures errors and leaves the dialog open for retry", async () => {
  const flow = createDeleteConfirmFlow({
    onConfirm: () => Promise.reject({ message: "delete failed" }),
  });
  const ok = await flow.confirm();
  assert.equal(ok, false);
  assert.equal(flow.state.confirmed, false);
  assert.equal(flow.state.error, "delete failed");
});

test("cancel marks the flow cancelled and invokes onCancel", () => {
  let cancels = 0;
  const flow = createDeleteConfirmFlow({
    onCancel: () => {
      cancels += 1;
    },
  });
  assert.equal(flow.cancel(), true);
  assert.equal(flow.state.cancelled, true);
  assert.equal(cancels, 1);
});

test("re-confirm is a no-op after a successful delete", async () => {
  let confirms = 0;
  const flow = createDeleteConfirmFlow({
    onConfirm: () => {
      confirms += 1;
      return Promise.resolve();
    },
  });
  await flow.confirm();
  await flow.confirm();
  assert.equal(confirms, 1, "second confirm() is ignored");
});
