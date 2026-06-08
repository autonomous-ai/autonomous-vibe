import { FileText } from "lucide-react";
import { cn } from "@/ui/utils";
import { BLOCK_CARD } from "./chatTheme";

function basename(file) {
  const parts = String(file || "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

// Friendly file-kind for the meta line, derived from the extension (the store
// gives us a path + new/modified reason, not a MIME type or size).
const KIND_BY_EXT = {
  stl: "3D model",
  step: "3D model",
  stp: "3D model",
  "3mf": "3D model",
  obj: "3D model",
  gcode: "G-code",
  png: "Image",
  jpg: "Image",
  jpeg: "Image",
  webp: "Image",
  py: "Source",
  json: "Data",
};

function fileKind(file) {
  const ext = String(file || "").split(".").pop()?.toLowerCase() || "";
  return KIND_BY_EXT[ext] || (ext ? ext.toUpperCase() : "File");
}

export default function ArtifactBadge({ file, reason, onOpen, className }) {
  const label = basename(file) || file;
  const prefix = reason === "new" ? "new" : "modified";
  return (
    <button
      type="button"
      data-slot="chat-artifact-badge"
      data-reason={reason}
      onClick={onOpen ? () => onOpen(file) : undefined}
      disabled={!onOpen}
      className={cn(
        BLOCK_CARD,
        "group/artifact flex w-full items-center gap-3.5 px-3 py-3 text-left transition-colors hover:bg-muted/40 disabled:cursor-default disabled:hover:bg-card",
        className,
      )}
      title={file}
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-foreground/70">
        <FileText className="size-5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground">{label}</span>
        <span className="mt-0.5 block text-[12px] text-muted-foreground">
          {fileKind(file)} · {prefix}
        </span>
      </span>
      {onOpen ? (
        <span className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors group-hover/artifact:text-foreground">
          Open
        </span>
      ) : null}
    </button>
  );
}
