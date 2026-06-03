// Project library state. Backed by the `project_*` IPC commands from
// docs/panda-interfaces.md §2. The store deliberately stays small —
// catalog/manifest state lives in cadjs's existing `cadManifestStore`.

import { create } from "zustand";
import { transport } from "../lib/transport.ts";
import type { ProjectSummary } from "../lib/transport.ts";

export type ProjectsLoadStatus = "idle" | "loading" | "ready" | "error";

export interface ProjectsState {
  projects: ProjectSummary[];
  currentProjectId: string | null;
  status: ProjectsLoadStatus;
  error: string;
  refresh(): Promise<void>;
  create(name: string): Promise<ProjectSummary>;
  open(id: string): Promise<{ workspaceRoot: string }>;
  rename(id: string, name: string): Promise<ProjectSummary>;
  delete(id: string): Promise<void>;
  setCurrent(id: string | null): void;
}

function describeError(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err ?? "Unknown error");
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  projects: [],
  currentProjectId: null,
  status: "idle",
  error: "",

  async refresh() {
    set({ status: "loading", error: "" });
    try {
      const projects = await transport.project_list();
      const sorted = [...projects].sort((a, b) => b.updatedAt - a.updatedAt);
      const currentId = get().currentProjectId;
      const stillExists =
        currentId && sorted.some((p) => p.id === currentId) ? currentId : null;
      set({
        projects: sorted,
        status: "ready",
        error: "",
        currentProjectId: stillExists,
      });
    } catch (err) {
      set({ status: "error", error: describeError(err) });
      throw err;
    }
  },

  async create(name) {
    const trimmed = String(name || "").trim();
    if (!trimmed) {
      throw new Error("Project name cannot be empty");
    }
    const summary = await transport.project_create({ name: trimmed });
    set((state) => ({
      projects: [summary, ...state.projects.filter((p) => p.id !== summary.id)],
      currentProjectId: summary.id,
    }));
    return summary;
  },

  async open(id) {
    if (!id) {
      throw new Error("Cannot open project without an id");
    }
    const result = await transport.project_open(id);
    set({ currentProjectId: id });
    return result;
  },

  async rename(id, name) {
    if (!id) {
      throw new Error("Cannot rename project without an id");
    }
    const trimmed = String(name || "").trim();
    if (!trimmed) {
      throw new Error("Project name cannot be empty");
    }
    const summary = await transport.project_rename(id, trimmed);
    set((state) => ({
      projects: state.projects.map((p) => (p.id === summary.id ? summary : p)),
    }));
    return summary;
  },

  async delete(id) {
    if (!id) {
      throw new Error("Cannot delete project without an id");
    }
    await transport.project_delete(id);
    set((state) => ({
      projects: state.projects.filter((p) => p.id !== id),
      currentProjectId:
        state.currentProjectId === id ? null : state.currentProjectId,
    }));
  },

  setCurrent(id) {
    set({ currentProjectId: id });
  },
}));
