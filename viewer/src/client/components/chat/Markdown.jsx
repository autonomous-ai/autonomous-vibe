import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/ui/utils";
import QuestionCard from "./QuestionCard";

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
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const lang = /language-([\w-]+)/.exec(className || "")?.[1];
    // Intercept the question protocol: render clickable choice chips instead
    // of a code block. Fall back to a code block if the JSON isn't valid yet
    // (e.g. still streaming) or malformed.
    if (lang === "panda-questions") {
      // children may be a string or an array of nodes; flatten to text so
      // commas aren't injected (which would break JSON.parse).
      const raw = (Array.isArray(children) ? children.join("") : String(children || "")).trim();
      try {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.questions)) {
          return <QuestionCard questions={parsed.questions} />;
        }
      } catch {
        /* not parseable yet — fall through to code rendering */
      }
    }
    if (lang) {
      return (
        <code className="block max-h-48 overflow-auto rounded bg-background/60 p-2 text-[11px] leading-snug text-foreground/80">
          {children}
        </code>
      );
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
