import { Fragment } from "react";
import {
  Bot,
  Boxes,
  ChevronDown,
  Cuboid,
  DraftingCompass,
  FileBox,
  Folder,
  Layers3,
  LoaderCircle,
  Moon,
  Package,
  Route,
  SlidersHorizontal,
  Sun
} from "lucide-react";
import { normalizeViewerGithubUrl } from "cadjs/lib/viewerConfig.mjs";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/ui/utils";
import {
  themeSettingsSupportsSystemColorMode
} from "cadjs/lib/themeSettings";
import {
  DARK_COLOR_SCHEME_ID,
  LIGHT_COLOR_SCHEME_ID
} from "@/ui/colorScheme";
import {
  ENTRY_ICON_KIND,
  entryIconKind
} from "@/workbench/entryIconKind";
import { entryIconStatus } from "@/workbench/entryIconStatus";
import FileAccessContextMenu from "./FileAccessContextMenu";
import {
  fileKey,
  listSidebarItems
} from "@/workbench/sidebar";
import {
  buildBreadcrumbNodes,
  directoryTitle
} from "@/workbench/breadcrumb";

function collapsedBreadcrumbNodes(nodes) {
  if (nodes.length <= 4) {
    return nodes.map((node) => ({ type: "node", node }));
  }

  return [
    { type: "node", node: nodes[0] },
    { type: "ellipsis", label: "...", nodes: nodes.slice(1, -2) },
    ...nodes.slice(-2).map((node) => ({ type: "node", node }))
  ];
}

function fileSheetLabel(fileSheetKind) {
  if (fileSheetKind === "dxf") {
    return "DXF sheet";
  }
  if (fileSheetKind === "urdf") {
    return "URDF sheet";
  }
  if (fileSheetKind === "srdf") {
    return "SRDF sheet";
  }
  if (fileSheetKind === "sdf") {
    return "SDF sheet";
  }
  if (fileSheetKind === "step") {
    return "STEP sheet";
  }
  return "file sheet";
}

function sourceFormatForEntry(entry, entrySourceFormat) {
  const sourceFormat = typeof entrySourceFormat === "function"
    ? entrySourceFormat(entry)
    : (entry?.kind || "");
  return String(sourceFormat || "").trim().toLowerCase();
}

function entryStatusForMenu(entry, {
  entrySourceFormat,
  entryHasMesh,
  entryHasDxf,
  entryHasGcode,
  entryHasUrdf,
  activeGenerationFiles = [],
  activeStepArtifactGenerationFile = "",
  stepArtifactGenerationAvailable = true
}) {
  const sourceFormat = sourceFormatForEntry(entry, entrySourceFormat);
  const hasDxf = typeof entryHasDxf === "function" ? entryHasDxf(entry) : true;
  const hasGcode = typeof entryHasGcode === "function" ? entryHasGcode(entry) : true;
  const hasUrdf = typeof entryHasUrdf === "function" ? entryHasUrdf(entry) : true;
  const hasMesh = typeof entryHasMesh === "function" ? entryHasMesh(entry) : true;

  return entryIconStatus(entry, {
    sourceFormat,
    entryKey: fileKey(entry),
    hasMesh,
    hasDxf,
    hasGcode,
    hasUrdf,
    activeGenerationFiles,
    activeStepArtifactGenerationFile,
    stepArtifactGenerationAvailable
  });
}

const ENTRY_ICON_COMPONENTS = {
  [ENTRY_ICON_KIND.LOADING]: LoaderCircle,
  [ENTRY_ICON_KIND.ASSEMBLY]: Boxes,
  [ENTRY_ICON_KIND.DXF]: DraftingCompass,
  [ENTRY_ICON_KIND.GCODE]: Route,
  [ENTRY_ICON_KIND.ROBOT]: Bot,
  [ENTRY_ICON_KIND.STEP_PART]: Package,
  [ENTRY_ICON_KIND.STL_MESH]: Cuboid,
  [ENTRY_ICON_KIND.THREE_MF_MESH]: Layers3,
  [ENTRY_ICON_KIND.GLB_MESH]: FileBox
};

