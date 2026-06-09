// GitHub-style alert blockquotes -> callout notes.
//   > [!TIP]
//   > body text
// The marker is stripped, a bold human label is injected so the note reads
// "Tip — body…" inline, and the blockquote is tagged with `data-callout` so the
// renderer can swap in the styled Callout box.
const ALERTS = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Watch out",
  caution: "Watch out",
};

const MARKER = /^\[!(\w+)\][ \t]*\n?/;

function eachBlockquote(node, fn) {
  if (!node || typeof node !== "object") return;
  if (node.type === "blockquote") fn(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) eachBlockquote(child, fn);
  }
}

export default function remarkCallouts() {
  return (tree) => {
    eachBlockquote(tree, (node) => {
      const paragraph = node.children?.[0];
      if (!paragraph || paragraph.type !== "paragraph") return;
      const lead = paragraph.children?.[0];
      if (!lead || lead.type !== "text") return;

      const match = MARKER.exec(lead.value);
      if (!match) return;
      const kind = match[1].toLowerCase();
      const label = ALERTS[kind];
      if (!label) return;

      // Drop the "[!TIP]" marker (and the soft break after it) from the body.
      lead.value = lead.value.slice(match[0].length);
      if (!lead.value) paragraph.children.shift();

      // Prepend a bold label so the callout reads "Tip — body…" on one line.
      paragraph.children.unshift(
        { type: "strong", children: [{ type: "text", value: label }] },
        { type: "text", value: " — " },
      );

      node.data = {
        ...node.data,
        hProperties: { ...(node.data?.hProperties || {}), "data-callout": kind },
      };
    });
  };
}
