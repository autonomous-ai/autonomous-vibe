import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { resetTransport, setTransport } from "../../../lib/transport.ts";
import { useProjectsStore } from "../../../store/projects.ts";
import { submitNewProjectName } from "../projectListHelpers.js";

interface ProjectFixture {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  hasModel: boolean;
}

interface MockHistoryEntry {
  method: string;
  args: unknown[];
}

function createMockTransport(initial: ProjectFixture[] = []) {
  const projects: ProjectFixture[] = [...initial];
  const history: MockHistoryEntry[] = [];

  return {
    history,
    projects,
    impl: {
      app_info: () => Promise.reject({ code: "MOCK", message: "unused" }),
      catalog_read: () => Promise.reject({ code: "MOCK", message: "unused" }),
      generation_status_read: () => Promise.reject({ code: "MOCK", message: "unused" }),
      file_read_bytes: () => Promise.reject({ code: "MOCK", message: "unused" }),
      file_reveal: () => Promise.resolve(),
      step_source_status_read: () => Promise.reject({ code: "MOCK", message: "unused" }),
      step_artifact_regenerate: () => Promise.resolve(),
      chat_start_turn: () => Promise.reject({ code: "MOCK", message: "unused" }),
      chat_cancel_turn: () => Promise.resolve(),
      chat_session_state: () => Promise.reject({ code: "MOCK", message: "unused" }),
      slice_run: () => Promise.reject({ code: "MOCK", message: "unused" }),
      slice_status: () => Promise.reject({ code: "MOCK", message: "unused" }),
      printer_discover: () => Promise.resolve([]),
      printer_add: () => Promise.reject({ code: "MOCK", message: "unused" }),
      printer_list: () => Promise.resolve([]),
      printer_status: () => Promise.reject({ code: "MOCK", message: "unused" }),
      printer_upload_gcode: () => Promise.resolve(),
      printer_start_print: () => Promise.resolve(),
      project_list: () => {
        history.push({ method: "project_list", args: [] });
        return Promise.resolve(projects.map((p) => ({ ...p })));
      },
      project_create: (req: { name: string }) => {
        history.push({ method: "project_create", args: [req] });
        const summary: ProjectFixture = {
          id: `p-${projects.length + 1}`,
          name: req.name,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          hasModel: false,
        };
        projects.unshift(summary);
        return Promise.resolve({ ...summary });
      },
      project_open: (id: string) => {
        history.push({ method: "project_open", args: [id] });
        return Promise.resolve({ workspaceRoot: `/tmp/${id}` });
      },
      project_rename: (id: string, name: string) => {
        history.push({ method: "project_rename", args: [id, name] });
        const target = projects.find((p) => p.id === id);
        const summary: ProjectFixture = {
          id,
          name,
          createdAt: target?.createdAt ?? 0,
          updatedAt: Date.now(),
          hasModel: target?.hasModel ?? false,
        };
        if (target) {
          target.name = name;
        }
        return Promise.resolve({ ...summary });
      },
      project_delete: (id: string) => {
        history.push({ method: "project_delete", args: [id] });
        const index = projects.findIndex((p) => p.id === id);
        if (index >= 0) {
          projects.splice(index, 1);
        }
        return Promise.resolve();
      },
      app_prereq_check: () => Promise.reject({ code: "MOCK", message: "unused" }),
      app_settings_read: () => Promise.reject({ code: "MOCK", message: "unused" }),
      app_settings_write: () => Promise.resolve(),
      on: () => () => {},
    },
  };
}

beforeEach(() => {
  useProjectsStore.setState({
    projects: [],
    currentProjectId: null,
    status: "idle",
    error: "",
  });
});

afterEach(() => {
  resetTransport();
});

test("refresh populates the store from project_list and sorts newest-first", async () => {
  const mock = createMockTransport([
    { id: "p-old", name: "Older", createdAt: 1, updatedAt: 100, hasModel: false },
    { id: "p-new", name: "Newer", createdAt: 2, updatedAt: 500, hasModel: true },
  ]);
  setTransport(mock.impl as any);

  await useProjectsStore.getState().refresh();
  const state = useProjectsStore.getState();
  assert.equal(state.status, "ready");
  assert.deepEqual(
    state.projects.map((p) => p.id),
    ["p-new", "p-old"],
  );
  assert.equal(state.error, "");
  assert.equal(mock.history.length, 1);
});