function iconForEntry(entry, sourceFormat, status) {
  return ENTRY_ICON_COMPONENTS[entryIconKind(entry, { sourceFormat, status })] || Package;
}

function BreadcrumbEntryMenuItem({
  entry,
  selectedKey,
  onSelectEntry,
  sidebarLabelForEntry,
  entrySourceFormat,
  entryHasMesh,
  entryHasDxf,
  entryHasGcode,
  entryHasUrdf,
  activeGenerationFiles = [],
  activeStepArtifactGenerationFile = "",
  stepArtifactGenerationAvailable = true
}) {
  const key = fileKey(entry);
  const active = key === selectedKey;
  const label = typeof sidebarLabelForEntry === "function"
    ? sidebarLabelForEntry(entry)
    : key;
  const status = entryStatusForMenu(entry, {
    entrySourceFormat,
    entryHasMesh,
    entryHasDxf,
    entryHasGcode,
    entryHasUrdf,
    activeGenerationFiles,
    activeStepArtifactGenerationFile,
    stepArtifactGenerationAvailable
  });
  const { sourceFormat } = status;
  const EntryIcon = iconForEntry(entry, sourceFormat, status);
  const title = [
    label,
    status.statusLabel,
    entry?.kind,
    String(entry?.file || key)
  ].filter(Boolean).join(" | ");

  return (
    <DropdownMenuItem
      data-active={active}
      className={cn(
        "min-w-0 max-w-80 text-xs focus:bg-sidebar-accent focus:text-sidebar-accent-foreground",
        "data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground"
      )}
      title={title}
      disabled={!key || typeof onSelectEntry !== "function"}
      aria-current={active ? "page" : undefined}
      onSelect={() => {
        if (key && typeof onSelectEntry === "function") {
          onSelectEntry(key);
        }
      }}
    >
      <EntryIcon
        className={cn(
          "size-3.5 shrink-0",
          status.loading && "animate-spin"
        )}
        aria-hidden="true"
      />
      <span className="block min-w-0 flex-1 truncate">{label}</span>
    </DropdownMenuItem>
  );
}

function BreadcrumbDirectoryMenuItems({
  directory,
  selectedKey,
  onSelectEntry,
  sidebarLabelForEntry,
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
  onCopyFileAssetReference
}) {
  const items = listSidebarItems(directory);

  if (!items.length) {
    return (
      <DropdownMenuItem disabled className="max-w-80 text-xs">
        <Folder className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="block min-w-0 truncate">{String(directory?.name || "Empty")}</span>
      </DropdownMenuItem>
    );
  }

  return items.map((item) => {
    if (item.type === "directory") {
      return (
        <BreadcrumbDirectorySubMenu
          key={item.key}
          directory={item.value}
          selectedKey={selectedKey}
          onSelectEntry={onSelectEntry}
          sidebarLabelForEntry={sidebarLabelForEntry}
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
          onCopyFileAssetReference={onCopyFileAssetReference}
        />
      );
    }

    return (
      <BreadcrumbEntryMenuItem
        key={item.key}
        entry={item.value}
        selectedKey={selectedKey}
        onSelectEntry={onSelectEntry}
        sidebarLabelForEntry={sidebarLabelForEntry}
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
        onCopyFileAssetReference={onCopyFileAssetReference}
      />
    );
  });
}

function DropdownMenuScrollArea({ children }) {
  return (
    <ScrollArea
      className="max-h-96 w-full"
      type="auto"
      viewportClassName="max-h-96"
    >
      {children}
    </ScrollArea>
  );
}

