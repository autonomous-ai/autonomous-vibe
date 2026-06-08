// Design-handoff → app-token mapping for the chat surface.
//
// Source: the `design_handoff_chat_ui` reference (a dark + emerald HTML
// prototype). Build decisions for this implementation:
//   • Accent stays MONOCHROME ZINC — the design's emerald `--accent` maps to
//     our `--primary`. Emerald (Tailwind `emerald-500`) is reserved for
//     success / "Sent" / build semantics only.
//   • The chat subtree is pinned to the dark theme (ChatSidebar adds `dark`),
//     so these tokens always resolve to their dark values regardless of the
//     app's active light/dark/glass theme.
//   • Only store-backed turn types are styled; affordances with no backing
//     action (thumbs-up, recap-as-block, Download/View-log) are omitted.
//
//   design token        value (dark)   →  our mapping
//   --bg                #0b0c0e           bg-background (pinned .dark)
//   --surface           #16181c           bg-card             block cards
//   --surface-2         #1d2024           bg-muted            chips, value pills, nested
//   --surface-3         #23262b           bg-muted/70         hover
//   --border            #2a2d33           border-border
//   --border-soft       #212429           border-border/60
//   --text              #e9eaec           text-foreground
//   --text-2            #a6a9b0           text-foreground/75
//   --text-3            #6f737b           text-muted-foreground
//   --user-bubble       #23262c           --ui-surface-solid mix (existing)
//   --accent (emerald)  #34d399           --primary (zinc)    ← monochrome choice
//   --accent-soft       accent @15%       bg-primary/10
//   --accent-line       accent @42%       border-primary/40
//   ok / build / "Sent"                   emerald-500         reserved success accent
//   --warn              #f5b454           amber-500           awaiting-approval
//   --danger            #f87171           destructive
//   --radius 16/11/8                      rounded-xl / rounded-lg / rounded-md
//   --shadow                              shadow-[var(--ui-shadow-soft)]
//   spinner / shimmer                     lucide Loader2 / ui Skeleton
//   inline stroke svg icons               lucide-react (names map 1:1)

// Shared block card chrome (design `.block`): surface card, hairline border,
// soft shadow, clipped corners. Used by tool / thinking / plan / artifact /
// error / running blocks so they read as one family.
export const BLOCK_CARD =
  "overflow-hidden rounded-xl border border-border bg-card shadow-[var(--ui-shadow-soft)]";

// Clickable disclosure header for collapsible blocks (tool, thinking).
export const BLOCK_HEAD =
  "flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors";
