import { useEffect, useState } from "react";
import {
  ArrowUpFromLine,
  Bot,
  Boxes,
  ChevronRight,
  Code,
  Cuboid,
  DraftingCompass,
  FileBox,
  Folder,
  FolderPlus,
  Layers3,
  LoaderCircle,
  Package,
  Route,
  Trash2,
  Upload
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader as SheetHeaderPrimitive,
  SheetTitle
} from "@/components/ui/sheet";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
  useSidebar
} from "@/components/ui/sidebar";
import { cn } from "@/ui/utils";
import {
  ENTRY_ICON_KIND,
  entryIconKind
} from "@/workbench/entryIconKind";
import {
  entryIconStatus,
  entryStepSourceKind
} from "@/workbench/entryIconStatus";
import {
  fileKey,
  listSidebarItems,
  sidebarLabelForEntry
} from "@/workbench/sidebar";
import FileAccessContextMenu from "./FileAccessContextMenu";
import SavedStates from "./SavedStates";

const DESKTOP_FILE_VIEWER_MIN_WIDTH = 150;
const DESKTOP_FILE_VIEWER_MAX_WIDTH = "calc(100vw - 0.75rem)";
const MOBILE_FILE_VIEWER_WIDTH = "min(18rem, calc(100vw - 0.75rem))";

const ENTRY_ICON_COMPONENTS = {
  [ENTRY_ICON_KIND.LOADING]: LoaderCircle,
  [ENTRY_ICON_KIND.ASSEMBLY]: Boxes,
  [ENTRY_ICON_KIND.DXF]: DraftingCompass,
  [ENTRY_ICON_KIND.GCODE]: Route,
  [ENTRY_ICON_KIND.IMPLICIT]: Code,
  [ENTRY_ICON_KIND.ROBOT]: Bot,
  [ENTRY_ICON_KIND.STEP_PART]: Package,
  [ENTRY_ICON_KIND.STL_MESH]: Cuboid,
  [ENTRY_ICON_KIND.THREE_MF_MESH]: Layers3,
  [ENTRY_ICON_KIND.GLB_MESH]: FileBox
};

function iconForEntry(entry, sourceFormat, status) {
  return ENTRY_ICON_COMPONENTS[entryIconKind(entry, { sourceFormat, status })] || Package;
}

