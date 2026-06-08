import { useEffect, useMemo, useState } from "react";
import ChatCopyButton from "./ChatCopyButton";

const LANGUAGE_ALIASES = {
  cjs: "javascript",
  mjs: "javascript",
  node: "javascript",
  ps: "powershell",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  tsx: "typescript",
  jsx: "javascript",
  yml: "yaml",
};

function normalizeLanguage(lang) {
  const lower = String(lang || "").trim().toLowerCase();
  return LANGUAGE_ALIASES[lower] || lower;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function guessLanguage(hljs, raw, lang) {
  const normalized = normalizeLanguage(lang);
  if (normalized && hljs.getLanguage(normalized)) {
    return normalized;
  }
  const trimmed = String(raw || "").trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return "json";
  }
  return "";
}

function highlightedHtml(hljs, raw, lang) {
  const language = guessLanguage(hljs, raw, lang);
  if (language) {
    try {
      return {
        language,
        html: hljs.highlight(String(raw || ""), { language, ignoreIllegals: true }).value,
      };
    } catch {
      // Fall through to auto-detect.
    }
  }
  try {
    const result = hljs.highlightAuto(String(raw || ""));
    return { language: result.language || "", html: result.value };
  } catch {
    return { language: "", html: escapeHtml(raw) };
  }
}

export default function ChatCodeBlock({
  code,
  lang,
  label,
  copyLabel = "Copy code",
  className = "",
  maxHeightClassName = "max-h-72",
}) {
  const raw = useMemo(() => String(code ?? "").replace(/\n$/, ""), [code]);
  const [highlighted, setHighlighted] = useState(() => ({
    language: normalizeLanguage(lang),
    html: escapeHtml(raw),
  }));
  const displayLabel = String(label || lang || highlighted.language || "text").toLowerCase();

  useEffect(() => {
    let cancelled = false;
    setHighlighted({ language: normalizeLanguage(lang), html: escapeHtml(raw) });
    import("highlight.js")
      .then((module) => {
        if (cancelled) return;
        setHighlighted(highlightedHtml(module.default || module, raw, lang));
      })
      .catch(() => {
        if (!cancelled) {
          setHighlighted({ language: normalizeLanguage(lang), html: escapeHtml(raw) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [raw, lang]);

  return (
    <div
      data-slot="chat-code-block"
      className={`chat-code-highlight group/code my-2 overflow-hidden rounded-lg border border-white/10 bg-[#2f2f2f] text-[#f4f4f5] shadow-sm ${className}`}
    >
      <style>{`
        .chat-code-highlight .hljs-keyword,
        .chat-code-highlight .hljs-built_in,
        .chat-code-highlight .hljs-literal,
        .chat-code-highlight .hljs-type,
        .chat-code-highlight .hljs-selector-tag {
          color: #f59e0b;
        }
        .chat-code-highlight .hljs-string,
        .chat-code-highlight .hljs-regexp,
        .chat-code-highlight .hljs-symbol,
        .chat-code-highlight .hljs-bullet {
          color: #34d399;
        }
        .chat-code-highlight .hljs-number,
        .chat-code-highlight .hljs-attr,
        .chat-code-highlight .hljs-variable,
        .chat-code-highlight .hljs-template-variable {
          color: #7dd3fc;
        }
        .chat-code-highlight .hljs-title,
        .chat-code-highlight .hljs-title.function_,
        .chat-code-highlight .hljs-section,
        .chat-code-highlight .hljs-name {
          color: #f59e0b;
        }
        .chat-code-highlight .hljs-comment,
        .chat-code-highlight .hljs-quote {
          color: #71717a;
        }
        .chat-code-highlight .hljs-meta,
        .chat-code-highlight .hljs-operator,
        .chat-code-highlight .hljs-punctuation {
          color: #d4d4d8;
        }
      `}</style>
      <div className="flex h-9 items-center justify-between border-b border-white/5 px-3 text-xs text-zinc-300">
        <span className="truncate font-medium">{displayLabel}</span>
        <ChatCopyButton
          value={raw}
          label={copyLabel}
          className="size-6 text-zinc-300 opacity-80 hover:bg-white/10 hover:text-white"
        />
      </div>
      <pre className={`${maxHeightClassName} overflow-auto px-3 py-2.5 text-[12px] leading-relaxed`}>
        <code
          className="font-mono text-[#f4f4f5]"
          dangerouslySetInnerHTML={{ __html: highlighted.html }}
        />
      </pre>
    </div>
  );
}
