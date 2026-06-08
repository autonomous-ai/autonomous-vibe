import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import CadWorkspace from "./components/CadWorkspace";
import ChatSidebar, { readStoredChatSidebarWidth, persistChatSidebarWidth } from "./components/chat/ChatSidebar";
import { CHAT_MIN_WIDTH, maxChatWidth } from "./workbench/chatLayout.js";
import { bindCadRefSelectionToChatInput } from "./components/chat/cadRefEvents";
import ProjectMenu from "./components/project/ProjectMenu.jsx";
import WelcomeScreen from "./components/onboarding/WelcomeScreen.jsx";
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

  // Stable callbacks so consumers' effects don't re-subscribe every render.
  const complete = useCallback(() => setNeedsOnboarding(false), []);
  const restart = useCallback(() => setNeedsOnboarding(true), []);
  return [needsOnboarding, complete, restart];
}

function AppRoot() {
  const { manifest, generationStatus, revision, catalogHydrated, catalogRefreshing, catalogError } = useSyncExternalStore(
    subscribeCadManifest,
    getCadManifestSnapshot,
    getCadManifestSnapshot,
  );
  const [needsOnboarding, completeOnboarding, restartOnboarding] = useOnboardingGate();
  const onboarded = needsOnboarding === false;

  // Native "Panda → Run Setup Again…" menu item (see src-tauri/src/menu.rs)
  // emits `run_setup_again`. Clear the persisted flag so the wizard sticks even
  // if the user quits mid-setup, then re-show it in place.
  useEffect(() => {
    const unsubscribe = transport.events.subscribe("run_setup_again", () => {
      transport
        .app_settings_read()
        .then((settings) =>
          transport.app_settings_write({ ...settings, hasOnboarded: false }),
        )
        .catch((err) => console.warn("Failed to reset onboarding flag", err))
        .finally(() => restartOnboarding());
    });
    return () => unsubscribe();
  }, [restartOnboarding]);

  // Live width of the resizable chat panel. Lifted here because it drives both
  // the panel itself and the workspace's right padding so neither overlaps.
  const [chatSidebarWidth, setChatSidebarWidth] = useState(readStoredChatSidebarWidth);

  // Chat-vs-workspace layout coordination. AppRoot is the one place the chat
  // panel and the workspace meet, so it owns the math that keeps the model
  // viewer visible while the chat resizes (see workbench/chatLayout.js).
  // CadWorkspace keeps owning its sidebar/tools state and only *publishes* the
  // widths they occupy here; AppRoot commands a sidebar close via a nonce.
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window !== "undefined" && window.innerWidth > 0 ? window.innerWidth : 1600,
  );
  const [modelsSidebar, setModelsSidebar] = useState({ open: false, width: 0 });
  const [toolsSheet, setToolsSheet] = useState({ open: false, width: 0 });
  const [closeLeftSidebarSignal, setCloseLeftSidebarSignal] = useState(0);

  const handleModelsSidebarChange = useCallback((open, width) => {
    setModelsSidebar((prev) =>
      prev.open === open && prev.width === width ? prev : { open, width },
    );
  }, []);
  const handleToolsSheetChange = useCallback((open, width) => {
    setToolsSheet((prev) =>
      prev.open === open && prev.width === width ? prev : { open, width },
    );
  }, []);
  const requestCloseLeftSidebar = useCallback(() => {
    setCloseLeftSidebarSignal((nonce) => nonce + 1);
  }, []);

  const chatLayout = useMemo(
    () => ({
      viewportWidth,
      leftSidebarOpen: modelsSidebar.open,
      leftSidebarWidth: modelsSidebar.width,
      toolsSheetOpen: toolsSheet.open,
      toolsSheetWidth: toolsSheet.width,
    }),
    [viewportWidth, modelsSidebar, toolsSheet],
  );

  // Latest chat width, read by the clamp effect below without making the width
  // a dependency — otherwise every drag frame would re-run the clamp and fight
  // the auto-close (which intentionally lets the chat exceed the sidebar-open
  // cap until the close round-trips back into `chatLayout`).
  const chatSidebarWidthRef = useRef(chatSidebarWidth);
  chatSidebarWidthRef.current = chatSidebarWidth;

  // Track the viewport width so the chat clamp follows window resizes.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onResize = () => setViewportWidth(window.innerWidth > 0 ? window.innerWidth : 1600);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Re-clamp the chat whenever the available space shrinks: the window got
  // narrower, the Models sidebar re-opened, or the tools sheet opened. Keyed on
  // `chatLayout` only (not the width) so it covers the "squeeze chat to keep the
  // viewer visible" behavior without interfering with an in-progress chat drag.
  // Shrinks down to CHAT_MIN — below which the viewer absorbs the overflow as a
  // last resort. Growing space never widens the chat on its own.
  useEffect(() => {
    const max = maxChatWidth(chatLayout);
    if (chatSidebarWidthRef.current > max) {
      const next = Math.max(CHAT_MIN_WIDTH, max);
      setChatSidebarWidth(next);
      persistChatSidebarWidth(next);
    }
  }, [chatLayout]);

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
    return <WelcomeScreen onComplete={completeOnboarding} />;
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
          onModelsSidebarChange={handleModelsSidebarChange}
          onToolsSheetChange={handleToolsSheetChange}
          closeLeftSidebarSignal={closeLeftSidebarSignal}
        />
      </div>
      <ChatSidebar
        width={chatSidebarWidth}
        onWidthChange={setChatSidebarWidth}
        layout={chatLayout}
        onRequestCloseLeftSidebar={requestCloseLeftSidebar}
      />
      <UpdateNotifier />
    </div>
  );
}

bootstrap();