function FileEntryButton({
  entry,
  depth,
  selectedKey,
  onSelectEntry,
  entrySourceFormat,
  entryHasMesh,
  entryHasDxf,
  entryHasGcode,
  entryHasUrdf,
  activeGenerationFiles = [],
  activeStepArtifactGenerationFile = "",
  stepArtifactGenerationAvailable = true,
  canRevealFileAssets = false,
  canCopyFileAssetLinks = false,
  canCopyFileAssetPaths = false,
  fileAccessBusyKey = "",
  onDownloadFileAsset,
  onRevealFileAsset,
  onRevealInExplorerView,
  onCopyFileAssetReference,
  nested = false
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const key = fileKey(entry);
  const active = key === selectedKey;
  const label = sidebarLabelForEntry(entry);
  const sourceFormat = entrySourceFormat(entry);
  const status = entryIconStatus(entry, {
    sourceFormat,
    entryKey: key,
    hasMesh: entryHasMesh(entry),
    hasDxf: entryHasDxf(entry),
    hasGcode: entryHasGcode(entry),
    hasUrdf: entryHasUrdf(entry),
    activeGenerationFiles,
    activeStepArtifactGenerationFile,
    stepArtifactGenerationAvailable
  });
  const EntryIcon = iconForEntry(entry, sourceFormat, status);
  const stepSourceKind = entryStepSourceKind(entry);
  const SourceBadgeIcon = stepSourceKind === "python"
    ? Code
    : stepSourceKind === "step"
      ? ArrowUpFromLine
      : null;
  const showSourceBadge = Boolean(SourceBadgeIcon);
  const title = [
    label,
    stepSourceKind === "python" ? "Python-backed" : "",
    stepSourceKind === "step" ? "STEP-backed" : "",
    status.statusLabel,
    entry?.kind,
    String(entry?.file || "")
  ].filter(Boolean).join(" | ");

  const button = (
    <SidebarMenuButton
      type="button"
      isActive={active}
      size="sm"
      title={title}
      className={cn(
        "min-w-0 w-full justify-start"
      )}
      onClick={() => {
        onSelectEntry(key);
        if (isMobile) {
          setOpenMobile(false);
        }
      }}
      tooltip={label}
    >
      <span className="relative flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
        <EntryIcon
          className={cn(
            "size-4",
            status.loading && "animate-spin"
          )}
        />
        {showSourceBadge ? (
          <span className="absolute -bottom-1 -right-1 flex size-2.5 items-center justify-center rounded-[3px] border border-sidebar bg-sidebar text-sidebar-foreground shadow-sm">
            <SourceBadgeIcon className="size-2" strokeWidth={2.5} />
          </span>
        ) : null}
      </span>
      <span className="block min-w-0 flex-1 max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
    </SidebarMenuButton>
  );

  const buttonWithMenu = (
    <FileAccessContextMenu
      entry={entry}
      canRevealFileAssets={canRevealFileAssets}
      canCopyFileAssetLinks={canCopyFileAssetLinks}
      canCopyFileAssetPaths={canCopyFileAssetPaths}
      busyKey={fileAccessBusyKey}
      onDownloadFileAsset={onDownloadFileAsset}
      onRevealFileAsset={onRevealFileAsset}
      onRevealInExplorerView={onRevealInExplorerView}
      onCopyFileAssetReference={onCopyFileAssetReference}
    >
      {button}
    </FileAccessContextMenu>
  );

  // Assemblies carry per-part STLs (`entry.parts`); render them grouped under
  // the integrated model so a user can review/slice each part individually.
  const parts = Array.isArray(entry?.parts) ? entry.parts : [];
  if (parts.length === 0) {
    return buttonWithMenu;
  }

  return (
    <>
      {buttonWithMenu}
      <PartsGroup
        parts={parts}
        depth={depth}
        selectedKey={selectedKey}
        onSelectEntry={onSelectEntry}
        entrySourceFormat={entrySourceFormat}
        entryHasMesh={entryHasMesh}
        entryHasDxf={entryHasDxf}
        entryHasGcode={entryHasGcode}
        entryHasUrdf={entryHasUrdf}
        activeGenerationFiles={activeGenerationFiles}
        activeStepArtifactGenerationFile={activeStepArtifactGenerationFile}
        stepArtifactGenerationAvailable={stepArtifactGenerationAvailable}
        canRevealFileAssets={canRevealFileAssets}
        canCopyFileAssetLinks={canCopyFileAssetLinks}
        canCopyFileAssetPaths={canCopyFileAssetPaths}
        fileAccessBusyKey={fileAccessBusyKey}
        onDownloadFileAsset={onDownloadFileAsset}
        onRevealFileAsset={onRevealFileAsset}
        onRevealInExplorerView={onRevealInExplorerView}
        onCopyFileAssetReference={onCopyFileAssetReference}
      />
    </>
  );
}

// Collapsible "Parts" subsection nested under an integrated model row. Each part
// is a normal `FileEntryButton`, so selecting one renders/slices it through the
// existing single-model path.
function PartsGroup({ parts, depth, ...childProps }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <Collapsible asChild open={expanded} onOpenChange={setExpanded}>
      <SidebarMenuSubItem className="min-w-0 w-full max-w-full">
        <CollapsibleTrigger asChild>
          <SidebarMenuButton
            type="button"
            size="sm"
            title="Parts"
            className="min-w-0 w-full justify-start text-muted-foreground"
          >
            <ChevronRight
              className={cn("transition-transform", expanded && "rotate-90")}
              aria-hidden="true"
            />
            <Boxes className="size-4 shrink-0" aria-hidden="true" />
            <span className="block min-w-0 flex-1 max-w-full overflow-hidden text-ellipsis whitespace-nowrap">
              Parts
            </span>
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent className="min-w-0 w-full max-w-full">
          <SidebarMenuSub className="min-w-0 w-full max-w-full">
            {parts.map((partEntry) => (
              <SidebarMenuSubItem key={fileKey(partEntry)} className="min-w-0 w-full max-w-full">
                <FileEntryButton entry={partEntry} depth={depth + 1} nested {...childProps} />
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuSubItem>
    </Collapsible>
  );
}

function DirectoryNode({
  directory,
  depth,
  queryActive,
  expandedDirectoryIds,
  onToggleDirectory,
  selectedKey,
  onSelectEntry,
  entrySourceFormat,
  entryHasMesh,
  entryHasDxf,
  entryHasGcode,
  entryHasUrdf,
  activeGenerationFiles = [],
  activeStepArtifactGenerationFile = "",
  stepArtifactGenerationAvailable = true,
  canRevealFileAssets = false,
  canCopyFileAssetLinks = false,
  canCopyFileAssetPaths = false,
  fileAccessBusyKey = "",
  onDownloadFileAsset,
  onRevealFileAsset,
  onRevealInExplorerView,
  onCopyFileAssetReference,
  nested = false
}) {
  const expanded = queryActive || expandedDirectoryIds.has(directory.id);
  const DirectoryItem = nested ? SidebarMenuSubItem : SidebarMenuItem;

  return (
    <Collapsible asChild open={expanded}>
      <DirectoryItem className="min-w-0 w-full max-w-full">
        <CollapsibleTrigger asChild>
          <SidebarMenuButton
            type="button"
            size="sm"
            title={directory.name}
            aria-disabled={queryActive}
            className={cn(
              "group/directory min-w-0 w-full justify-start",
              queryActive && "cursor-default"
            )}
            onClick={(event) => {
              if (queryActive) {
                event.preventDefault();
                return;
              }
              onToggleDirectory(directory.id);
            }}
          >
            <ChevronRight
              className={cn(
                "transition-transform",
                expanded && "rotate-90"
              )}
              aria-hidden="true"
            />
            <span className="block min-w-0 flex-1 max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{directory.name}</span>
          </SidebarMenuButton>
        </CollapsibleTrigger>

        <CollapsibleContent className="min-w-0 w-full max-w-full">
          <SidebarMenuSub className="min-w-0 w-full max-w-full">
            {listSidebarItems(directory).map((item) => {
              if (item.type === "directory") {
                return (
                  <DirectoryNode
                    key={item.key}
                    directory={item.value}
                    depth={depth + 1}
                    queryActive={queryActive}
                    expandedDirectoryIds={expandedDirectoryIds}
                    onToggleDirectory={onToggleDirectory}
                    selectedKey={selectedKey}
                    onSelectEntry={onSelectEntry}
                    entrySourceFormat={entrySourceFormat}
                    entryHasMesh={entryHasMesh}
                    entryHasDxf={entryHasDxf}
                    entryHasGcode={entryHasGcode}
                    entryHasUrdf={entryHasUrdf}
                    activeGenerationFiles={activeGenerationFiles}
                    activeStepArtifactGenerationFile={activeStepArtifactGenerationFile}
                    stepArtifactGenerationAvailable={stepArtifactGenerationAvailable}
                    canRevealFileAssets={canRevealFileAssets}
                    canCopyFileAssetLinks={canCopyFileAssetLinks}
                    canCopyFileAssetPaths={canCopyFileAssetPaths}
                    fileAccessBusyKey={fileAccessBusyKey}
                    onDownloadFileAsset={onDownloadFileAsset}
                    onRevealFileAsset={onRevealFileAsset}
                    onRevealInExplorerView={onRevealInExplorerView}
                    onCopyFileAssetReference={onCopyFileAssetReference}
                    nested={true}
                  />
                );
              }
              return (
                <SidebarMenuSubItem key={item.key} className="min-w-0 w-full max-w-full">
                  <FileEntryButton
                    entry={item.value}
                    depth={depth + 1}
                    selectedKey={selectedKey}
                    onSelectEntry={onSelectEntry}
                    entrySourceFormat={entrySourceFormat}
                    entryHasMesh={entryHasMesh}
                    entryHasDxf={entryHasDxf}
                    entryHasGcode={entryHasGcode}
                    entryHasUrdf={entryHasUrdf}
                    activeGenerationFiles={activeGenerationFiles}
                    activeStepArtifactGenerationFile={activeStepArtifactGenerationFile}
                    stepArtifactGenerationAvailable={stepArtifactGenerationAvailable}
                    canRevealFileAssets={canRevealFileAssets}
                    canCopyFileAssetLinks={canCopyFileAssetLinks}
                    canCopyFileAssetPaths={canCopyFileAssetPaths}
                    fileAccessBusyKey={fileAccessBusyKey}
                    onDownloadFileAsset={onDownloadFileAsset}
                    onRevealFileAsset={onRevealFileAsset}
                    onRevealInExplorerView={onRevealInExplorerView}
                    onCopyFileAssetReference={onCopyFileAssetReference}
                    nested={true}
                  />
                </SidebarMenuSubItem>
              );
            })}
          </SidebarMenuSub>
        </CollapsibleContent>
      </DirectoryItem>
    </Collapsible>
  );
}

// Render one project's directory tree (the top level of items inside a project
// node). Mirrors the per-item branch that DirectoryNode uses for its children,
// so directories and files render identically at every depth.
function ProjectFileItems({
  tree,
  queryActive,
  expandedDirectoryIds,
  onToggleDirectory,
  selectedKey,
  onSelectEntry,
  treeProps
}) {
  return listSidebarItems(tree).map((item) => {
    if (item.type === "directory") {
      return (
        <DirectoryNode
          key={item.key}
          directory={item.value}
          depth={1}
          queryActive={queryActive}
          expandedDirectoryIds={expandedDirectoryIds}
          onToggleDirectory={onToggleDirectory}
          selectedKey={selectedKey}
          onSelectEntry={onSelectEntry}
          nested
          {...treeProps}
        />
      );
    }
    return (
      <SidebarMenuSubItem key={item.key} className="min-w-0 w-full max-w-full">
        <FileEntryButton
          entry={item.value}
          depth={1}
          selectedKey={selectedKey}
          onSelectEntry={onSelectEntry}
          nested
          {...treeProps}
        />
      </SidebarMenuSubItem>
    );
  });
}

// A top-level project row: collapsible header + its file tree. Files load
// lazily for non-active projects (the `status`/`error` come from the hook).
function ProjectNode({
  node,
  queryActive,
  onToggleProject,
  onToggleDirectory,
  onSelectEntry,
  onSelectProject,
  onRequestDeleteProject,
  onRenameProject,
  selectedKey,
  treeProps,
  isGenerating = false,
  isAwaitingAnswer = false,
  activeCatalogHydrated,
  activeCatalogRefreshing,
  activeCatalogError
}) {
  const expanded = node.expanded;
  const boundToggleDirectory = (dirId) => onToggleDirectory(node.id, dirId);
  const boundSelectEntry = (key) => onSelectEntry(key, node.id);

  // Inline rename: clicking the already-active project's name swaps the label
  // for a text input. The chevron stays a separate toggle so the active row can
  // still expand/collapse. Non-active rows toggle on click as before.
  const canRename = Boolean(onRenameProject);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(node.name || "");
  useEffect(() => {
    if (!editing) {
      setDraftName(node.name || "");
    }
  }, [node.name, editing]);

  const commitRename = () => {
    setEditing(false);
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== node.name) {
      onRenameProject?.(node.id, trimmed);
    }
  };
  const cancelRename = () => {
    setEditing(false);
    setDraftName(node.name || "");
  };
  const handleHeaderClick = () => {
    if (node.isActive) {
      // Active row: the name doubles as the rename affordance (chevron toggles).
      if (canRename) {
        setDraftName(node.name || "");
        setEditing(true);
      } else {
        onToggleProject(node.id);
      }
      return;
    }
    // Non-active row: activate the project so its chat + workspace come forward.
    // Selecting a file used to be the only way to activate a project, which left
    // a project with no files (e.g. a new one mid-conversation) unreachable.
    // Expand it too so its subtree is visible; the chevron still owns collapse.
    onSelectProject?.(node.id);
    if (!expanded) onToggleProject(node.id);
  };
  const handleChevronClick = (event) => {
    // The chevron always owns expand/collapse so it never activates the project
    // (header-click does that) — letting you peek at a project without leaving
    // the one you're in.
    event.stopPropagation();
    onToggleProject(node.id);
  };
  // Highlight the selected file only inside the active project — file keys are
  // project-relative, so the same key can exist in multiple projects.
  const effectiveSelectedKey = node.isActive ? selectedKey : "";

  // Git-tag-style version button rides on the active project's header row,
  // inline with its name. Only the active project has a model on screen to
  // save, so other rows stay clean. While renaming, the row becomes an input,
  // so the button (and the delete-action shift below) stand down.
  const showVersionButton = node.isActive && node.hasFiles && !editing;

  let body = null;
  if (node.isActive) {
    const hasMatches = node.hasFiles;
    const catalogLoading = !activeCatalogHydrated || (activeCatalogRefreshing && !hasMatches);
    const catalogErrorMessage = String(activeCatalogError || "").trim();
    if (hasMatches) {
      body = (
        <ProjectFileItems
          tree={node.tree}
          queryActive={queryActive}
          expandedDirectoryIds={node.expandedDirectoryIds}
          onToggleDirectory={boundToggleDirectory}
          selectedKey={effectiveSelectedKey}
          onSelectEntry={boundSelectEntry}
          treeProps={treeProps}
        />
      );
    } else if (catalogErrorMessage) {
      body = <ProjectMessage>CAD catalog unavailable: {catalogErrorMessage}</ProjectMessage>;
    } else if (catalogLoading) {
      body = <ProjectMessage>Loading models…</ProjectMessage>;
    } else if (queryActive) {
      body = <ProjectMessage>No models match this filter.</ProjectMessage>;
    } else {
      body = <ProjectMessage>No models yet.</ProjectMessage>;
    }
  } else if (node.status === "loading") {
    body = <ProjectMessage>Loading models…</ProjectMessage>;
  } else if (node.status === "error") {
    body = <ProjectMessage>Could not load files: {node.error}</ProjectMessage>;
  } else if (node.hasFiles) {
    body = (
      <ProjectFileItems
        tree={node.tree}
        queryActive={queryActive}
        expandedDirectoryIds={node.expandedDirectoryIds}
        onToggleDirectory={boundToggleDirectory}
        selectedKey={effectiveSelectedKey}
        onSelectEntry={boundSelectEntry}
        treeProps={treeProps}
      />
    );
  } else {
    body = <ProjectMessage>No models yet.</ProjectMessage>;
  }

  return (
    <Collapsible asChild open={expanded}>
      <SidebarMenuItem className="min-w-0 w-full max-w-full">
        {editing ? (
          <div className="flex h-7 items-center gap-2 rounded-md px-2 pr-7">
            <ChevronRight
              className={cn("size-4 shrink-0 transition-transform", expanded && "rotate-90")}
              aria-hidden="true"
            />
            <Folder className="size-4 shrink-0" aria-hidden="true" />
            <input
              autoFocus
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onFocus={(event) => event.target.select()}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitRename();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  cancelRename();
                }
              }}
              aria-label="Project name"
              className="h-6 min-w-0 flex-1 rounded border border-sidebar-border bg-sidebar px-1 text-sm font-medium text-sidebar-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
        ) : (
          <SidebarMenuButton
            type="button"
            size="sm"
            isActive={node.isActive}
            title={node.isActive && canRename ? "Click again to rename" : node.name}
            className={cn(
              "group/project min-w-0 w-full justify-start font-medium",
              // Keep the name clear of the inline version button on this row.
              showVersionButton && "pr-8",
            )}
            onClick={handleHeaderClick}
          >
            <span
              role="button"
              aria-label={expanded ? "Collapse project" : "Expand project"}
              onClick={handleChevronClick}
              className="flex size-4 shrink-0 items-center justify-center"
            >
              <ChevronRight
                className={cn("size-4 transition-transform", expanded && "rotate-90")}
                aria-hidden="true"
              />
            </span>
            <Folder className="size-4 shrink-0" aria-hidden="true" />
            <span className="block min-w-0 flex-1 max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{node.name || "Untitled project"}</span>
            {isGenerating ? (
              <LoaderCircle
                className="size-3.5 shrink-0 animate-spin text-muted-foreground"
                aria-label="Generating"
                title="Working…"
              />
            ) : isAwaitingAnswer ? (
              // A paused turn (proposed plan or unanswered questions) has already
              // ended, so it never coincides with the spinner — they share the
              // slot. Amber + pulse reads as "needs your input".
              <span
                className="size-2 shrink-0 rounded-full bg-amber-500 animate-pulse"
                role="status"
                aria-label="Waiting for your answer"
                title="Waiting for your answer"
              />
            ) : null}
          </SidebarMenuButton>
        )}
        {showVersionButton ? (
          <div className="absolute right-1 top-1 z-10">
            <SavedStates projectId={node.id} />
          </div>
        ) : null}
        {onRequestDeleteProject ? (
          <SidebarMenuAction
            showOnHover
            aria-label={`Delete ${node.name || "project"}`}
            title="Delete project"
            className={cn(
              "text-muted-foreground hover:text-destructive focus-visible:text-destructive",
              // Slide left of the version button when it's on this row.
              showVersionButton && "right-8",
            )}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onRequestDeleteProject({ id: node.id, name: node.name });
            }}
          >
            <Trash2 />
          </SidebarMenuAction>
        ) : null}
        <CollapsibleContent className="min-w-0 w-full max-w-full">
          <SidebarMenuSub className="min-w-0 w-full max-w-full">
            {body}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

