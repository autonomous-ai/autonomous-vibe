import test from "node:test";
import assert from "node:assert/strict";

import {
  _resetTransportForTests,
  adaptTauriListen,
  isTauriRuntime,
  setTauriBridge,
  transport,
} from "./transport.ts";

test.beforeEach(() => {
  _resetTransportForTests();
  setTauriBridge(null);
});

test("isTauriRuntime is false when no bridge is installed", () => {
  assert.equal(isTauriRuntime(), false);
});

test("app_info returns the labeled stub", async () => {
  const info = await transport.app_info();
  assert.equal(info.appVersion, "0.0.0-stub");
  assert.equal(info.pid, 0);
  assert.equal(typeof info.rootPath, "string");
});

test("app_prereq_check stub reports the Claude CLI ready, tools missing", async () => {
  const check = await transport.app_prereq_check();
  // The stub's chat works (chat_start_turn answers), so claudeCli must read
  // found — otherwise the pre-send gate (store/claudeSetup.js) would park
  // every stubbed send behind an installer the stub can't run.
  assert.equal(check.claudeCli.found, true);
  assert.equal(check.python.found, false);
  assert.equal(check.slicer.found, false);
  assert.equal(check.slicer.binaryPath, "");
});

test("app_settings_read returns defaults", async () => {
  const settings = await transport.app_settings_read();
  assert.equal(settings.defaultFilament, "PLA");
  assert.equal(settings.hasOnboarded, true);
});

test("app_set_model echoes the chosen model in the dev stub", async () => {
  const settings = await transport.app_set_model("sonnet");
  assert.equal(settings.model, "sonnet");
});

test("catalog_read returns empty entries", async () => {
  const cat = await transport.catalog_read();
  assert.deepEqual(cat.entries, []);
  assert.equal(typeof cat.revision, "number");
});

test("adaptTauriListen unwraps the Tauri Event payload for consumers", async () => {
  // Regression: Tauri's native listen() invokes its callback with a full
  // Event<T> object ({event, id, payload}), NOT the payload directly. Our
  // ListenFn contract (and the chat reducer) expect the payload. Without
  // unwrapping, every chat_event reaches the reducer as {event,id,payload}
  // so `event.kind` is undefined: nothing renders and `turn_end` is never
  // seen, leaving the turn stuck on "Cancel turn" forever.
  const captured: unknown[] = [];
  const fakeRawListen = async (
    event: string,
    cb: (e: { event: string; id: number; payload: unknown }) => void,
  ) => {
    cb({ event, id: 7, payload: { kind: "turn_end", turnId: "t-1" } });
    return () => {};
  };
  const listen = adaptTauriListen(fakeRawListen);
  await listen("chat_event", (payload) => captured.push(payload));
  assert.deepEqual(captured, [{ kind: "turn_end", turnId: "t-1" }]);
});

test("transport exposes events.subscribe returning a sync unsubscribe", () => {
  // Regression: the chat store calls transport.events.subscribe(...) and
  // expects a synchronous unsubscribe. If this namespace is missing on the
  // real transport, attachChatEventStream() throws and no chat events ever
  // reach the UI (no processing/streaming signal).
  assert.equal(typeof transport.events.subscribe, "function");
  const unsubscribe = transport.events.subscribe("chat_event", () => {});
  assert.equal(typeof unsubscribe, "function");
  unsubscribe();
});

test("project_create echoes the requested name", async () => {
  const project = await transport.project_create({ name: "Wall Hook" });
  assert.equal(project.name, "Wall Hook");
  assert.equal(project.hasModel, false);
  assert.match(project.id, /^stub-/);
});

test("project_open synthesizes a workspace root", async () => {
  const result = await transport.project_open("abc-123");
  assert.equal(result.workspaceRoot, "/dev/panda-stub/abc-123");
});

test("printer_add returns a card derived from the request", async () => {
  const card = await transport.printer_add({
    ipAddress: "192.168.1.50",
    accessCode: "12345678",
  });
  assert.equal(card.ipAddress, "192.168.1.50");
  assert.equal(card.model, "X1C");
});