test("refresh records errors and re-throws so callers can react", async () => {
  const mock = createMockTransport();
  mock.impl.project_list = () =>
    Promise.reject({ code: "BOOM", message: "list failed" });
  setTransport(mock.impl as any);

  await assert.rejects(() => useProjectsStore.getState().refresh());
  const state = useProjectsStore.getState();
  assert.equal(state.status, "error");
  assert.equal(state.error, "list failed");
});

test("create rejects empty names without hitting the transport", async () => {
  const mock = createMockTransport();
  setTransport(mock.impl as any);

  await assert.rejects(() => useProjectsStore.getState().create("   "));
  assert.equal(
    mock.history.filter((entry) => entry.method === "project_create").length,
    0,
  );
});

test("create posts a trimmed name via project_create and prepends the result", async () => {
  const mock = createMockTransport();
  setTransport(mock.impl as any);

  const summary = await useProjectsStore
    .getState()
    .create("  Wall Hook  ");
  assert.equal(summary.name, "Wall Hook");
  const calls = mock.history.filter((entry) => entry.method === "project_create");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args, [{ name: "Wall Hook" }]);
  assert.equal(useProjectsStore.getState().projects[0]?.name, "Wall Hook");
  assert.equal(useProjectsStore.getState().currentProjectId, summary.id);
});

test("submitNewProjectName forwards typed name to project_create", async () => {
  const mock = createMockTransport();
  setTransport(mock.impl as any);

  const summary = await submitNewProjectName(
    "Headphone Stand",
    useProjectsStore.getState(),
    [],
  );
  assert.equal(summary.name, "Headphone Stand");
  const calls = mock.history.filter((entry) => entry.method === "project_create");
  assert.deepEqual(calls[0]?.args, [{ name: "Headphone Stand" }]);
});

test("submitNewProjectName refuses duplicates before invoking transport", async () => {
  const mock = createMockTransport();
  setTransport(mock.impl as any);

  await assert.rejects(
    () => submitNewProjectName("Reused", useProjectsStore.getState(), ["reused"]),
    /already exists/,
  );
  assert.equal(
    mock.history.filter((entry) => entry.method === "project_create").length,
    0,
  );
});

test("rename trims the name, calls project_rename, and updates local state", async () => {
  const mock = createMockTransport([
    { id: "p1", name: "Old", createdAt: 1, updatedAt: 2, hasModel: false },
  ]);
  setTransport(mock.impl as any);
  await useProjectsStore.getState().refresh();

  const summary = await useProjectsStore.getState().rename("p1", "  Token Tray  ");
  assert.equal(summary.name, "Token Tray");
  const calls = mock.history.filter((entry) => entry.method === "project_rename");
  assert.deepEqual(calls[0]?.args, ["p1", "Token Tray"]);
  assert.equal(
    useProjectsStore.getState().projects.find((p) => p.id === "p1")?.name,
    "Token Tray",
  );
});

test("rename rejects an empty name without hitting the transport", async () => {
  const mock = createMockTransport([
    { id: "p1", name: "Old", createdAt: 1, updatedAt: 2, hasModel: false },
  ]);
  setTransport(mock.impl as any);
  await useProjectsStore.getState().refresh();

  await assert.rejects(() => useProjectsStore.getState().rename("p1", "   "));
  assert.equal(
    mock.history.filter((entry) => entry.method === "project_rename").length,
    0,
  );
});

test("delete drops the project from local state once the call resolves", async () => {
  const mock = createMockTransport([
    { id: "keep", name: "Keep", createdAt: 1, updatedAt: 2, hasModel: false },
    { id: "drop", name: "Drop", createdAt: 1, updatedAt: 1, hasModel: false },
  ]);
  setTransport(mock.impl as any);
  await useProjectsStore.getState().refresh();
  useProjectsStore.getState().setCurrent("drop");

  await useProjectsStore.getState().delete("drop");
  const state = useProjectsStore.getState();
  assert.deepEqual(
    state.projects.map((p) => p.id),
    ["keep"],
  );
  assert.equal(state.currentProjectId, null);
  const calls = mock.history.filter((entry) => entry.method === "project_delete");
  assert.deepEqual(calls[0]?.args, ["drop"]);
});
