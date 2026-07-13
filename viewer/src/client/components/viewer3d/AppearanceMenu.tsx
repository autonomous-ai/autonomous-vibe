import { Box, Check, Palette, Scan } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { cn } from "@/ui/utils";
import { useAppearanceStore } from "./appearance.store";
import { MATERIAL_PRESETS } from "./materialPresets";

const OVERLAY_TRIGGER =
  "flex size-9 items-center justify-center rounded-md cad-glass-surface border border-sidebar-border text-sidebar-foreground shadow-sm outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";

/** Overlay "appearance" control: one dropdown that picks how the model is shaded —
 *  a solid-view material preset (recolor / refinish to inspect surface detail), the
 *  translucent x-ray view, or a bare wireframe. Reads/writes the appearance store. */
export function AppearanceMenu() {
  const mode = useAppearanceStore((s) => s.mode);
  const materialId = useAppearanceStore((s) => s.materialId);
  const setMode = useAppearanceStore((s) => s.setMode);
  const setMaterialId = useAppearanceStore((s) => s.setMaterialId);
  const isXray = mode === "xray";
  const isWireframe = mode === "wireframe";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Appearance" className={OVERLAY_TRIGGER}>
        {isXray ? (
          <Scan className="size-4 text-primary" strokeWidth={2} aria-hidden="true" />
        ) : isWireframe ? (
          <Box className="size-4 text-primary" strokeWidth={2} aria-hidden="true" />
        ) : (
          <Palette className="size-4" strokeWidth={2} aria-hidden="true" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" sideOffset={8} className="min-w-48">
        <DropdownMenuLabel className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          Material
        </DropdownMenuLabel>
        {MATERIAL_PRESETS.map((preset) => {
          const active = mode === "solid" && preset.id === materialId;
          return (
            <DropdownMenuItem
              key={preset.id}
              onSelect={() => {
                setMode("solid");
                setMaterialId(preset.id);
              }}
              className="gap-2"
            >
              <span className={cn("flex-1", active && "text-primary")}>{preset.name}</span>
              {active ? (
                <Check className="size-4 shrink-0 text-primary" strokeWidth={2} aria-hidden="true" />
              ) : null}
            </DropdownMenuItem>
          );
        })}

        <DropdownMenuSeparator />

        <DropdownMenuLabel className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          View
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => setMode("xray")} className="gap-2">
          <span className={cn("flex-1", isXray && "text-primary")}>X-ray</span>
          {isXray ? (
            <Check className="size-4 shrink-0 text-primary" strokeWidth={2} aria-hidden="true" />
          ) : null}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setMode("wireframe")} className="gap-2">
          <span className={cn("flex-1", isWireframe && "text-primary")}>Wireframe</span>
          {isWireframe ? (
            <Check className="size-4 shrink-0 text-primary" strokeWidth={2} aria-hidden="true" />
          ) : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
