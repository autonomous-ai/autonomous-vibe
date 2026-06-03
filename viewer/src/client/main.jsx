import { StrictMode, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import CadWorkspace from "./components/CadWorkspace";
import ChatSidebar, { readStoredChatSidebarWidth } from "./components/chat/ChatSidebar";
import { bindCadRefSelectionToChatInput } from "./components/chat/cadRefEvents";
import ProjectMenu from "./components/project/ProjectMenu.jsx";
import OnboardingWizard from "./components/onboarding/OnboardingWizard.jsx";
import UpdateNotifier from "./components/update/UpdateNotifier.jsx";
import faviconUrl from "./assets/favicon.ico";
import "./styles/globals.css";
import { getCadManifestSnapshot, refreshCadCatalog, setCadCatalogBackend, subscribeCadManifest } from "cadjs/lib/cadManifestStore";
import { isTauriRuntime, transport } from "./lib/transport.ts";
import { tauriCadCatalogBackend } from "./lib/cadCatalogBackendTauri.js";
import { setProject as setChatProject } from "./store/chat.js";
import { useProjectsStore } from "./store/projects.ts";
import { isPrintableModelEntry } from "./workbench/isPrintableModelEntry.js";

// Route cadjs's catalog/generation-status/step-artifact operations through
// the Tauri IPC transport when we're inside the desktop shell. cadjs's
// default fetch('/__cad/...') backend works only against the standalone
// viewer's HTTP middleware, which Panda does not run.
if (isTauriRuntime()) {
  setCadCatalogBackend(tauriCadCatalogBackend);
}

const ROOT_ID = "root";
const ROOT_CACHE_KEY = "__cadViewerRoot";

function ensureFavicon() {
  if (typeof document === "undefined") {
    return;
  }

  let icon = document.querySelector('link[rel="icon"]');
  if (!icon) {
    icon = document.createElement("link");
    icon.rel = "icon";
    document.head.appendChild(icon);
  }
  icon.type = "image/x-icon";
  icon.href = `${faviconUrl}?v=planetary-gear-workbench`;
}

function bootstrap() {
  const rootElement = document.getElementById(ROOT_ID);
  if (!rootElement) {
    throw new Error(`Missing #${ROOT_ID} mount point.`);
  }
  ensureFavicon();
  document.title = "Panda";
  const cachedRoot = globalThis[ROOT_CACHE_KEY];
  const root = cachedRoot?.element === rootElement && cachedRoot?.root
    ? cachedRoot.root
    : createRoot(rootElement);
  globalThis[ROOT_CACHE_KEY] = {
    element: rootElement,
    root
  };
  root.render(
    <StrictMode>
      <AppRoot />
    </StrictMode>,
  );
}

function useOnboardingGate() {
  // Tri-state: null = still probing; true = wizard should show; false = run app.
  const [needsOnboarding, setNeedsOnboarding] = useState(null);

  useEffect(() => {
    let cancelled = false;
    transport
      .app_settings_read()
      .then((settings) => {
        if (cancelled) return;
        setNeedsOnboarding(!settings?.hasOnboarded);
      })
      .catch(() => {
        if (cancelled) return;
        // If transport isn't wired yet (e.g., browser dev mode without
        // Tauri), skip the wizard rather than blocking the workspace.
        setNeedsOnboarding(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return [needsOnboarding, () => setNeedsOnboarding(false)];
}

function AppRoot() {
  const { manifest, generationStatus, revision, catalogHydrated, catalogRefreshing, catalogError } = useSyncExternalStore(
    subscribeCadManifest,
    getCadManifestSnapshot,
    getCadManifestSnapshot,
  );
  const [needsOnboarding, completeOnboarding] = useOnboardingGate();
  const onboarded = needsOnboarding === false;

  // Live width of the resizable chat panel. Lifted here because it drives both
  // the panel itself and the workspace's right padding so neither overlaps.
  const [chatSidebarWidth, setChatSidebarWidth] = useState(readStoredChatSidebarWidth);

  const projects = useProjectsStore((state) => state.projects);
  const currentProjectId = useProjectsStore((state) => state.currentProjectId);
  const projectsStatus = useProjectsStore((state) => state.status);
  const refreshProjects = useProjectsStore((state) => state.refresh);
  const openProject = useProjectsStore((state) => state.open);

  // Pipe face/edge click tokens from the 3D viewer into the chat sidebar.
  // Hook always runs (rules-of-hooks); the bind is a no-op when the
  // sidebar isn't mounted.
  useEffect(() => bindCadRefSelectionToChatInput(), []);

  // Single-project focus: load the project list once onboarding is done.
  useEffect(() => {
    if (!onboarded) return;
    refreshProjects().catch((err) => console.warn("Failed to load projects", err));
  }, [onboarded, refreshProjects]);

  // Land the user directly in their most recent project (the store keeps
  // `projects` newest-first). When there are none, we deliberately do NOT
  // create one — the first chat message lazily creates a project named from
  // that message (see ChatInput), so we never leave an empty "Untitled
  // project" behind.
  useEffect(() => {
    if (!onboarded || currentProjectId || projectsStatus !== "ready") return;
    const latest = projects[0];
    if (!latest) return;
    openProject(latest.id)
      .then(() => setChatProject(latest.id))
      .catch((err) => console.warn("Failed to open project", err));
  }, [onboarded, currentProjectId, projectsStatus, projects, openProject]);

  // The catalog (Models rail) is scoped to the open project on the backend, so
  // re-read it whenever the active project changes. Project open/create/switch
  // all set the backend's active project before `currentProjectId` updates, so
  // by the time this runs the scan is correctly scoped.
  useEffect(() => {
    if (!currentProjectId) return;
    refreshCadCatalog({ markRefreshing: true }).catch((err) =>
      console.warn("Failed to refresh catalog after project change", err),
    );
  }, [currentProjectId]);

  // Show only printable parts/models in the workspace (rail, home, breadcrumb);
  // hide intermediate files (gcode/dxf/robot) consumers don't care about.
  const modelEntries = useMemo(
    () => manifest.entries.filter(isPrintableModelEntry),
    [manifest.entries],
  );

  if (needsOnboarding === null) {
    return null;
  }

  if (needsOnboarding) {
    return <OnboardingWizard onComplete={completeOnboarding} />;
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <div
        className="flex-1 overflow-hidden"
        style={{ paddingRight: chatSidebarWidth }}
      >
        <CadWorkspace
          manifestRevision={revision}
          manifestEntries={modelEntries}
          generationStatus={generationStatus}
          catalogHydrated={catalogHydrated}
          catalogRefreshing={catalogRefreshing}
          catalogError={catalogError}
          projectMenu={<ProjectMenu />}
        />
      </div>
      <ChatSidebar width={chatSidebarWidth} onWidthChange={setChatSidebarWidth} />
      <UpdateNotifier />
    </div>
  );
}

bootstrap();
