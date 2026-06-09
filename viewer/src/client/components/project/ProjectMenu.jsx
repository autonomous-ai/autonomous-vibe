"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, FolderPlus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useProjectsStore } from "@/store/projects.ts";
import { setProject as setChatProject } from "@/store/chat.js";
import { sortProjects } from "@/components/library/projectListHelpers.js";
import { PLACEHOLDER_PROJECT_NAME } from "@/components/chat/chatInputHelpers";
import DeleteConfirmDialog from "@/components/library/DeleteConfirmDialog.jsx";
import AddPrinterDialog from "@/components/printer/AddPrinterDialog.jsx";
import { PRINT_CONFIG_CHANGED_EVENT } from "@/components/chat/actionButtonsHelpers";
import { transport } from "@/lib/transport.ts";

/**
 * Top-bar project menu. Project switching now lives in the workspace sidebar's
 * project tree (each project expands to its files; clicking a file switches the
 * active project). This dropdown is reduced to create + delete; the trigger
 * still shows the active project's name. Delete targets the active project.
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
  const [addPrinterOpen, setAddPrinterOpen] = useState(false);

  // The native "Printer → Add Printer…" menu item (see src-tauri/src/menu.rs)
  // can't render the dialog itself, so it emits `open_add_printer`; open it here.
  useEffect(() => {
    const unsubscribe = transport.events.subscribe("open_add_printer", () => {
      setAddPrinterOpen(true);
    });
    return () => unsubscribe();
  }, []);

  const sorted = useMemo(() => sortProjects(projects), [projects]);
  const current = sorted.find((project) => project.id === currentProjectId) || null;

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

      <AddPrinterDialog
        open={addPrinterOpen}
        onOpenChange={(next) => {
          setAddPrinterOpen(next);
          // This dialog (opened from the native Printer menu) can change the
          // paired printers / default device, but the workspace toolbar lives in
          // another component. Signal it on close so the Print button label
          // re-reads the config instead of showing a stale device.
          if (!next && typeof window !== "undefined") {
            window.dispatchEvent(new Event(PRINT_CONFIG_CHANGED_EVENT));
          }
        }}
      />
    </>
  );
}
