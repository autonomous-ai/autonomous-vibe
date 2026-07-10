"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/ui/utils";
import {
  COLOR_SCHEMES,
  COLOR_SCHEME_STORAGE_KEY,
  applyColorSchemeToDocument,
  readColorSchemePreference,
  writeColorSchemePreference,
} from "@/ui/colorScheme.js";

/** Icon per color-scheme id (System / Light / Dark). */
const SCHEME_ICONS = { system: Monitor, light: Sun, dark: Moon };

/**
 * Appearance / theme control — a System / Light / Dark segmented picker,
 * mirroring panda-website's settings dialog. Drives the app-wide color-scheme
 * preference (`cad-viewer:color-scheme`) that the workbench already honors: it
 * persists the choice, applies it to the document immediately, and dispatches a
 * synthetic `storage` event so a live `CadWorkspace` (a sibling in the same
 * document — its own listener only fires for cross-tab writes) re-reads it.
 */
export default function ThemeSetting() {
  const [scheme, setScheme] = useState(() => readColorSchemePreference());
  const [prefersDark, setPrefersDark] = useState(false);

  // Track the OS preference so the "System" option resolves correctly.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setPrefersDark(query.matches === true);
    sync();
    query.addEventListener?.("change", sync);
    return () => query.removeEventListener?.("change", sync);
  }, []);

  const select = (id) => {
    setScheme(id);
    writeColorSchemePreference(id);
    applyColorSchemeToDocument(id, document.documentElement, { prefersDark });
    // Nudge the mounted workbench to re-read the preference (same-document
    // writes don't emit a real `storage` event). Best-effort — the direct
    // apply above already updated the DOM.
    try {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: COLOR_SCHEME_STORAGE_KEY,
          storageArea: window.localStorage,
        }),
      );
    } catch {
      /* StorageEvent construction can throw in some engines; ignore. */
    }
  };

  return (
    <div className="grid grid-cols-3 gap-2">
      {COLOR_SCHEMES.map(({ id, label }) => {
        const Icon = SCHEME_ICONS[id] ?? Monitor;
        const active = scheme === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => select(id)}
            aria-pressed={active}
            className={cn(
              "flex flex-col items-center gap-2 rounded-lg border px-3 py-4 transition-colors",
              active
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border bg-card/50 text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Icon className="size-5" aria-hidden="true" />
            <span className="text-xs font-medium">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
