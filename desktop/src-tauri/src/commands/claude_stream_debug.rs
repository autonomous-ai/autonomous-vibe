//! Debug mirror for the spawned `claude` CLI's stream-json, gated behind the
//! `PANDA_DEBUG_CLAUDE` env var (default on in `scripts/dev.sh`). This is purely
//! a presentation concern — turning raw stream-json lines into compact,
//! colorized one-liners for the dev console — so it lives apart from
//! `claude_driver`, whose job is spawning the subprocess and translating the
//! stream into `ChatEvent`s. The driver keeps only the call-sites that decide
//! when to mirror a line; the formatting lives here.
//!
//! Modes (value of `PANDA_DEBUG_CLAUDE`): unset/`0` → off, `raw` → full
//! stream-json verbatim, any other truthy value → pretty one-liners.

use serde_json::Value;

/// Whether to mirror the spawned `claude` CLI's stdout/stderr to this process's
/// stderr at all. Opt in with `PANDA_DEBUG_CLAUDE` truthy (same env convention
/// as `PANDA_DEVTOOLS`).
///
/// Debug-only: this is a developer console aid, so the master switch is hard-off
/// in release (production) builds — the `PANDA_DEBUG_CLAUDE` env var is ignored
/// there. `cfg!(debug_assertions)` short-circuits before the env read, so every
/// downstream `if debug_stream { … }` path compiles out to a no-op in prod.
pub(crate) fn enabled() -> bool {
    cfg!(debug_assertions)
        && std::env::var("PANDA_DEBUG_CLAUDE").is_ok_and(|v| v != "0" && !v.is_empty())
}

/// `PANDA_DEBUG_CLAUDE=raw` dumps the full stream-json lines verbatim; any other
/// truthy value pretty-prints them (the default in `scripts/dev.sh`).
pub(crate) fn raw() -> bool {
    std::env::var("PANDA_DEBUG_CLAUDE").is_ok_and(|v| v.eq_ignore_ascii_case("raw"))
}

/// Whether to colorize the pretty stream — only when stderr is a real TTY, so
/// piping `dev.sh 2> file.log` stays clean.
pub(crate) fn color() -> bool {
    use std::io::IsTerminal;
    std::io::stderr().is_terminal()
}

/// Wrap `s` in an ANSI SGR code when `on`, else return it unchanged.
pub(crate) fn paint(on: bool, code: &str, s: &str) -> String {
    if on {
        format!("\x1b[{code}m{s}\x1b[0m")
    } else {
        s.to_string()
    }
}

/// First 8 chars of an id (e.g. a session UUID), by char so multibyte input
/// never slices mid-byte.
pub(crate) fn short_id(s: &str) -> String {
    s.chars().take(8).collect()
}

/// Collapse whitespace and clip to `max` chars for one-line logging.
fn clip(s: &str, max: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let n = flat.chars().count();
    if n <= max {
        flat
    } else {
        let head: String = flat.chars().take(max).collect();
        format!("{head}… (+{} chars)", n - max)
    }
}

/// One-line summary + ANSI color code for a tool call's input. Highlights the
/// empty-`ExitPlanMode` case (the resume bug) in red so it's unmissable.
fn tool_summary(name: &str, input: &Value) -> (&'static str, String) {
    match name {
        "ExitPlanMode" => {
            let plan = input.get("plan").and_then(Value::as_str).unwrap_or("");
            let file = input
                .get("planFilePath")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            if !plan.trim().is_empty() {
                ("2", format!("plan: {} chars", plan.chars().count()))
            } else if let Some(f) = file {
                ("33", format!("plan: empty → file {}", short_id(f)))
            } else {
                ("31", "plan: EMPTY — no planFilePath ⚠ (recovering from transcript)".into())
            }
        }
        "AskUserQuestion" => {
            let qs = input.get("questions").and_then(Value::as_array);
            let headers: Vec<&str> = qs
                .into_iter()
                .flatten()
                .filter_map(|q| q.get("header").and_then(Value::as_str))
                .collect();
            ("36", format!("{} question(s): {}", headers.len(), headers.join(", ")))
        }
        _ => ("2", clip(&serde_json::to_string(input).unwrap_or_default(), 140)),
    }
}

