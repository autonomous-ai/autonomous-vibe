const CAD_CATALOG_REFRESH_INTERVAL_MS = 2_000;
const CAD_CATALOG_FETCH_TIMEOUT_MS = 10_000;
const CAD_GENERATION_STATUS_REFRESH_INTERVAL_MS = 750;

function normalizeCadManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    return {
      schemaVersion: 4,
      entries: [],
    };
  }

  return {
    schemaVersion: 4,
    entries: Array.isArray(manifest.entries) ? manifest.entries : [],
  };
}

function normalizeCadGenerationStatus(status) {
  if (!status || typeof status !== "object") {
    return {
      schemaVersion: 1,
      runs: [],
      files: {},
    };
  }
  return {
    schemaVersion: 1,
    runs: Array.isArray(status.runs) ? status.runs : [],
    files: status.files && typeof status.files === "object" ? status.files : {},
  };
}

const listeners = new Set();
let currentManifestSignature = "";
let currentSnapshot = {
  manifest: normalizeCadManifest(),
  generationStatus: normalizeCadGenerationStatus(),
  revision: 0,
  catalogHydrated: false,
  catalogRefreshing: typeof window !== "undefined",
  catalogError: "",
};
let refreshRequestId = 0;
let refreshInFlight = null;
let generationRefreshInFlight = null;
let generationStatusUnavailable = false;
let refreshLoopStarted = false;

currentManifestSignature = JSON.stringify(currentSnapshot.manifest);

function publishCadManifest(nextManifest, { hydrated = true, refreshing = false, error = "" } = {}) {
  const manifest = normalizeCadManifest(nextManifest);
  const manifestSignature = JSON.stringify(manifest);
  const manifestChanged = manifestSignature !== currentManifestSignature;
  const nextSnapshot = {
    manifest: manifestChanged ? manifest : currentSnapshot.manifest,
    generationStatus: currentSnapshot.generationStatus,
    revision: currentSnapshot.revision + 1,
    catalogHydrated: hydrated,
    catalogRefreshing: refreshing,
    catalogError: error,
  };
  if (
    !manifestChanged &&
    nextSnapshot.catalogHydrated === currentSnapshot.catalogHydrated &&
    nextSnapshot.catalogRefreshing === currentSnapshot.catalogRefreshing &&
    nextSnapshot.catalogError === currentSnapshot.catalogError
  ) {
    return;
  }
  if (manifestChanged) {
    currentManifestSignature = manifestSignature;
  }
  currentSnapshot = {
    ...nextSnapshot,
  };
  for (const listener of listeners) {
    listener();
  }
}

function publishCadGenerationStatus(nextGenerationStatus) {
  const generationStatus = normalizeCadGenerationStatus(nextGenerationStatus);
  const previousSignature = JSON.stringify(currentSnapshot.generationStatus);
  const nextSignature = JSON.stringify(generationStatus);
  if (previousSignature === nextSignature) {
    return;
  }
  currentSnapshot = {
    ...currentSnapshot,
    generationStatus,
    revision: currentSnapshot.revision + 1,
  };
  for (const listener of listeners) {
    listener();
  }
}

function publishCadRefreshState({ refreshing = currentSnapshot.catalogRefreshing, error = currentSnapshot.catalogError } = {}) {
  if (
    refreshing === currentSnapshot.catalogRefreshing &&
    error === currentSnapshot.catalogError
  ) {
    return;
  }
  currentSnapshot = {
    ...currentSnapshot,
    revision: currentSnapshot.revision + 1,
    catalogRefreshing: refreshing,
    catalogError: error,
  };
  for (const listener of listeners) {
    listener();
  }
}

async function readJsonError(response, fallback) {
  try {
    const payload = await response.json();
    const error = String(
      payload?.error ||
      payload?.result?.error ||
      payload?.result?.validation?.error?.message ||
      fallback
    ).trim();
    return error || fallback;
  } catch {
    return fallback;
  }
}