function ProjectMessage({ children }) {
  return <p className="px-2 py-1.5 text-xs text-muted-foreground">{children}</p>;
}

function SidebarResizeHandle({ onStartResize }) {
  const { isMobile, state } = useSidebar();

  if (isMobile || state !== "expanded" || typeof onStartResize !== "function") {
    return null;
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label="Resize file viewer sidebar"
      title="Resize sidebar"
      onPointerDown={onStartResize}
      className="group/sidebar-resize absolute inset-y-0 -right-1.5 z-30 flex h-auto w-3 cursor-col-resize touch-none items-stretch justify-center rounded-none px-0 py-0 hover:bg-transparent"
    >
      <span className="my-2 w-px rounded-full bg-transparent transition-colors group-hover/sidebar-resize:bg-sidebar-border group-focus-visible/sidebar-resize:bg-ring" />
    </Button>
  );
}

function FileViewerContents({
  query,
  onQueryChange,
  projectNodes = [],
  selectedKey,
  onToggleProject,
  onToggleDirectory,
  onSelectEntry,
  onSelectProject,
  onCreateProject,
  onImportFiles,
  onRequestDeleteProject,
  onRenameProject,
  generatingProjectIds,
  awaitingAnswerProjectIds,
  entrySourceFormat,
  entryHasMesh,
  entryHasDxf,
  entryHasGcode,
  entryHasUrdf,
  activeGenerationFiles = [],
  activeStepArtifactGenerationFile = "",
  stepArtifactGenerationAvailable = true,
  canRevealFileAssets = false,
  canCopyFileAssetLinks = false,
  canCopyFileAssetPaths = false,
  fileAccessBusyKey = "",
  onDownloadFileAsset,
  onRevealFileAsset,
  onRevealInExplorerView,
  onCopyFileAssetReference,
  catalogHydrated = false,
  catalogRefreshing = false,
  catalogError = "",
  resizable = true,
  onStartResize
}) {
  const queryActive = query.trim().length > 0;
  // Per-file render props shared by every project's tree. Generation/status
  // props apply only to the active project; non-active entries render static
  // (the hook tags them isActive=false, but these arrays are already scoped to
  // the active project upstream).
  const treeProps = {
    entrySourceFormat,
    entryHasMesh,
    entryHasDxf,
    entryHasGcode,
    entryHasUrdf,
    activeGenerationFiles,
    activeStepArtifactGenerationFile,
    stepArtifactGenerationAvailable,
    canRevealFileAssets,
    canCopyFileAssetLinks,
    canCopyFileAssetPaths,
    fileAccessBusyKey,
    onDownloadFileAsset,
    onRevealFileAsset,
    onRevealInExplorerView,
    onCopyFileAssetReference
  };
  const hasProjects = projectNodes.length > 0;

  return (
    <>
      <SidebarHeader>
        <div className="flex items-center justify-between px-1 pb-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Projects
          </span>
          <div className="flex items-center gap-0.5">
            {/* Import STL/GLB is hidden for now — wiring is kept (onImportFiles
                prop + handler) so it's a one-line change to re-enable. */}
            {false && onImportFiles ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground"
                aria-label="Import STL or GLB"
                title="Import STL or GLB"
                onClick={() => onImportFiles()}
              >
                <Upload className="size-4" aria-hidden="true" />
              </Button>
            ) : null}
            {onCreateProject ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground"
                aria-label="New project"
                title="New project"
                onClick={() => onCreateProject()}
              >
                <FolderPlus className="size-4" aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        </div>
        <SidebarInput
          type="search"
          placeholder="Search projects..."
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          aria-label="Search projects"
          className="h-7 text-xs md:text-xs"
        />
      </SidebarHeader>

      <SidebarContent>
        <ScrollArea className="cad-file-viewer-scroll min-h-0 min-w-0 flex-1 overflow-x-hidden" type="auto">
          <SidebarGroup>
            <SidebarGroupContent>
              {hasProjects ? (
                <SidebarMenu>
                  {projectNodes.map((node) => (
                    <ProjectNode
                      key={node.id}
                      node={node}
                      queryActive={queryActive}
                      onToggleProject={onToggleProject}
                      onToggleDirectory={onToggleDirectory}
                      onSelectEntry={onSelectEntry}
                      onSelectProject={onSelectProject}
                      onRequestDeleteProject={onRequestDeleteProject}
                      onRenameProject={onRenameProject}
                      selectedKey={selectedKey}
                      treeProps={treeProps}
                      isGenerating={Boolean(generatingProjectIds?.has(node.id))}
                      isAwaitingAnswer={Boolean(awaitingAnswerProjectIds?.has(node.id))}
                      activeCatalogHydrated={catalogHydrated}
                      activeCatalogRefreshing={catalogRefreshing}
                      activeCatalogError={catalogError}
                    />
                  ))}
                </SidebarMenu>
              ) : queryActive ? (
                <p className="px-2 py-3 text-xs text-muted-foreground">No projects match this filter.</p>
              ) : (
                <p className="px-2 py-3 text-xs text-muted-foreground">No projects yet.</p>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        </ScrollArea>
      </SidebarContent>
      <SidebarResizeHandle onStartResize={resizable ? onStartResize : null} />
    </>
  );
}

export default function FileViewerSidebar({
  previewMode,
  query,
  onQueryChange,
  projectNodes = [],
  selectedKey,
  onToggleProject,
  onToggleDirectory,
  onSelectEntry,
  onSelectProject,
  onCreateProject,
  onImportFiles,
  onRequestDeleteProject,
  onRenameProject,
  generatingProjectIds,
  awaitingAnswerProjectIds,
  entrySourceFormat,
  entryHasMesh,
  entryHasDxf,
  entryHasGcode,
  entryHasUrdf,
  activeGenerationFiles = [],
  activeStepArtifactGenerationFile = "",
  stepArtifactGenerationAvailable = true,
  canRevealFileAssets = false,
  canCopyFileAssetLinks = false,
  canCopyFileAssetPaths = false,
  fileAccessBusyKey = "",
  onDownloadFileAsset,
  onRevealFileAsset,
  onRevealInExplorerView,
  onCopyFileAssetReference,
  catalogHydrated = false,
  catalogRefreshing = false,
  catalogError = "",
  resizable = true,
  onStartResize
}) {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar();

  if (previewMode) {
    return null;
  }

  const content = (
    <FileViewerContents
      query={query}
      onQueryChange={onQueryChange}
      projectNodes={projectNodes}
      selectedKey={selectedKey}
      onToggleProject={onToggleProject}
      onToggleDirectory={onToggleDirectory}
      onSelectEntry={onSelectEntry}
      onSelectProject={onSelectProject}
      onCreateProject={onCreateProject}
      onImportFiles={onImportFiles}
      onRequestDeleteProject={onRequestDeleteProject}
      onRenameProject={onRenameProject}
      generatingProjectIds={generatingProjectIds}
      awaitingAnswerProjectIds={awaitingAnswerProjectIds}
      entrySourceFormat={entrySourceFormat}
      entryHasMesh={entryHasMesh}
      entryHasDxf={entryHasDxf}
      entryHasGcode={entryHasGcode}
      entryHasUrdf={entryHasUrdf}
      activeGenerationFiles={activeGenerationFiles}
      activeStepArtifactGenerationFile={activeStepArtifactGenerationFile}
      stepArtifactGenerationAvailable={stepArtifactGenerationAvailable}
      canRevealFileAssets={canRevealFileAssets}
      canCopyFileAssetLinks={canCopyFileAssetLinks}
      canCopyFileAssetPaths={canCopyFileAssetPaths}
      fileAccessBusyKey={fileAccessBusyKey}
      onDownloadFileAsset={onDownloadFileAsset}
      onRevealFileAsset={onRevealFileAsset}
      onRevealInExplorerView={onRevealInExplorerView}
      onCopyFileAssetReference={onCopyFileAssetReference}
      catalogHydrated={catalogHydrated}
      catalogRefreshing={catalogRefreshing}
      catalogError={catalogError}
      resizable={resizable}
      onStartResize={onStartResize}
    />
  );

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="cad-glass-surface gap-0 p-0 text-sidebar-foreground"
          style={{
            width: MOBILE_FILE_VIEWER_WIDTH,
            maxWidth: DESKTOP_FILE_VIEWER_MAX_WIDTH
          }}
        >
          <SheetHeaderPrimitive className="sr-only">
            <SheetTitle>CAD Viewer</SheetTitle>
            <SheetDescription>Browse files in the CAD catalog.</SheetDescription>
          </SheetHeaderPrimitive>
          <div className="flex h-full min-h-0 w-full flex-col" aria-label="CAD Viewer">
            {content}
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  if (state !== "expanded") {
    return null;
  }

  const desktopWidth = `min(var(--sidebar-width), ${DESKTOP_FILE_VIEWER_MAX_WIDTH})`;
  const sidebarStyle = isMobile
    ? {
      width: MOBILE_FILE_VIEWER_WIDTH,
      maxWidth: DESKTOP_FILE_VIEWER_MAX_WIDTH
    }
    : {
      width: desktopWidth,
      flexBasis: desktopWidth,
      minWidth: `min(${DESKTOP_FILE_VIEWER_MIN_WIDTH}px, ${DESKTOP_FILE_VIEWER_MAX_WIDTH})`,
      maxWidth: DESKTOP_FILE_VIEWER_MAX_WIDTH
    };

  return (
    <aside
      className={cn(
        "cad-glass-surface pointer-events-auto z-30 flex h-full max-w-[calc(100vw_-_0.75rem)] flex-col border-r border-sidebar-border text-sidebar-foreground",
        isMobile
          ? "absolute inset-y-0 left-0 shadow-xl"
          : "relative shrink-0"
      )}
      style={sidebarStyle}
      aria-label="CAD Viewer"
    >
      {content}
    </aside>
  );
}
