import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/ui/utils";
import ChatCodeBlock from "./ChatCodeBlock";
import QuestionCard from "./QuestionCard";
import remarkCallouts from "./remarkCallouts";
import "./prose.css";

const REMARK_PLUGINS = [remarkGfm, remarkCallouts];

function flattenText(children) {
  return Array.isArray(children) ? children.join("") : String(children || "");
}

function CalloutIcon({ kind }) {
  const warn = kind === "warning" || kind === "caution";
  return (
    <svg
      className="prose-callout-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {warn ? (
        <>
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </>
      )}
    </svg>
  );
}

function Callout({ kind, children }) {
  return (
    <div className="prose-callout" data-callout={kind}>
      <CalloutIcon kind={kind} />
      <div className="prose-callout-body">{children}</div>
    </div>
  );
}

// Tailwind v4 preflight resets headings/lists; the structural typography
// (headings, lists, markers, counters, checkboxes, callouts) lives in
// prose.css as one `.chat-prose` system. The component map below only covers
// behavioral overrides: link attrs, callout swap-in, inline code / fenced
// blocks, and the chat table.
const COMPONENTS = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  blockquote: ({ node, children }) => {
    // remark-rehype keeps hProperties keys verbatim, so the alert tag arrives
    // as the literal `data-callout` property (not camel-cased).
    const kind = node?.properties?.["data-callout"];
    if (kind) return <Callout kind={String(kind)}>{children}</Callout>;
    return <blockquote>{children}</blockquote>;
  },
  table: ({ children }) => (
    <div
      data-slot="chat-markdown-table"
      className="scrollbar-thin my-[0.85rem] overflow-x-auto rounded-lg border border-border/60 last:!mb-[0.85rem]"
    >
      <table className="w-full min-w-max border-collapse text-left text-[13px] [&_tbody_td:first-child]:font-semibold [&_tbody_td:first-child]:text-foreground">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-border/60">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children, align }) => (
    <th
      className={cn(
        "px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground",
        align === "center" && "text-center",
        align === "right" && "text-right",
      )}
    >
      {children}
    </th>
  ),
  td: ({ children, align }) => (
    <td
      className={cn(
        "px-4 py-3 align-top text-muted-foreground",
        align === "center" && "text-center",
        align === "right" && "text-right",
      )}
    >
      {children}
    </td>
  ),
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const lang = /language-([\w-]+)/.exec(className || "")?.[1];
    // Intercept the question protocol: render clickable choice chips instead
    // of a code block. Fall back to a code block if the JSON isn't valid yet
    // (e.g. still streaming) or malformed.
    if (lang === "panda-questions") {
      // children may be a string or an array of nodes; flatten to text so
      // commas aren't injected (which would break JSON.parse).
      const raw = flattenText(children).trim();
      try {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.questions)) {
          return <QuestionCard questions={parsed.questions} />;
        }
      } catch {
        /* not parseable yet — fall through to code rendering */
      }
    }
    if (lang || flattenText(children).includes("\n")) {
      return <ChatCodeBlock lang={lang} code={flattenText(children)} />;
    }
    return (
      <code className="wrap-break-word rounded bg-muted/60 px-1 py-0.5 text-[12px] font-mono">
        {children}
      </code>
    );
  },
};

/**
 * Render markdown text for chat content (assistant replies + plan cards).
 * @param {{ source: string, className?: string }} props
 */
export default function Markdown({ source, className }) {
  return (
    <div data-slot="chat-markdown" className={cn("chat-prose text-sm text-foreground/90", className)}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {String(source || "")}
      </ReactMarkdown>
    </div>
  );
}
