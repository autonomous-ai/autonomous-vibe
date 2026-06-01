// Pure helpers used by ChatInput.jsx. Lives in its own module so node:test
// can exercise them without going through a JSX transform.

export function buildSendValue(rawText, pendingTokens) {
  const tokens = (Array.isArray(pendingTokens) ? pendingTokens : [])
    .map((token) => String(token || "").trim())
    .filter(Boolean);
  const text = String(rawText || "").trim();
  if (!tokens.length) return text;
  const tokenLine = tokens.join(" ");
  if (!text) return tokenLine;
  return `${tokenLine}\n\n${text}`;
}

// Lazily-created projects are never named by the user. They carry this
// placeholder until Claude Code's AI title lands in the session JSONL, at
// which point the Rust `project_list` command upgrades the stored name in
// place (see commands/project.rs `resolve_ai_title`). Must match the Rust
// `PLACEHOLDER_PROJECT_NAME` constant.
export const PLACEHOLDER_PROJECT_NAME = "New project";