/// Pretty-print one raw stream-json line from the spawned `claude` CLI as a
/// concise, scannable summary, or `None` to skip noise (status pings, token
/// counters, per-delta `stream_event`s — the assembled blocks come through on
/// the `assistant` lines). `label` distinguishes streams; `color` toggles ANSI.
pub(crate) fn pretty_line(line: &str, label: &str, color: bool) -> Option<String> {
    let o: Value = serde_json::from_str(line.trim()).ok()?;
    // `row(code, sym, body)` → `[label] <sym body>` with the body painted.
    let row = |code: &str, sym: &str, body: &str| {
        format!(
            "{} {}",
            paint(color, "2", &format!("[{label}]")),
            paint(color, code, &format!("{sym} {body}")),
        )
    };
    let mut out: Vec<String> = Vec::new();
    match o.get("type").and_then(Value::as_str).unwrap_or("") {
        "system" if o.get("subtype").and_then(Value::as_str) == Some("init") => {
            let sid = short_id(o.get("session_id").and_then(Value::as_str).unwrap_or(""));
            let model = o.get("model").and_then(Value::as_str).unwrap_or("?");
            let mode = o.get("permissionMode").and_then(Value::as_str).unwrap_or("?");
            let ntools = o.get("tools").and_then(Value::as_array).map_or(0, Vec::len);
            out.push(row(
                "36",
                "◆",
                &format!("init  session={sid}  model={model}  mode={mode}  tools={ntools}"),
            ));
        }
        "assistant" => {
            let blocks = o
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(Value::as_array);
            for b in blocks.into_iter().flatten() {
                match b.get("type").and_then(Value::as_str).unwrap_or("") {
                    "thinking" => out.push(row("2", "·", "thinking")),
                    "text" => {
                        let t = b.get("text").and_then(Value::as_str).unwrap_or("");
                        if !t.trim().is_empty() {
                            out.push(row("32", "»", &clip(t, 300)));
                        }
                    }
                    "tool_use" => {
                        let name = b.get("name").and_then(Value::as_str).unwrap_or("?");
                        out.push(row("33;1", "⚙", name));
                        let (code, summary) =
                            tool_summary(name, b.get("input").unwrap_or(&Value::Null));
                        out.push(row(code, "  ↳", &summary));
                    }
                    _ => {}
                }
            }
        }
        "user" => {
            let blocks = o
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(Value::as_array);
            for b in blocks.into_iter().flatten() {
                if b.get("type").and_then(Value::as_str) == Some("tool_result") {
                    if b.get("is_error").and_then(Value::as_bool).unwrap_or(false) {
                        out.push(row("31", "←", "tool_result ERROR"));
                    } else {
                        out.push(row("2", "←", "tool_result ok"));
                    }
                }
            }
        }
        "result" => {
            let sub = o.get("subtype").and_then(Value::as_str).unwrap_or("");
            let err = o.get("is_error").and_then(Value::as_bool).unwrap_or(false);
            let mut body = format!("result {sub}");
            if let Some(ms) = o.get("duration_ms").and_then(Value::as_u64) {
                body.push_str(&format!("  ({:.1}s)", ms as f64 / 1000.0));
            }
            out.push(row(if err { "31" } else { "34" }, "■", &body));
        }
        _ => {} // stream_event / other system subtypes: skip (noise)
    }
    (!out.is_empty()).then(|| out.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_collapses_whitespace_and_truncates_by_chars() {
        // Short input: whitespace (incl. newlines/tabs) collapses to spaces.
        assert_eq!(clip("a\n  b\t c", 100), "a b c");
        // Long input: truncated to `max` chars with a remainder note.
        let long = "x".repeat(50);
        assert_eq!(clip(&long, 10), format!("{}… (+40 chars)", "x".repeat(10)));
        // Multibyte safety: counts/truncates by char, never panics mid-byte.
        let emoji = "🧩".repeat(20); // 4 bytes each, 1 char each
        let out = clip(&emoji, 5);
        assert_eq!(out.chars().filter(|c| *c == '🧩').count(), 5);
        assert!(out.ends_with("(+15 chars)"));
    }

    #[test]
    fn short_id_takes_first_eight_chars_safely() {
        assert_eq!(short_id("88db5034-e716-556b"), "88db5034");
        assert_eq!(short_id("abc"), "abc"); // shorter than 8 → unchanged
        assert_eq!(short_id(""), "");
        assert_eq!(short_id(&"🧩".repeat(10)).chars().count(), 8); // by char, not byte
    }

    #[test]
    fn paint_wraps_only_when_enabled() {
        assert_eq!(paint(true, "31", "hi"), "\x1b[31mhi\x1b[0m");
        assert_eq!(paint(false, "31", "hi"), "hi"); // no ANSI when piped to a file
    }

    #[test]
    fn pretty_line_skips_noise_and_summarizes_blocks() {
        let p = |l: &str| pretty_line(l, "claude", false);

        // Noise: per-delta stream_event + status pings are skipped.
        assert!(p(r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}}"#).is_none());
        assert!(p(r#"{"type":"system","subtype":"status","status":"requesting"}"#).is_none());

        // init → one compact line.
        let init = p(r#"{"type":"system","subtype":"init","session_id":"88db5034-e716","model":"claude-opus-4-8","permissionMode":"bypassPermissions","tools":["a","b","c"]}"#).unwrap();
        assert!(init.contains("init") && init.contains("session=88db5034") && init.contains("mode=bypassPermissions") && init.contains("tools=3"));

        // assistant text block.
        let text = p(r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi! Your plan is ready."}]}}"#).unwrap();
        assert!(text.contains("» Hi! Your plan is ready."));
    }

    #[test]
    fn pretty_line_flags_empty_exit_plan_mode() {
        let p = |l: &str| pretty_line(l, "claude", false);
        // The resume-bug shape from the real log: ExitPlanMode input={}.
        let empty = p(r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"ExitPlanMode","input":{}}]}}"#).unwrap();
        assert!(empty.contains("ExitPlanMode") && empty.contains("EMPTY"));
        // Populated plan reports its size, not EMPTY.
        let full = p(r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"ExitPlanMode","input":{"plan":"Base plus lid, 120x60mm"}}]}}"#).unwrap();
        assert!(full.contains("plan:") && full.contains("chars") && !full.contains("EMPTY"));
        // AskUserQuestion shows the count + headers.
        let q = p(r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"AskUserQuestion","input":{"questions":[{"header":"Orient"},{"header":"Mount"}]}}]}}"#).unwrap();
        assert!(q.contains("2 question(s)") && q.contains("Orient") && q.contains("Mount"));
    }
}
