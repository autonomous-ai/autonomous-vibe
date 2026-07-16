import { useEffect, useState } from "react";

/** WebGL scene colors that follow the app's light/dark theme. Resolved from the
 *  `--cad-viewer-*` CSS vars (light in :root, overridden in .dark), so the scene
 *  matches the surrounding chrome instead of being pinned dark. Every value is a
 *  THREE.Color-parseable string (hex / CSS named) — the vars must never be oklch(). */
export interface ViewerTheme {
  /** Canvas clear color / scene background. */
  background: string;
  /** Ground grid minor (cell) line color. */
  gridCell: string;
  /** Ground grid major (section) line color. */
  gridSection: string;
  /** Reflective floor base tint. */
  floor: string;
}

/** Dark-theme fallbacks — used pre-hydration / SSR and if a var is ever missing, so
 *  the scene keeps its original charcoal look rather than flashing to a bad color. */
const FALLBACK: ViewerTheme = {
  background: "#0e0f13",
  gridCell: "#4b5563",
  gridSection: "#8a93a2",
  floor: "#08090c",
};

function readVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function readTheme(): ViewerTheme {
  return {
    background: readVar("--cad-viewer-bg", FALLBACK.background),
    gridCell: readVar("--cad-viewer-grid-cell", FALLBACK.gridCell),
    gridSection: readVar("--cad-viewer-grid-section", FALLBACK.gridSection),
    floor: readVar("--cad-viewer-floor", FALLBACK.floor),
  };
}

/** Live theme-aware viewer palette. Re-reads the `--cad-viewer-*` vars whenever the app
 *  toggles light/dark — it flips the `.dark` class / `data-theme` on <html>
 *  (applyColorSchemeToDocument), so a MutationObserver on those attributes recolors the
 *  scene without a reload. Mirrors the G-code preview pane's theme observer. */
export function useViewerTheme(): ViewerTheme {
  // Lazy initializer reads the resolved vars on first render (this viewer is client-only,
  // and the theme class is applied at startup) so light mode paints light with no flash.
  const [theme, setTheme] = useState<ViewerTheme>(readTheme);

  useEffect(() => {
    // Re-read on mount in case a var resolved after first paint, then watch for toggles.
    setTheme(readTheme());
    if (typeof MutationObserver !== "function") return undefined;
    const root = document.documentElement;
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(root, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return () => observer.disconnect();
  }, []);

  return theme;
}
