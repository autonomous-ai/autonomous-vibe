"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import AddPrinterDialog from "@/components/printer/AddPrinterDialog.jsx";
import { isEditableTarget } from "@/ui/dom";
import { transport, isTauriRuntime } from "@/lib/transport.ts";
import pandaLogoUrl from "@/assets/favicon.png";

/**
 * In-window menu bar (Windows-style row) mirroring the native macOS application
 * menu (see `desktop/src-tauri/src/menu.rs`). The native menu lives in the OS
 * global menu bar at the top of the *screen* and only shows when Panda is the
 * frontmost app; this row renders inside the webview so the same actions are
 * always reachable *on the window*. Both can coexist — this duplicates, it does
 * not replace.
 *
 * Height is fixed at `h-7` (1.75rem / 28px). `main.jsx` reserves that strip at
 * the top of the app and offsets the workspace + chat sidebar by the same
 * amount; keep the three in sync if you change it.
 */

const MENU_TRIGGER_CLASS =
  "inline-flex h-6 cursor-default select-none items-center rounded px-2 outline-none " +
  "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent " +
  "data-[state=open]:bg-accent data-[state=open]:text-accent-foreground";

// Native-feeling window control buttons: full-bar height, ~46px wide, no
// rounding so they read as part of the chrome. Close gets a red hover.
const WINDOW_CONTROL_CLASS =
  "inline-flex h-7 w-11 cursor-default items-center justify-center text-foreground/80 " +
  "outline-none transition-colors hover:bg-accent hover:text-accent-foreground";
const WINDOW_CLOSE_CLASS =
  "inline-flex h-7 w-11 cursor-default items-center justify-center text-foreground/80 " +
  "outline-none transition-colors hover:bg-red-600 hover:text-white";

// Edit commands run against the webview's currently-focused editable element.
// Mirrors the native Edit menu's predefined items.
function runEditCommand(command) {
  try {
    document.execCommand(command);
  } catch {
    /* execCommand unsupported / nothing focused — no-op */
  }
}

