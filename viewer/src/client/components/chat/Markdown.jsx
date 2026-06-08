import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/ui/utils";
import ChatCopyButton from "./ChatCopyButton";
import QuestionCard from "./QuestionCard";

function flattenText(children) {
  return Array.isArray(children) ? children.join("") : String(children || "");
}

function isKeyword(token, lang) {
  const lower = String(token || "").toLowerCase();
  const language = String(lang || "").toLowerCase();
  if (language === "powershell" || language === "ps1") {
    return /^[a-z][a-z0-9]*-[a-z][a-z0-9-]*$/i.test(token) ||
      [
        "if",
        "else",
        "elseif",
        "foreach",
        "function",
        "param",
        "return",
        "switch",
        "while",
      ].includes(lower);
  }
  return [
    "async",
    "await",
    "class",
    "const",
    "def",
    "else",
    "export",
    "for",
    "from",
    "function",
    "if",
    "import",
    "let",
    "return",
    "var",
    "while",
  ].includes(lower);
}

function highlightedCode(raw, lang) {
  const parts = String(raw || "").split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|#[^\n]*|\/\/[^\n]*|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][\w-]*\b)/g);
  return parts.map((part, index) => {
    if (!part) return null;
    let className = "";
    if (/^["'`]/.test(part)) {
      className = "text-emerald-400";
    } else if (/^(#|\/\/)/.test(part)) {
      className = "text-zinc-500";
    } else if (/^\d/.test(part)) {
      className = "text-sky-300";
    } else if (isKeyword(part, lang)) {
      className = "text-amber-400";
    }
    return className ? (
      <span key={index} className={className}>{part}</span>
    ) : (
      <span key={index}>{part}</span>
    );
  });
}

function CodeBlock({ lang, children }) {
  const raw = flattenText(children).replace(/\n$/, "");
  const label = String(lang || "text").toLowerCase();
  return (
    <div
      data-slot="chat-code-block"
      className="group/code my-2 overflow-hidden rounded-lg border border-white/10 bg-[#2f2f2f] text-[#f4f4f5] shadow-sm"
    >
      <div className="flex h-9 items-center justify-between border-b border-white/5 px-3 text-xs text-zinc-300">
        <span className="truncate font-medium">{label}</span>
        <ChatCopyButton
          value={raw}
          label="Copy code"
          className="size-6 text-zinc-300 opacity-80 hover:bg-white/10 hover:text-white"
        />
      </div>
      <pre className="max-h-72 overflow-auto px-3 py-2.5 text-[12px] leading-relaxed">
        <code className="font-mono text-[#f4f4f5]">{highlightedCode(raw, label)}</code>
      </pre>
    </div>
  );
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
      return <CodeBlock lang={lang} children={children} />;
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