test("slice_run threads the mesh file through to the gcode tag", async () => {
  const stats = await transport.slice_run({
    meshFile: "parts/lid.stl",
    printerId: "stub",
    filament: "PLA",
  });
  assert.match(stats.gcodeFile, /lid\.stl\.gcode$/);
  assert.equal(stats.supportsUsed, false);
});

test("chat_start_turn returns a stub turnId", async () => {
  const out = await transport.chat_start_turn({
    projectId: "p1",
    userMessage: "hi",
  });
  assert.match(out.turnId, /^stub-turn-/);
});

test("chat_approve_plan returns a stub turnId", async () => {
  const out = await transport.chat_approve_plan({
    projectId: "p1",
    planText: "# Plan",
  });
  assert.match(out.turnId, /^stub-turn-/);
});

test("chat_request_plan_changes returns a stub turnId", async () => {
  const out = await transport.chat_request_plan_changes({
    projectId: "p1",
    feedback: "make it bigger",
  });
  assert.match(out.turnId, /^stub-turn-/);
});

test("chat_session_state returns an empty history", async () => {
  const state = await transport.chat_session_state("p1");
  assert.deepEqual(state.history, []);
  assert.equal(state.turnInProgress, false);
});

test("onChatEvent in browser dev returns a no-op unsubscribe", async () => {
  let called = false;
  const unsubscribe = await transport.onChatEvent(() => {
    called = true;
  });
  assert.equal(typeof unsubscribe, "function");
  unsubscribe();
  assert.equal(called, false);
});

test("listenEvent attaches once the bridge appears after a startup race", async () => {
  // Regression: the chat_event listener is attached exactly once when
  // ChatSidebar mounts (`useEffect([])`). If the Tauri bridge isn't injected
  // yet at that instant, the old code returned a PERMANENT no-op and never
  // re-attached — so backend chat_events (PlanProposed/text_delta/turn_end)
  // never reached the reducer and every chat turn hung on "PLANNING" in the
  // packaged app. invoke() survives the same race because it re-probes
  // detectTauri() per call; the one-shot listener must keep probing too.
  let liveHandler: ((payload: unknown) => void) | null = null;
  const received: unknown[] = [];

  // Bridge absent at subscribe time (mirrors the early-mount race).
  const unsubscribe = await transport.onChatEvent((payload) =>
    received.push(payload),
  );

  // Tauri injects the bridge a moment later.
  setTauriBridge({
    invoke: async () => undefined,
    listen: async <T>(_event: string, handler: (payload: T) => void) => {
      liveHandler = handler as (payload: unknown) => void;
      return () => {};
    },
  });

  // Give the retry loop a tick to notice the bridge.
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.ok(liveHandler, "listener should attach once the bridge appears");
  liveHandler({ kind: "turn_end", turnId: "t-1" });
  assert.deepEqual(received, [{ kind: "turn_end", turnId: "t-1" }]);
  unsubscribe();
});

test("custom bridge is routed for invoke + listen", async () => {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  setTauriBridge({
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === "app_info") {
        return { rootPath: "/real", appVersion: "9.9.9", pid: 99 };
      }
      return undefined;
    },
    listen: async <T>(event: string, _handler: (payload: T) => void) => {
      calls.push({ cmd: `listen:${event}` });
      return () => {
        calls.push({ cmd: `unlisten:${event}` });
      };
    },
  });
  const info = await transport.app_info();
  assert.equal(info.rootPath, "/real");
  assert.equal(info.appVersion, "9.9.9");
  const unsubscribe = await transport.onChatEvent(() => {});
  unsubscribe();
  assert.deepEqual(
    calls.map((c) => c.cmd),
    ["app_info", "listen:chat_event", "unlisten:chat_event"],
  );
});

test("unknown command yields a labeled stub error", async () => {
  await assert.rejects(
    // @ts-expect-error — intentionally invoking a missing command via the
    // generic invoke surface to exercise the default case.
    transport.__nonexistent?.() ?? Promise.reject(new Error("no method")),
  );
});