function BreadcrumbDirectorySubMenu({
  directory,
  selectedKey,
  onSelectEntry,
  sidebarLabelForEntry,
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
  onCopyFileAssetReference
}) {
  const title = directoryTitle(directory);

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        className="min-w-0 max-w-80 text-xs"
        title={title}
      >
        <Folder className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="block min-w-0 flex-1 truncate">{String(directory?.name || "Folder")}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-max max-w-80">
        <DropdownMenuScrollArea>
          <BreadcrumbDirectoryMenuItems
            directory={directory}
            selectedKey={selectedKey}
            onSelectEntry={onSelectEntry}
            sidebarLabelForEntry={sidebarLabelForEntry}
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
            onCopyFileAssetReference={onCopyFileAssetReference}
          />
        </DropdownMenuScrollArea>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function BreadcrumbNodeDropdown({
  node,
  current,
  selectedKey,
  onSelectEntry,
  sidebarLabelForEntry,
  entrySourceFormat,
  entryHasMesh,
  entryHasDxf,
  entryHasGcode,
  entryHasUrdf,
  activeGenerationFiles = [],
  activeStepArtifactGenerationFile = "",
  stepArtifactGenerationAvailable = true,
  selectedStepSourceStatus = null,
  canRevealFileAssets = false,
  canCopyFileAssetLinks = false,
  canCopyFileAssetPaths = false,
  fileAccessBusyKey = "",
  onDownloadFileAsset,
  onRevealFileAsset,
  onRevealInExplorerView,
  onCopyFileAssetReference,
  filenameLoadActivity
}) {
  const label = String(node?.label || "");
  const title = String(node?.title || label);
  const menuDirectory = node?.type === "directory" || node?.type === "placeholder"
    ? node?.menuDirectory || null
    : null;
  const canBrowse = !!menuDirectory && listSidebarItems(menuDirectory).length > 0;

  if (!canBrowse) {
    const labelNode = (
      <span
        className={cn(
          "inline-flex min-w-0 items-center gap-2 text-xs font-medium",
          current ? "max-w-[min(36rem,55vw)] text-foreground" : "max-w-32"
        )}
        title={title}
      >
        <span className="block min-w-0 truncate">{label}</span>
        {current && node?.type === "entry" ? (
          <FilenameLoadStatus activity={filenameLoadActivity} />
        ) : null}
      </span>
    );

    if (node?.type !== "entry" || !node?.entry) {
      return labelNode;
    }

    return (
      <FileAccessContextMenu
        entry={node.entry}
        stepSourceStatus={selectedStepSourceStatus}
        canRevealFileAssets={canRevealFileAssets}
        canCopyFileAssetLinks={canCopyFileAssetLinks}
        canCopyFileAssetPaths={canCopyFileAssetPaths}
        busyKey={fileAccessBusyKey}
        onDownloadFileAsset={onDownloadFileAsset}
        onRevealFileAsset={onRevealFileAsset}
        onRevealInExplorerView={onRevealInExplorerView}
        onCopyFileAssetReference={onCopyFileAssetReference}
      >
        {labelNode}
      </FileAccessContextMenu>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex min-w-0 items-center gap-2 rounded-sm text-xs font-medium transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            current
              ? "max-w-[min(36rem,55vw)] text-foreground"
              : "max-w-32 text-muted-foreground"
          )}
          aria-label={`Browse ${label}`}
          aria-current={current ? "page" : undefined}
          title={title}
        >
          <span className="block min-w-0 truncate">{label}</span>
          {current && node?.type === "entry" ? (
            <FilenameLoadStatus activity={filenameLoadActivity} />
          ) : null}
          {node?.type === "placeholder" ? (
            <ChevronDown className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-max max-w-80">
        <DropdownMenuScrollArea>
          <BreadcrumbDirectoryMenuItems
            directory={menuDirectory}
            selectedKey={selectedKey}
            onSelectEntry={onSelectEntry}
            sidebarLabelForEntry={sidebarLabelForEntry}
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
            onCopyFileAssetReference={onCopyFileAssetReference}
          />
        </DropdownMenuScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BreadcrumbEllipsisDropdown({
  nodes,
  selectedKey,
  onSelectEntry,
  sidebarLabelForEntry,
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
  onCopyFileAssetReference,
  title
}) {
  const hiddenNodes = Array.isArray(nodes) ? nodes.filter(Boolean) : [];
  const menuTitle = hiddenNodes.map((node) => node.label).join(" / ") || title;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-6 min-w-7 items-center justify-center rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Show collapsed path folders"
          title={menuTitle}
        >
          <span aria-hidden="true">...</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-max max-w-80">
        <DropdownMenuScrollArea>
          {hiddenNodes.map((node, index) => {
            if (node.type === "directory" && node.directory) {
              return (
                <BreadcrumbDirectorySubMenu
                  key={`${node.type}:${node.id}:${index}`}
                  directory={node.directory}
                  selectedKey={selectedKey}
                  onSelectEntry={onSelectEntry}
                  sidebarLabelForEntry={sidebarLabelForEntry}
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
                  onCopyFileAssetReference={onCopyFileAssetReference}
                />
              );
            }

            if (node.type === "entry" && node.entry) {
              return (
                <BreadcrumbEntryMenuItem
                  key={`${node.type}:${fileKey(node.entry)}:${index}`}
                  entry={node.entry}
                  selectedKey={selectedKey}
                  onSelectEntry={onSelectEntry}
                  sidebarLabelForEntry={sidebarLabelForEntry}
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
                  onCopyFileAssetReference={onCopyFileAssetReference}
                />
              );
            }

            return (
              <DropdownMenuItem key={`${node.type}:${node.label}:${index}`} disabled className="max-w-80 text-xs">
                <span className="block min-w-0 truncate">{node.label}</span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FilenameLoadStatus({ activity }) {
  const label = String(activity?.label || "").trim();
  if (!activity?.loading || !label) {
    return null;
  }

  const title = String(activity?.title || label).trim();

  return (
    <span
      role="status"
      aria-live="polite"
      title={title}
      className="inline-flex min-w-0 max-w-36 shrink items-center gap-1 rounded-md border border-border/70 bg-sidebar-accent px-1.5 py-0.5 text-[10px] font-medium leading-none text-sidebar-accent-foreground"
    >
      <LoaderCircle className="size-3 shrink-0 animate-spin" aria-hidden="true" />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}

function GitHubMark(props) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.09 3.29 9.4 7.86 10.92.58.1.79-.25.79-.56v-2.02c-3.2.7-3.87-1.37-3.87-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.06-.73.08-.71.08-.71 1.17.08 1.79 1.2 1.79 1.2 1.04 1.78 2.73 1.27 3.4.97.1-.75.41-1.27.74-1.56-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.2-3.08-.12-.29-.52-1.46.11-3.04 0 0 .98-.31 3.2 1.18A11.13 11.13 0 0 1 12 6.16c.99 0 1.98.13 2.91.39 2.22-1.49 3.2-1.18 3.2-1.18.63 1.58.23 2.75.11 3.04.75.8 1.2 1.83 1.2 3.08 0 4.41-2.69 5.39-5.25 5.67.42.36.79 1.08.79 2.17v3.03c0 .31.21.67.8.56A11.52 11.52 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

const topBarIconButtonClasses = "size-7";
const topBarIconClasses = "size-4";

function nextColorMode(currentColorMode) {
  return currentColorMode === DARK_COLOR_SCHEME_ID
    ? LIGHT_COLOR_SCHEME_ID
    : DARK_COLOR_SCHEME_ID;
}

export default function CadWorkspaceTopBar({
  previewMode,
  projectMenu = null,
  sidebarLabelForEntry,
  directoryTree = null,
  selectedKey = "",
  selectedEntry,
  onSelectEntry,
  entrySourceFormat,
  entryHasMesh,
  entryHasDxf,
  entryHasGcode,
  entryHasUrdf,
  activeGenerationFiles = [],
  activeStepArtifactGenerationFile = "",
  stepArtifactGenerationAvailable = true,
  themePresets = [],
  themeSettings,
  themePresetId = "",
  resolvedColorSchemeMode = LIGHT_COLOR_SCHEME_ID,
  onColorSchemePreferenceChange,
  updateThemeSettings,
  handleResetThemeSettings,
  handleSaveCustomThemePreset,
  handleUpdateThemePresetSettings,
  handleDeleteCustomThemePreset,
  handleEditThemePreset,
  handleResetThemePresetToDefault,
  handleRestoreDefaultThemePresets,
  filenameLoadActivity = null,
  selectedStepSourceStatus = null,
  canRevealFileAssets = false,
  canCopyFileAssetLinks = false,
  canCopyFileAssetPaths = false,
  fileAccessBusyKey = "",
  onDownloadFileAsset,
  onRevealFileAsset,
  onRevealInExplorerView,
  onCopyFileAssetReference,
  fileSheetKind = "",
  fileSheetOpen = false,
  onToggleFileSheet
}) {
  if (previewMode) {
    return null;
  }

  const selectedFileLabel = selectedEntry && typeof sidebarLabelForEntry === "function"
    ? sidebarLabelForEntry(selectedEntry)
    : "Select a file";
  const selectedFileTitle = selectedEntry
    ? String(selectedEntry.file || selectedEntry.id || selectedFileLabel)
    : selectedFileLabel;
  const breadcrumbNodes = buildBreadcrumbNodes({
    directoryTree,
    selectedEntry,
    selectedFileLabel,
    selectedFileTitle
  });
  const breadcrumbItems = collapsedBreadcrumbNodes(breadcrumbNodes);
  const mobileBreadcrumbNode = breadcrumbNodes[breadcrumbNodes.length - 1] || null;
  const activeIconButtonClasses = "bg-accent text-accent-foreground";
  const showFileSheetToggle = !!fileSheetKind && typeof onToggleFileSheet === "function";
  const fileSheetToggleLabel = fileSheetOpen
    ? `Collapse ${fileSheetLabel(fileSheetKind)}`
    : `Expand ${fileSheetLabel(fileSheetKind)}`;
  const githubUrl = normalizeViewerGithubUrl(import.meta.env?.VIEWER_GITHUB_URL);
  const showThemeColorModeToggle = themeSettingsSupportsSystemColorMode(themeSettings);
  const activeColorSchemeMode = resolvedColorSchemeMode === DARK_COLOR_SCHEME_ID
    ? DARK_COLOR_SCHEME_ID
    : LIGHT_COLOR_SCHEME_ID;
  const nextColorSchemeMode = nextColorMode(activeColorSchemeMode);
  const activeColorSchemeModeLabel = activeColorSchemeMode === DARK_COLOR_SCHEME_ID ? "dark" : "light";
  const nextColorSchemeModeLabel = nextColorSchemeMode === DARK_COLOR_SCHEME_ID ? "dark" : "light";
  const colorModeToggleLabel = `Browser color mode: ${activeColorSchemeModeLabel}. Switch to ${nextColorSchemeModeLabel} mode.`;
  const ColorModeIcon = activeColorSchemeMode === DARK_COLOR_SCHEME_ID ? Moon : Sun;

  const handleThemeColorModeToggle = () => {
    if (typeof onColorSchemePreferenceChange !== "function") {
      return;
    }
    onColorSchemePreferenceChange(nextColorSchemeMode);
  };

  return (
    <header
      className="cad-glass-surface pointer-events-auto flex h-11 shrink-0 items-center gap-2 border-b border-sidebar-border px-2 text-sidebar-foreground"
    >
      <SidebarTrigger
        title="Toggle Models"
        aria-label="Toggle Models"
        className="shrink-0"
      />

      {projectMenu}

      <Breadcrumb className="min-w-0 flex-1 overflow-hidden">
        <ScrollArea
          className="h-8 min-w-0 whitespace-nowrap"
          type="auto"
          viewportClassName="overflow-y-hidden"
          scrollbars="horizontal"
        >
          {mobileBreadcrumbNode ? (
            <BreadcrumbList className="flex h-8 min-w-full flex-nowrap gap-1.5 pr-2 text-xs sm:hidden">
              <BreadcrumbItem className="min-w-0">
                <BreadcrumbNodeDropdown
                  node={mobileBreadcrumbNode}
                  current
                  selectedKey={selectedKey}
                  onSelectEntry={onSelectEntry}
                  sidebarLabelForEntry={sidebarLabelForEntry}
                  entrySourceFormat={entrySourceFormat}
                  entryHasMesh={entryHasMesh}
                  entryHasDxf={entryHasDxf}
                  entryHasGcode={entryHasGcode}
                  entryHasUrdf={entryHasUrdf}
                  activeGenerationFiles={activeGenerationFiles}
                  activeStepArtifactGenerationFile={activeStepArtifactGenerationFile}
                  stepArtifactGenerationAvailable={stepArtifactGenerationAvailable}
                  selectedStepSourceStatus={selectedStepSourceStatus}
                  canRevealFileAssets={canRevealFileAssets}
                  canCopyFileAssetLinks={canCopyFileAssetLinks}
                  canCopyFileAssetPaths={canCopyFileAssetPaths}
                  fileAccessBusyKey={fileAccessBusyKey}
                  onDownloadFileAsset={onDownloadFileAsset}
                  onRevealFileAsset={onRevealFileAsset}
                  onRevealInExplorerView={onRevealInExplorerView}
                  onCopyFileAssetReference={onCopyFileAssetReference}
                  filenameLoadActivity={filenameLoadActivity}
                />
              </BreadcrumbItem>
            </BreadcrumbList>
          ) : null}
          <BreadcrumbList className="hidden h-8 min-w-full w-max flex-nowrap gap-1.5 pr-2 text-xs sm:flex sm:gap-1.5">
            {breadcrumbItems.map((item, index) => (
              <Fragment key={`${item.type}:${item.node?.type || ""}:${item.node?.id || item.node?.label || index}:${index}`}>
                <BreadcrumbItem className="min-w-0">
                  {item.type === "ellipsis" ? (
                    <BreadcrumbEllipsisDropdown
                      nodes={item.nodes}
                      selectedKey={selectedKey}
                      onSelectEntry={onSelectEntry}
                      sidebarLabelForEntry={sidebarLabelForEntry}
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
                      onCopyFileAssetReference={onCopyFileAssetReference}
                      title={selectedFileTitle}
                    />
                  ) : (
                    <BreadcrumbNodeDropdown
                      node={item.node}
                      current={index === breadcrumbItems.length - 1}
                      selectedKey={selectedKey}
                      onSelectEntry={onSelectEntry}
                      sidebarLabelForEntry={sidebarLabelForEntry}
                      entrySourceFormat={entrySourceFormat}
                      entryHasMesh={entryHasMesh}
                      entryHasDxf={entryHasDxf}
                      entryHasGcode={entryHasGcode}
                      entryHasUrdf={entryHasUrdf}
                      activeGenerationFiles={activeGenerationFiles}
                      activeStepArtifactGenerationFile={activeStepArtifactGenerationFile}
                      stepArtifactGenerationAvailable={stepArtifactGenerationAvailable}
                      selectedStepSourceStatus={selectedStepSourceStatus}
                      canRevealFileAssets={canRevealFileAssets}
                      canCopyFileAssetLinks={canCopyFileAssetLinks}
                      canCopyFileAssetPaths={canCopyFileAssetPaths}
                      fileAccessBusyKey={fileAccessBusyKey}
                      onDownloadFileAsset={onDownloadFileAsset}
                      onRevealFileAsset={onRevealFileAsset}
                      onRevealInExplorerView={onRevealInExplorerView}
                      onCopyFileAssetReference={onCopyFileAssetReference}
                      filenameLoadActivity={filenameLoadActivity}
                    />
                  )}
                </BreadcrumbItem>
                {index < breadcrumbItems.length - 1 ? (
                  <BreadcrumbSeparator className="text-muted-foreground/60" />
                ) : null}
              </Fragment>
            ))}
          </BreadcrumbList>
        </ScrollArea>
      </Breadcrumb>

      <div className="flex shrink-0 items-center gap-0.5">
        {githubUrl ? (
          <Button
            asChild
            variant="ghost"
            size="icon-sm"
            aria-label="Open GitHub repository"
            title="Open GitHub repository"
            className={topBarIconButtonClasses}
          >
            <a href={githubUrl} target="_blank" rel="noreferrer">
              <GitHubMark className={topBarIconClasses} />
            </a>
          </Button>
        ) : null}

        {showFileSheetToggle ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={fileSheetToggleLabel}
            title={fileSheetToggleLabel}
            aria-pressed={fileSheetOpen}
            onClick={onToggleFileSheet}
            className={`${topBarIconButtonClasses} ${fileSheetOpen ? activeIconButtonClasses : ""}`}
          >
            <SlidersHorizontal className={topBarIconClasses} />
            <span className="sr-only">{fileSheetToggleLabel}</span>
          </Button>
        ) : null}
      </div>
    </header>
  );
}
