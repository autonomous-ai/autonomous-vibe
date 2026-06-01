import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { resetTransport, setTransport } from "../../../lib/transport.ts";
import { handlePrinterSkip } from "../onboardingHelpers.js";

interface HistoryEntry {
  method: string;
  args: unknown[];
}

function createMockTransport() {
  const history: HistoryEntry[] = [];
  const reject = (method: string) => () => {
    history.push({ method, args: [] });
    return Promise.reject({ code: "MOCK", message: `${method} should not be invoked` });
  };
  return {
    history,
    impl: {
      app_info: reject("app_info"),
      catalog_read: reject("catalog_read"),
      generation_status_read: reject("generation_status_read"),
      file_read_bytes: reject("file_read_bytes"),
      file_reveal: reject("file_reveal"),
      step_source_status_read: reject("step_source_status_read"),
      step_artifact_regenerate: reject("step_artifact_regenerate"),
      chat_start_turn: reject("chat_start_turn"),
      chat_cancel_turn: reject("chat_cancel_turn"),
      chat_session_state: reject("chat_session_state"),
      slice_run: reject("slice_run"),
      slice_status: reject("slice_status"),
      printer_discover: (...args: unknown[]) => {
        history.push({ method: "printer_discover", args });
        return Promise.resolve([]);
      },
      printer_add: (...args: unknown[]) => {
        history.push({ method: "printer_add", args });
        return Promise.reject({ code: "MOCK", message: "add should not run on skip" });
      },
      printer_list: () => Promise.resolve([]),
      printer_status: reject("printer_status"),
      printer_upload_gcode: reject("printer_upload_gcode"),
      printer_start_print: reject("printer_start_print"),
      project_list: () => Promise.resolve([]),
      project_create: reject("project_create"),
      project_open: reject("project_open"),
      project_delete: reject("project_delete"),
      app_prereq_check: reject("app_prereq_check"),
      app_settings_read: reject("app_settings_read"),
      app_settings_write: () => Promise.resolve(),
      on: () => () => {},
    },
  };
}

afterEach(() => {
  resetTransport();
});

test("PrinterStep skip path leaves printer_add untouched and signals advance", () => {
  const mock = createMockTransport();
  setTransport(mock.impl as any);

  let advanced = false;
  handlePrinterSkip({
    onAdvance: () => {
      advanced = true;
    },
  });

  assert.equal(advanced, true);
  assert.equal(
    mock.history.find((entry) => entry.method === "printer_add"),
    undefined,
    "skip path must not pair a printer",
  );
});
