import { FileText } from "lucide-react";
import { cn } from "@/ui/utils";

function basename(file) {
  const parts = String(file || "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
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
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted/70 disabled:cursor-default",
        className,
      )}
      title={file}
    >
      <FileText className="size-3" aria-hidden />
      <span className="font-medium">{prefix}</span>
      <span className="truncate max-w-[14rem]">{label}</span>
    </button>
  );
}
