import { useEffect, useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { copyTextToClipboard } from "@/ui/clipboard";
import { cn } from "@/ui/utils";
import {
  FILE_STATUS_LEVELS,
  formatFileStatusItemForAgent,
  fileStatusLevelLabel,
  fileStatusWarningOrErrorItems,
  mostIntenseFileStatusLevel
} from "@/workbench/fileStatusItems";
import {
  FileSheetSection
} from "./FileSheet";

const LEVEL_RENDER_META = Object.freeze({
  [FILE_STATUS_LEVELS.ERROR]: {
    badgeVariant: "destructive-outline",
    borderClassName: "border-destructive/70"
  },
  [FILE_STATUS_LEVELS.WARNING]: {
    badgeVariant: "warning-outline",
    borderClassName: "border-amber-500/70"
  },
  [FILE_STATUS_LEVELS.INFO]: {
    badgeVariant: "outline",
    borderClassName: "border-border"
  }
});

const STATUS_COUNT_BADGE_CLASSES = "h-4 min-w-4 self-center rounded-sm px-1 text-[10px] font-medium leading-none";
const STATUS_LEVEL_BADGE_CLASSES = "h-4 self-center rounded-sm px-1.5 py-0 text-[10px] font-medium leading-none";

function renderMetaForLevel(level) {
  return LEVEL_RENDER_META[level] || LEVEL_RENDER_META[FILE_STATUS_LEVELS.INFO];
}

export default function FileStatusSection({
  items = [],
  value = "status"
}) {
  const [expandedItemIds, setExpandedItemIds] = useState(() => new Set());
  const [copiedItemId, setCopiedItemId] = useState("");
  const statusItems = fileStatusWarningOrErrorItems(items);

  useEffect(() => {
    if (!copiedItemId) {
      return undefined;
    }
    const timeout = globalThis.setTimeout(() => setCopiedItemId(""), 1400);
    return () => globalThis.clearTimeout(timeout);
  }, [copiedItemId]);

  if (!statusItems.length) {
    return null;
  }

  const toggleExpanded = (itemId) => {
    setExpandedItemIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  };

  const handleRowKeyDown = (event, itemId, hasDetails) => {
    if (!hasDetails || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }
    event.preventDefault();
    toggleExpanded(itemId);
  };

  const handleCopyIssue = async (event, item) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await copyTextToClipboard(formatFileStatusItemForAgent(item));
      setCopiedItemId(item.id);
    } catch {
      setCopiedItemId("");
    }
  };

  const highestLevel = mostIntenseFileStatusLevel(statusItems);
  const headerMeta = renderMetaForLevel(highestLevel);

  return (
    <FileSheetSection
      value={value}
      title={(
        <span className="flex min-w-0 items-center gap-2">
          <span>Issues</span>
          <Badge variant={headerMeta.badgeVariant} className={STATUS_COUNT_BADGE_CLASSES}>{statusItems.length}</Badge>
        </span>
      )}
    >
      <ul className="space-y-3 px-3 py-3 text-xs leading-5">
        {statusItems.map((item) => {
          const itemMeta = renderMetaForLevel(item.level);
          const details = Array.isArray(item.details) ? item.details : [];
          const hasDetails = details.length > 0;
          const expanded = expandedItemIds.has(item.id);
          return (
            <li
              key={item.id}
              className={cn("min-w-0 border-l-2", itemMeta.borderClassName)}
            >
              <div
                role={hasDetails ? "button" : undefined}
                tabIndex={hasDetails ? 0 : undefined}
                className={cn(
                  "block min-w-0 rounded-md py-1 pl-2.5 pr-1 text-left",
                  hasDetails && "w-full cursor-pointer hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                  !hasDetails && "w-full"
                )}
                onClick={() => {
                  if (hasDetails) {
                    toggleExpanded(item.id);
                  }
                }}
                onKeyDown={(event) => handleRowKeyDown(event, item.id, hasDetails)}
                aria-expanded={hasDetails ? expanded : undefined}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Badge variant={itemMeta.badgeVariant} className={cn("shrink-0", STATUS_LEVEL_BADGE_CLASSES)}>
                    {fileStatusLevelLabel(item.level)}
                  </Badge>
                  <div className="min-w-0 flex-1 truncate font-medium leading-4 text-sidebar-foreground" title={item.title}>{item.title}</div>
                  <span className="ml-auto inline-flex h-5 shrink-0 items-center gap-1">
                    {hasDetails ? (
                      <span className="inline-flex h-5 items-center px-1 text-[10px] font-normal text-muted-foreground">
                        {expanded ? "Hide" : "Details"}
                      </span>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="h-5 rounded-sm px-1 text-[10px] font-normal text-muted-foreground hover:text-sidebar-foreground"
                      onClick={(event) => handleCopyIssue(event, item)}
                      aria-label={copiedItemId === item.id ? "Copied issue" : "Copy issue for agent"}
                      title={copiedItemId === item.id ? "Copied" : "Copy issue for agent"}
                    >
                      {copiedItemId === item.id ? "Copied" : "Copy"}
                    </Button>
                  </span>
                </div>
                {item.message ? (
                  <div className="mt-1 line-clamp-2 min-w-0 break-words text-[11px] font-normal leading-4 text-muted-foreground">
                    {item.message}
                  </div>
                ) : null}
              </div>
              {hasDetails && expanded ? (
                <div className="mt-2 space-y-2 pl-2.5">
                  <dl className="space-y-1 text-[11px] leading-4">
                    {details.map((detailItem, index) => (
                      <div key={`${item.id}:${detailItem.label}:${index}`} className="min-w-0">
                        <dt className="text-muted-foreground">{detailItem.label}</dt>
                        <dd className={cn(
                          "min-w-0 break-words text-sidebar-foreground",
                          detailItem.mono && "break-all font-mono text-[10px] leading-4"
                        )}>
                          {detailItem.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </FileSheetSection>
  );
}
