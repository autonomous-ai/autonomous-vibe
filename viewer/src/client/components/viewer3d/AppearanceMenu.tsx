import { Box, Check, Palette, Scan } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

const LABEL_CLASS =
  "text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground";

/** Overlay "appearance" control: one dropdown that picks how the model is shaded —
 *  a solid-view material preset (recolor / refinish to inspect surface detail), the
 *  translucent x-ray view, or a bare wireframe — plus toggles for random per-part
 *  colors, the feature-edge outline (with a crease-angle slider), and the bloom
 *  post-process. Reads/writes the appearance store. */
export function AppearanceMenu() {
  const mode = useAppearanceStore((s) => s.mode);
  const materialId = useAppearanceStore((s) => s.materialId);
  const partColors = useAppearanceStore((s) => s.partColors);
  const featureEdges = useAppearanceStore((s) => s.featureEdges);
  const featureAngle = useAppearanceStore((s) => s.featureAngle);
  const bloom = useAppearanceStore((s) => s.bloom);
  const setMode = useAppearanceStore((s) => s.setMode);
  const setMaterialId = useAppearanceStore((s) => s.setMaterialId);
  const setPartColors = useAppearanceStore((s) => s.setPartColors);
  const setFeatureEdges = useAppearanceStore((s) => s.setFeatureEdges);
  const setFeatureAngle = useAppearanceStore((s) => s.setFeatureAngle);
  const setBloom = useAppearanceStore((s) => s.setBloom);
  const isXray = mode === "xray";
  const isWireframe = mode === "wireframe";

  // Local slider value for a smooth drag; the re-detection (O(triangles)) is debounced so it
  // only re-runs 250ms after the last move — mirrors the website's crease-angle field.
  const [angleDraft, setAngleDraft] = useState(featureAngle);
  useEffect(() => setAngleDraft(featureAngle), [featureAngle]);
  const commitTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onSlideAngle = (deg: number) => {
    setAngleDraft(deg);
    clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => setFeatureAngle(deg), 250);
  };

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
        <DropdownMenuLabel className={LABEL_CLASS}>Material</DropdownMenuLabel>
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
        {/* Random per-part colors — a toggle (not a mutually-exclusive material pick), so
            preventDefault keeps the menu open to flip it and see the result. */}
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            setPartColors(!partColors);
          }}
          className="gap-2"
        >
          <span className={cn("flex-1", partColors && "text-primary")}>Random part colors</span>
          {partColors ? (
            <Check className="size-4 shrink-0 text-primary" strokeWidth={2} aria-hidden="true" />
          ) : null}
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuLabel className={LABEL_CLASS}>View</DropdownMenuLabel>
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

        <DropdownMenuSeparator />

        <DropdownMenuLabel className={LABEL_CLASS}>Edges</DropdownMenuLabel>
        {/* Feature edges — a toggle, so preventDefault keeps the menu open to flip it and
            adjust the angle below. */}
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            setFeatureEdges(!featureEdges);
          }}
          className="gap-2"
        >
          <span className={cn("flex-1", featureEdges && "text-primary")}>Feature edges</span>
          {featureEdges ? (
            <Check className="size-4 shrink-0 text-primary" strokeWidth={2} aria-hidden="true" />
          ) : null}
        </DropdownMenuItem>
        {/* Angle threshold — a plain (non-item) row so the range slider handles its own
            pointer/keyboard input without the menu hijacking arrow keys or closing. */}
        {featureEdges ? (
          <div className="flex flex-col gap-1 px-2 pb-2 pt-1" onKeyDown={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">Angle</span>
              <span className="text-[11px] tabular-nums text-muted-foreground">{angleDraft}°</span>
            </div>
            <input
              type="range"
              min={1}
              max={179}
              step={1}
              value={angleDraft}
              onChange={(e) => onSlideAngle(Number(e.target.value))}
              aria-label="Feature edge angle"
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
            />
          </div>
        ) : null}

        <DropdownMenuSeparator />

        <DropdownMenuLabel className={LABEL_CLASS}>Effects</DropdownMenuLabel>
        {/* Bloom is a toggle, so preventDefault keeps the menu open to flip it and see the result. */}
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            setBloom(!bloom);
          }}
          className="gap-2"
        >
          <span className={cn("flex-1", bloom && "text-primary")}>Bloom</span>
          {bloom ? (
            <Check className="size-4 shrink-0 text-primary" strokeWidth={2} aria-hidden="true" />
          ) : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