export default function WindowMenuBar() {
  const [aboutOpen, setAboutOpen] = useState(false);
  const [addPrinterOpen, setAddPrinterOpen] = useState(false);
  const [version, setVersion] = useState("");
  const [isMaximized, setIsMaximized] = useState(false);

  // Window controls only mean anything inside Tauri (outside, `windowAction`
  // no-ops); gate the render so a plain browser doesn't show dead buttons.
  const showWindowControls = isTauriRuntime();

  // Opening a dropdown steals focus from whatever field the user was editing,
  // which would make cut/copy/paste/select-all act on nothing. Snapshot the
  // focused editable element (and its selection) at pointer-down — before focus
  // moves into the menu — then restore it right before running the command.
  const editTargetRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    // Source the About version from the updater's latest.json feed (Rust
    // persists it for an offline fallback). The binary's compiled
    // CARGO_PKG_VERSION (via app_info) is unreliable on Windows — the CI
    // version-stamp misses CRLF-checked-out Cargo.toml — so it can read 0.1.0
    // on a real release; latest.json is authoritative.
    transport
      .update_latest_version()
      .then((latest) => {
        if (!cancelled) setVersion(String(latest || ""));
      })
      .catch(() => {
        /* browser/dev stub or feed unavailable: leave version blank */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the maximize/restore icon in sync with the actual window state — the
  // user can maximize via the OS (snap, double-click drag region) too, so poll
  // the window on every resize rather than just toggling our own state.
  useEffect(() => {
    if (!showWindowControls) return undefined;
    let cancelled = false;
    let unlisten;
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const appWindow = getCurrentWindow();
        const sync = async () => {
          try {
            const maximized = await appWindow.isMaximized();
            if (!cancelled) setIsMaximized(maximized);
          } catch {
            /* window gone — ignore */
          }
        };
        await sync();
        unlisten = await appWindow.onResized(() => void sync());
        if (cancelled) unlisten?.();
      } catch {
        /* not in Tauri / window API unavailable — leave default */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [showWindowControls]);

  const captureEditTarget = useCallback(() => {
    const el = document.activeElement;
    if (!isEditableTarget(el)) {
      editTargetRef.current = null;
      return;
    }
    const snapshot = { el, start: null, end: null, range: null };
    if (typeof el.selectionStart === "number") {
      snapshot.start = el.selectionStart;
      snapshot.end = el.selectionEnd;
    } else {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        snapshot.range = selection.getRangeAt(0).cloneRange();
      }
    }
    editTargetRef.current = snapshot;
  }, []);

  const restoreEditTarget = useCallback(() => {
    const snapshot = editTargetRef.current;
    if (!snapshot || !snapshot.el || !document.contains(snapshot.el)) {
      return;
    }
    snapshot.el.focus();
    if (snapshot.start !== null && typeof snapshot.el.setSelectionRange === "function") {
      try {
        snapshot.el.setSelectionRange(snapshot.start, snapshot.end);
      } catch {
        /* element type without ranged selection (e.g. email input) */
      }
    } else if (snapshot.range) {
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(snapshot.range);
      }
    }
  }, []);

  const runEdit = useCallback(
    (command) => {
      restoreEditTarget();
      if (command === "paste") {
        // execCommand('paste') is blocked in most webviews; read the clipboard
        // and insert at the caret instead. Best-effort — falls back to the
        // native Edit menu / Cmd+V if clipboard access is denied.
        navigator.clipboard
          ?.readText()
          .then((text) => {
            if (text) document.execCommand("insertText", false, text);
          })
          .catch(() => runEditCommand("paste"));
        return;
      }
      runEditCommand(command);
    },
    [restoreEditTarget],
  );

  const checkForUpdates = useCallback(() => {
    // Same path as the native "Check for Updates…": re-checks and, if a newer
    // signed bundle exists, downloads + stages it. The already-mounted
    // UpdateNotifier renders progress off the `update_event` stream; if the app
    // is current it stays quiet. Best-effort (updater is absent in dev/browser).
    transport.update_install().catch(() => {});
  }, []);

  const windowAction = useCallback(async (action) => {
    if (!isTauriRuntime()) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const appWindow = getCurrentWindow();
      if (action === "minimize") await appWindow.minimize();
      else if (action === "zoom") await appWindow.toggleMaximize();
      else if (action === "close") await appWindow.close();
    } catch {
      /* window controls are Tauri-only — no-op elsewhere */
    }
  }, []);

  return (
    <div
      data-slot="window-menu-bar"
      className="flex h-7 w-full shrink-0 select-none items-center gap-0.5 border-b border-border/60 bg-background/95 px-1.5 text-xs font-medium text-foreground/90 backdrop-blur"
    >
      <img
        src={pandaLogoUrl}
        alt="Vibe"
        draggable={false}
        className="ml-0.5 mr-1 size-4 shrink-0 rounded-[3px]"
      />

      <DropdownMenu>
        <DropdownMenuTrigger className={MENU_TRIGGER_CLASS}>Vibe</DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={4} className="min-w-44">
          <DropdownMenuItem onSelect={() => setAboutOpen(true)}>About Vibe</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={checkForUpdates}>Check for Updates…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger
          className={MENU_TRIGGER_CLASS}
          onPointerDownCapture={captureEditTarget}
        >
          Edit
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={4}
          className="min-w-44"
          // Keep focus on the restored field instead of bouncing it back to the
          // trigger, so the caret stays where the user left it after editing.
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <DropdownMenuItem onSelect={() => runEdit("undo")}>Undo</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => runEdit("redo")}>Redo</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => runEdit("cut")}>Cut</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => runEdit("copy")}>Copy</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => runEdit("paste")}>Paste</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => runEdit("selectAll")}>Select All</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger className={MENU_TRIGGER_CLASS}>Printer</DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={4} className="min-w-44">
          <DropdownMenuItem onSelect={() => setAddPrinterOpen(true)}>Add Printer…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger className={MENU_TRIGGER_CLASS}>Window</DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={4} className="min-w-44">
          <DropdownMenuItem onSelect={() => void windowAction("minimize")}>Minimize</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void windowAction("zoom")}>Zoom</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void windowAction("close")}>Close Window</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Draggable region: fills the gap between the menus and the window
          controls so the user can move the (undecorated, Windows-only) window
          by dragging the bar. `data-tauri-drag-region` is a no-op outside Tauri. */}
      <div className="h-full flex-1 self-stretch" data-tauri-drag-region />

      {showWindowControls && (
        // -mr-1.5 cancels the bar's right padding so the close button reaches
        // the window edge, the way native controls do.
        <div className="-mr-1.5 flex items-center self-stretch">
          <button
            type="button"
            aria-label="Minimize"
            title="Minimize"
            className={WINDOW_CONTROL_CLASS}
            onClick={() => void windowAction("minimize")}
          >
            <Minus className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={isMaximized ? "Restore" : "Maximize"}
            title={isMaximized ? "Restore" : "Maximize"}
            className={WINDOW_CONTROL_CLASS}
            onClick={() => void windowAction("zoom")}
          >
            {isMaximized ? (
              <Copy className="h-3 w-3" aria-hidden="true" />
            ) : (
              <Square className="h-3 w-3" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            aria-label="Close"
            title="Close"
            className={WINDOW_CLOSE_CLASS}
            onClick={() => void windowAction("close")}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>Vibe</DialogTitle>
            <DialogDescription>
              {version ? `Version ${version}` : "Chat → CAD → slice → print."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" onClick={() => setAboutOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AddPrinterDialog open={addPrinterOpen} onOpenChange={setAddPrinterOpen} />
    </div>
  );
}