async function fetchWithTimeout(url, options, timeoutMs, timeoutMessage) {
  if (typeof AbortController !== "function") {
    return fetch(url, options);
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Default backend: HTTP fetches against the standalone viewer's /__cad/*
// routes. The Tauri shell overrides this via `setCadCatalogBackend()` to
// route through IPC instead (Panda has no HTTP server in-app).
const defaultBackend = {
  async readCatalog() {
    const response = await fetchWithTimeout(
      "/__cad/catalog",
      { cache: "no-store" },
      CAD_CATALOG_FETCH_TIMEOUT_MS,
      `Timed out loading CAD catalog after ${CAD_CATALOG_FETCH_TIMEOUT_MS / 1000}s`
    );
    if (!response.ok) {
      throw new Error(await readJsonError(
        response,
        `Failed to read CAD catalog: ${response.status} ${response.statusText}`
      ));
    }
    return response.json();
  },
  async readGenerationStatus() {
    const response = await fetch("/__cad/generation-status", { cache: "no-store" });
    const contentType = String(response.headers?.get?.("content-type") || "");
    if (!response.ok || !contentType.includes("application/json")) {
      if (response.status === 404 || response.status === 501 || !contentType.includes("application/json")) {
        return null;
      }
      throw new Error(`Failed to read CAD generation status: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  async regenerateStepArtifact(fileRef, { signal } = {}) {
    const response = await fetch(`/__cad/step-artifact?file=${encodeURIComponent(fileRef)}`, {
      method: "POST",
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      throw new Error(await readJsonError(
        response,
        `Failed to generate STEP artifact: ${response.status} ${response.statusText}`
      ));
    }
    return response.json();
  },
  async readStepSourceStatus(fileRef, { signal } = {}) {
    const response = await fetch(`/__cad/step-source-status?file=${encodeURIComponent(fileRef)}`, {
      method: "GET",
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      throw new Error(await readJsonError(
        response,
        `Failed to check STEP source status: ${response.status} ${response.statusText}`
      ));
    }
    return response.json();
  },
};

let cadCatalogBackend = defaultBackend;

/**
 * Swap the backend used by `refreshCadCatalog`, `refreshCadGenerationStatus`,
 * `requestStepArtifactGeneration`, and `requestStepSourceStatus`. The
 * `partial` is overlaid on top of the default fetch-based backend, so
 * callers only need to override the methods that differ. Each call replaces
 * the whole backend (overlays on the default, not on prior overrides),
 * so callers should pass all methods they want to keep customised.
 *
 * Triggers an immediate catalog + generation-status refresh with the new
 * backend, cancelling any in-flight refresh started under the old one.
 */
export function setCadCatalogBackend(partial) {
  cadCatalogBackend = { ...defaultBackend, ...(partial || {}) };
  if (typeof window !== "undefined") {
    refreshInFlight = null;
    refreshCadCatalog({ markRefreshing: true }).catch(() => {});
    generationStatusUnavailable = false;
    generationRefreshInFlight = null;
    refreshCadGenerationStatus();
  }
}

export async function refreshCadCatalog({ markRefreshing = !currentSnapshot.catalogHydrated } = {}) {
  if (refreshInFlight) {
    return refreshInFlight;
  }
  const requestId = ++refreshRequestId;
  if (markRefreshing) {
    publishCadRefreshState({ refreshing: true, error: "" });
  }
  refreshInFlight = (async () => {
    try {
      const catalog = await cadCatalogBackend.readCatalog();
      if (requestId === refreshRequestId) {
        publishCadManifest(catalog, { hydrated: true, refreshing: false, error: "" });
      }
    } catch (error) {
      if (requestId === refreshRequestId) {
        publishCadManifest(currentSnapshot.manifest, {
          hydrated: true,
          refreshing: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    } finally {
      if (requestId === refreshRequestId) {
        refreshInFlight = null;
      }
    }
  })();
  return refreshInFlight;
}

export async function refreshCadGenerationStatus() {
  if (generationStatusUnavailable) {
    return;
  }
  if (generationRefreshInFlight) {
    return generationRefreshInFlight;
  }
  generationRefreshInFlight = (async () => {
    try {
      const status = await cadCatalogBackend.readGenerationStatus();
      if (status === null) {
        generationStatusUnavailable = true;
        publishCadGenerationStatus(null);
        return;
      }
      publishCadGenerationStatus(status);
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn("Failed to refresh CAD generation status", error);
      }
    } finally {
      generationRefreshInFlight = null;
    }
  })();
  return generationRefreshInFlight;
}

export async function requestStepArtifactGeneration(fileRef, { signal } = {}) {
  const normalizedFileRef = String(fileRef || "").trim();
  if (!normalizedFileRef) {
    throw new Error("Missing STEP file");
  }
  const payload = await cadCatalogBackend.regenerateStepArtifact(normalizedFileRef, { signal });
  if (payload?.catalog) {
    publishCadManifest(payload.catalog);
  }
  return payload;
}

export async function requestStepSourceStatus(fileRef, { signal } = {}) {
  const normalizedFileRef = String(fileRef || "").trim();
  if (!normalizedFileRef) {
    throw new Error("Missing STEP file");
  }
  return cadCatalogBackend.readStepSourceStatus(normalizedFileRef, { signal });
}

export function getCadManifestSnapshot() {
  return currentSnapshot;
}

export function subscribeCadManifest(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

if (import.meta.hot) {
  import.meta.hot.on("cad-catalog:changed", () => {
    refreshCadCatalog().catch((error) => {
      console.warn("Failed to refresh CAD catalog", error);
    });
  });
  import.meta.hot.on("cad-generation-status:changed", () => {
    refreshCadGenerationStatus().catch((error) => {
      console.warn("Failed to refresh CAD generation status", error);
    });
  });
}

if (typeof window !== "undefined") {
  const refreshSilently = () => {
    refreshCadCatalog({ markRefreshing: false }).catch((error) => {
      if (import.meta.env.DEV) {
        console.warn("Failed to refresh CAD catalog", error);
      }
    });
    refreshCadGenerationStatus();
  };

  refreshCadCatalog().catch((error) => {
    if (import.meta.env.DEV) {
      console.warn("Failed to refresh CAD catalog", error);
    }
  });
  refreshCadGenerationStatus();

  if (!refreshLoopStarted) {
    refreshLoopStarted = true;
    window.setInterval(() => {
      if (document.visibilityState !== "hidden") {
        refreshSilently();
      }
    }, CAD_CATALOG_REFRESH_INTERVAL_MS);
    window.setInterval(() => {
      if (document.visibilityState !== "hidden") {
        refreshCadGenerationStatus();
      }
    }, CAD_GENERATION_STATUS_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshSilently);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "hidden") {
        refreshSilently();
      }
    });
  }
}
