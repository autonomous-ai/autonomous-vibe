"use client";

import { useMemo, useState } from "react";
import { ChevronDown, FolderPlus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useProjectsStore } from "@/store/projects.ts";
import { setProject as setChatProject } from "@/store/chat.js";
import { sortProjects } from "@/components/library/projectListHelpers.js";
import { PLACEHOLDER_PROJECT_NAME } from "@/components/chat/chatInputHelpers";
import DeleteConfirmDialog from "@/components/library/DeleteConfirmDialog.jsx";

/**
 * Top-bar project switcher. Replaces the old projects sidebar: the app focuses
 * on a single active project at a time, so project create/switch/delete lives
 * in a compact dropdown anchored next to the workspace sidebar toggle.
 *
 * No naming dialog and no rename: a new project is created with a placeholder
 * name that Claude Code's AI title replaces in place once available (see
 * commands/project.rs `resolve_ai_title`). The frozen IPC contract
 * (docs/panda-interfaces.md §Projects) exposes only project_list/create/open/delete.
 */
export default function ProjectMenu() {
  const projects = useProjectsStore((state) => state.projects);
  const currentProjectId = useProjectsStore((state) => state.currentProjectId);
  const open = useProjectsStore((state) => state.open);
  const create = useProjectsStore((state) => state.create);
  const deleteProject = useProjectsStore((state) => state.delete);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const sorted = useMemo(() => sortProjects(projects), [projects]);
  const current = sorted.find((project) => project.id === currentProjectId) || null;
  const others = sorted.filter((project) => project.id !== currentProjectId);

  const switchTo = async (id) => {
    try {
      await open(id);
      setChatProject(id);
    } catch (err) {
      console.warn("Failed to open project", err);
    }
  };

  const handleCreate = async () => {
    try {
      const summary = await create(PLACEHOLDER_PROJECT_NAME);
      if (summary?.id) {
        setChatProject(summary.id);
      }
    } catch (err) {
      console.warn("Failed to create project", err);
    }
  };

  const handleDelete = async () => {
    if (!currentProjectId) {
      return;
    }
    await deleteProject(currentProjectId);
    // The store clears currentProjectId when the active project is deleted;
    // fall back to the most recent remaining project (or none).
    const remaining = sortProjects(useProjectsStore.getState().projects);
    if (remaining[0]) {
      await switchTo(remaining[0].id);
    } else {
      setChatProject("");
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 max-w-[220px] shrink-0 gap-1"
            data-slot="project-menu-trigger"
            title={current?.name || "No project"}
          >
            <span className="truncate">{current?.name || "No project"}</span>
            <ChevronDown className="size-3.5 opacity-60" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[220px]">
          <DropdownMenuLabel>Project</DropdownMenuLabel>
          {others.length ? (
            <>
              {others.map((project) => (
                <DropdownMenuItem
                  key={project.id}
                  onSelect={() => void switchTo(project.id)}
                >
                  <span className="truncate">{project.name || "Untitled project"}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem onSelect={() => void handleCreate()}>
            <FolderPlus className="size-4" aria-hidden />
            New project
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            disabled={!currentProjectId}
            onSelect={() => setDeleteOpen(true)}
          >
            <Trash2 className="size-4" aria-hidden />
            Delete project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DeleteConfirmDialog
        open={deleteOpen}
        projectName={current?.name || ""}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={async () => {
          await handleDelete();
          setDeleteOpen(false);
        }}
      />
    </>
  );
}
