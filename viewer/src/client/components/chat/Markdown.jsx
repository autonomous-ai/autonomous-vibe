import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/ui/utils";
import ChatCodeBlock from "./ChatCodeBlock";
import QuestionCard from "./QuestionCard";

function flattenText(children) {
  return Array.isArray(children) ? children.join("") : String(children || "");
}

// Tailwind v4 preflight resets headings/lists, so we style each element
// explicitly to match the chat type scale. Kept small and dependency-light
// (no typography plugin).
const COMPONENTS = {
  h1: ({ children }) => <h1 className="mt-1 mb-1 text-sm font-semibold text-foreground">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-1 mb-1 text-sm font-semibold text-foreground">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-1 mb-0.5 text-xs font-semibold uppercase tracking-wide text-foreground/80">{children}</h3>,
  p: ({ children }) => <p className="my-1 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="my-1 list-disc pl-4">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal pl-4">{children}</ol>,
  li: ({ children }) => <li className="my-0.5">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div
      data-slot="chat-markdown-table"
      className="scrollbar-thin my-2 overflow-x-auto rounded-md border border-border/50"
    >
      <table className="w-full min-w-max border-collapse text-left text-[13px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-border/60 bg-muted/40">{children}</thead>,
  tbody: ({ children }) => <tbody className="divide-y divide-border/40">{children}</tbody>,
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children, align }) => (
    <th
      className={cn(
        "px-2.5 py-1.5 font-semibold text-foreground",
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
        "px-2.5 py-1.5 align-top",
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
    return <code className="rounded bg-muted/60 px-1 py-0.5 text-[12px] font-mono">{children}</code>;
  },
};

/**
 * Render markdown text for chat content (assistant replies + plan cards).
 * @param {{ source: string, className?: string }} props
 */
export default function Markdown({ source, className }) {
  return (
    <div data-slot="chat-markdown" className={cn("text-sm text-foreground/90", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {String(source || "")}
      </ReactMarkdown>
    </div>
  );
}
