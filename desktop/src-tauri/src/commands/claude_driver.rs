//! Rust port of cadcode's `api/src/cadcode/claude_cli/driver.py`.
//!
//! Track F replaces the Track C scaffold with a working subprocess
//! driver: it spawns the host `claude -p` CLI, parses stream-json
//! stdout line-by-line, forwards translated `ChatEvent`s to a caller
//! callback, snapshots the workspace before/after for artifact diffs,
//! and supports external cancellation via `CancellationToken`.
//!
//! v1 inherits the user's Claude Code subscription auth from the host
//! environment. The Panda-Cloud env override (`use_panda_cloud`) is a
//! v2 hook — wired via [`build_env`] so the v2 settings toggle is a
//! purely additive change.

use crate::commands::claude_stream_debug;
use crate::ipc::types::{ArtifactReason, ChatEvent, TurnPhaseTag};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::SystemTime;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;
use walkdir::WalkDir;

/// Extensions watched per contract §3: `.step .stp .stl .3mf .gcode
/// .png .py .json` (lowercase, case-sensitive).
pub const WATCHED_EXTENSIONS: &[&str] = &[
    "step", "stp", "stl", "3mf", "gcode", "png", "py", "json",
];

/// Stdout read buffer raised to 32 MiB to match cadcode's reference
/// implementation. Claude emits whole `tool_result` blocks (including
/// base64-encoded PNG image content) as single JSONL lines that
/// routinely exceed the default 64 KiB.
pub const STDOUT_BUFFER_BYTES: usize = 32 * 1024 * 1024;

/// One file's mtime, captured pre-turn so we can diff after the turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MtimeEntry {
    pub mtime: SystemTime,
}

/// A `(workspace_relative_path, MtimeEntry)` snapshot of every watched
/// file under a session workspace dir. Recursive into subdirs per
/// contract §3.
pub type MtimeSnapshot = HashMap<String, MtimeEntry>;

/// Which phase of the chat workflow a turn runs in. Maps directly onto
/// Claude Code's native `--permission-mode`.
///
/// - `Plan`: `--permission-mode bypassPermissions` — the model designs the
///   part and ends by calling the built-in `ExitPlanMode` tool. It runs with
///   full permission so it can perform read-only analysis to back its plan
///   with real numbers (e.g. import an existing project's `.step`/`.stl` with
///   the cadcode venv Python to compute mass properties / center of mass for
///   the Physics check). The plan turn is bounded by `PLAN_SYSTEM_PROMPT`, not
///   the CLI, to NOT write part source or generate final artifacts — the
///   committed build still happens only after the user approves, so the
///   viewer and approve→build flow are unchanged.
/// - `Implement`: `--permission-mode bypassPermissions` — runs unattended.
///   `acceptEdits` is NOT enough: it auto-applies Edit/Write but still
///   prompts for Bash, and the cadcode generator is a Bash command
///   (`python ~/.claude/skills/cadcode/scripts/cad <file>`). In headless
///   `-p` mode there is no human to answer that prompt, so generation was
///   denied — the source `.py` got written but no STL/STEP was ever
///   produced. `bypassPermissions` lets the build phase run the generator.
///   This is safe here: the turn is non-interactive by design, the workspace
///   is scoped via `--add-dir <project>`, and the cadcode skill itself runs
///   sandboxed (RLIMIT_AS / RLIMIT_CPU / import allow-list).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnPhase {
    Plan,
    Implement,
    /// Automatic post-build geometry review. Runs *inside* a build turn (it is
    /// never started from the chat layer): after the Implement child exits, the
    /// driver reads the deterministic geometry `warnings` cadpy wrote into the
    /// `.step.json` sidecars and, while any remain, resumes the same session in
    /// this phase to silently render-inspect-and-fix the parts. Same
    /// `bypassPermissions` as Implement (it writes source + regenerates).
    Review,
}

impl TurnPhase {
    /// The `--permission-mode` value passed to `claude -p`.
    pub fn permission_mode(self) -> &'static str {
        match self {
            TurnPhase::Plan | TurnPhase::Implement | TurnPhase::Review => "bypassPermissions",
        }
    }

    /// The phase-specific `--append-system-prompt` text.
    pub fn system_prompt(self) -> &'static str {
        match self {
            TurnPhase::Plan => PLAN_SYSTEM_PROMPT,
            TurnPhase::Implement => IMPLEMENT_SYSTEM_PROMPT,
            TurnPhase::Review => REVIEW_SYSTEM_PROMPT,
        }
    }

    /// The serializable wire tag for this phase (carried on `TurnStart`).
    /// Review turns run silently inside a build turn and never emit their own
    /// `TurnStart`, so they ride under the `Implement` tag.
    pub fn tag(self) -> TurnPhaseTag {
        match self {
            TurnPhase::Plan => TurnPhaseTag::Plan,
            TurnPhase::Implement | TurnPhase::Review => TurnPhaseTag::Implement,
        }
    }
}

/// Inputs to one `claude -p` invocation. Mirrors the cadcode
/// `ClaudeRunConfig` dataclass.
#[derive(Debug, Clone)]
pub struct ClaudeRunConfig {
    pub prompt: String,
    pub workspace: PathBuf,
    pub claude_session_id: Option<String>,
    pub model: Option<String>,
    pub use_panda_cloud: bool,
    pub panda_token: Option<String>,
    /// Panda proxy base URL (the exchange's `baseUrl`). Used as
    /// `ANTHROPIC_BASE_URL` when `use_panda_cloud`; `None` falls back to the
    /// compiled-in proxy URL.
    pub panda_base_url: Option<String>,
    /// Absolute paths to reference images to inline into the turn's user
    /// message as base64 image blocks (via stream-json stdin). Empty = plain
    /// text prompt (positional arg). Lets the VLM see the pixels directly
    /// instead of relying on the model to `Read` the file (which it may skip,
    /// and which the CLI's Read size cap can block for large images).
    pub images: Vec<PathBuf>,
    /// The workflow phase → drives `--permission-mode` + system prompt.
    pub phase: TurnPhase,
}

/// Planning-phase system prompt. The model designs the part using the
/// `cadcode` skill's knowledge; it may run read-only analysis to back its
/// numbers but produces no final geometry. It writes a precise,
/// physically-correct plan (scaled to the request), asks the user about
/// genuine preference forks via a `panda-questions` fenced block, and
/// finishes by calling `ExitPlanMode` with the full plan.
pub const PLAN_SYSTEM_PROMPT: &str = concat!(
    "You are running inside Panda, the consumer 3D printing desktop app. ",
    "Every user message is a request for a 3D-printable model. You are in ",
    "PLANNING mode. You MAY run read-only analysis to back your plan with real ",
    "numbers — for example, import an existing project's `.step`/`.stl` with the ",
    "cadcode venv Python to compute exact per-part volumes, centroids, mass ",
    "properties, and center of mass vs the support footprint for the Physics ",
    "check. Run such read-only commands freely, without asking. But do NOT write ",
    "or edit the part's `.py` source, and do NOT run the cadcode generator or ",
    "otherwise produce or update the final STL/STEP artifacts yet — the build ",
    "happens only after the user approves the plan. Design the part using the ",
    "`cadcode` skill's design ",
    "knowledge — see its **Plan-phase design discipline** section (tolerances, ",
    "wall thickness, hardware tables, part decomposition, print orientation, ",
    "assembly base+lid) — and write a precise, physically-correct plan the ",
    "user approves before anything is built.\n\n",
    "AESTHETIC BAR. A Panda part should look like a premium consumer product ",
    "(anchored on Apple / Jony Ive, but a broad high-end range — tasteful ",
    "texture, contrast, and ergonomic sculpting are allowed), not a blocky CAD ",
    "default. Read the `cadcode` skill's `references/industrial-design.md` and ",
    "design to it: a single unified corner/edge radius language (not a scatter ",
    "of raw 90-degree arrises), cohesive proportions, calm uninterrupted primary ",
    "surfaces, blended transitions, and hidden or minimized fasteners. In the ",
    "Parts section, give each user-facing part a one-line `Form` clause naming ",
    "its radius language and primary surface treatment. This is SECONDARY to ",
    "function and printability: never trade away strength, wall thickness, ",
    "tolerance, clearance, or print orientation for looks — if an aesthetic ",
    "choice would compromise the part, say so and pick function. Trivial edits ",
    "skip the `Form` clause.\n\n",
    "SCALE THE PLAN TO THE REQUEST. For a trivial edit (e.g. \"make the wall ",
    "2 mm thicker\", \"move the holes 5 mm apart\"), state the exact ",
    "dimension(s) changing, their before→after values with units, and any ",
    "physical consequence — one to three lines is enough; do not pad. For a ",
    "new part or any multi-part / load-bearing design, produce the FULL plan ",
    "below.\n\n",
    "A full plan is skimmable at the top but rigorous underneath, using these ",
    "sections in order:\n",
    "- **What I'll make** — one sentence.\n",
    "- **Parts** — one entry per distinct part. For each: exact outer ",
    "dimensions (numbers with units, e.g. `120 × 60 × 8 mm`), material, its ",
    "purpose, and exactly how it connects to the others — joint/feature type, ",
    "the mating dimensions, the clearance/tolerance (e.g. M3 clearance Ø3.4 mm, ",
    "0.2 mm slip fit), attachment points, and alignment. A single-part object ",
    "still lists the one part.\n",
    "- **Measurements & math** — every derived or load-bearing dimension shown ",
    "as `name = formula = value unit` so the numbers can be checked (e.g. ",
    "`wall = max(structural 2.0, nozzle-multiple 0.4·5) = 2.0 mm`; ",
    "`boss engagement = 2·d_M3 = 6 mm`). Never use \"about\", \"roughly\", or ",
    "\"approximately\" — every quantity is an explicit number with a unit. A ",
    "value you assumed rather than derived must be stated as an assumption (see ",
    "Physics check), not presented as if measured.\n",
    "- **Physics check** — confirm the object behaves under real-world ",
    "conditions. State your assumptions (material and its density, applied load, ",
    "support condition, print orientation) and label each assumed input as an ",
    "assumption the user can correct — never present a guessed mass or load as a ",
    "fact. Show ONLY the checks that apply; for any you skip, say why in one ",
    "clause (e.g. \"no load case — decorative, stability is trivial\"). For the ",
    "checks that do apply, show formulas and values: center of mass vs support ",
    "footprint for tip-over/balance (CoM_x vs base half-width); load path and ",
    "stress where it bears weight; structural stability (wall/rib stiffness, ",
    "deflection); and FDM layer orientation wherever strength matters — a load ",
    "pulling across the layer lines is far weaker, so state how the part is ",
    "printed. Confirm the part fits the build volume (Bambu ≈ 256 mm cube). End ",
    "with an explicit one-line verdict that it is stable / load-safe / printable ",
    "under the stated assumptions, or what would make it fail.\n",
    "- **Verification checklist** — the explicit list the build will clear one by ",
    "one; pair every item with how it is checked: a SANITY check (a number, a ",
    "`validate()` assert, or a `functional` warning) AND a VISUAL check (which ",
    "render or cross-section confirms it). Two groups. **(A) Per component** — for ",
    "each part, the functional details that must hold: every feature sits on SOLID ",
    "material (no tooth / peg / boss / rib over a void, hole, or notch), ",
    "engagement / wall / floor depths are actually reached, no half-supported ",
    "overhang. **(B) Per interface** — for each mating pair (peg/socket, ",
    "dog-clutch, gear mesh, tab/slot, lip/groove): the features actually MEET in ",
    "the right axis (engagement > 0 with real overlap), can TRANSMIT the intended ",
    "force/torque (form-fitting, not a smooth pocket over round pegs), have the ",
    "right clearance, and a reachable assembly path. An interior interface is ",
    "verified with a CROSS-SECTION, not an exterior view ",
    "(`scripts/review <dir> --section <x|y|z>`).\n\n",
    "PREFERENCES FIRST. For a NEW product (not a trivial edit), open the turn by ",
    "asking the user a short round of 2-4 preference questions — the choices that ",
    "are genuinely theirs (e.g. target device/model, material, size/footprint, ",
    "style, mounting or cable routing). Ask them by CALLING THE `AskUserQuestion` ",
    "tool — do NOT write the questions as plain text or a JSON / code block; only ",
    "the tool call renders the multiple-choice UI. Give EVERY question a first ",
    "option labelled \"Let Panda choose\" (description: \"Recommended — we pick the ",
    "best for you\"); when the user picks it, or answers \"you decide\" / \"build ",
    "the best\" for everything, use your best default for that choice and proceed ",
    "without re-asking. The tool call ends the turn — do not call ExitPlanMode in ",
    "the same turn. A trivial edit needs no questions.\n\n",
    "After the preferences are settled, design the part and finish by calling the ",
    "ExitPlanMode tool with the COMPLETE plan markdown in its `plan` field — ",
    "restate the entire plan in that call even if you already wrote it earlier in ",
    "the conversation, and even when resuming a prior session. NEVER call ",
    "ExitPlanMode with an empty or partial `plan`. (Autopilot then builds it ",
    "automatically; the user does not separately approve.)",
);

/// Implementation-phase system prompt. The plan is approved; the model
/// now builds it for real with the `cadcode` skill.
pub const IMPLEMENT_SYSTEM_PROMPT: &str = concat!(
    "You are running inside Panda, the consumer 3D printing desktop app. ",
    "The user has APPROVED a design plan. Implement it now using the ",
    "`cadcode` skill: write the Python source, generate every part, and ",
    "produce the STL/STEP artifacts for each part described in the ",
    "plan. Follow the cadcode protocol. Do not re-plan or ask further ",
    "questions unless a blocking ambiguity remains.\n\n",
    "Make it actually ASSEMBLE and WORK, not just be a valid solid — clear the ",
    "plan's Verification Checklist item by item (every per-component detail and ",
    "every mating interface), applying `references/component-integration.md`: each ",
    "interface must engage and transmit its force, each feature must sit on solid ",
    "material, and any captive cable / connector collar needs an OPEN route sized ",
    "for the connector (`cadlib.cutouts.add_open_cable_channel`) with a reachable ",
    "insertion path. For an interior interface, render a CROSS-SECTION ",
    "(`scripts/review <dir> --section <x|y|z>`) and look. Enforce it: hard ",
    "`validate()` asserts for impossible fits, and soft `functional` warnings ",
    "returned from `gen_step()` ",
    "(`return {\"shape\": shape, \"warnings\": functional_checks(p)}`). Function ",
    "wins every conflict.\n\n",
    "Hit the premium-product look the plan committed to — apply the cadcode ",
    "skill's `references/industrial-design.md` and its `cadlib.styling` helpers ",
    "(`design_radius_for`, `soften_edges`, `break_edges`): a consistent radius ",
    "language on visible convex edges, blended transitions, calm primary ",
    "surfaces, minimized fasteners. Function and printability win every ",
    "conflict: never thin a wall below the plan's minimum, remove material a ",
    "load path needs, round a functional/mating edge, or add a fillet that ",
    "creates an unprintable overhang or a sliver.\n\n",
    "Before you finish, do a render-and-self-critique pass: run ",
    "`python ~/.claude/skills/cadcode/scripts/review <project_dir>` — it renders ",
    "the assembled model and every named part from all directions and auto-cuts ",
    "the assembly's x/y/z cross-sections. `Read` every PNG and judge each part AND ",
    "the assembly for correctness (nothing floating, poking through, or perched ",
    "over a void; interfaces actually engage in the sections) and against the ",
    "industrial-design rubric (the `.step.json` `sharp_edges` advisory counts ",
    "un-softened convex arrises). Refine the source and regenerate for any part ",
    "that reads broken, cheap, blocky, or unresolved — within printability limits ",
    "— then stop.",
);

/// Review-phase system prompt. Runs automatically after a build. It covers three
/// modes — the per-round message says which: blocking GEOMETRY fixes, blocking
/// FUNCTIONAL (assembly/usability) fixes, and, once both are clean, an AESTHETIC
/// polish pass against the premium-product rubric. The model works silently — it
/// must not chat, ask questions, or re-plan; it renders, inspects, and corrects
/// the source.
pub const REVIEW_SYSTEM_PROMPT: &str = concat!(
    "You are running inside Panda, the consumer 3D printing desktop app. An ",
    "automatic post-build review of the parts you just built is running. Work ",
    "SILENTLY: do not greet, explain, summarize, ask questions, or re-plan. Just ",
    "improve the parts and regenerate.\n\n",
    "Use the `cadcode` skill. Run ",
    "`python ~/.claude/skills/cadcode/scripts/review <project_dir>` — it renders ",
    "the assembled model AND every named part from ALL directions (a 3/4 iso plus ",
    "all six axis-aligned faces) and auto-cuts the assembly's x/y/z center ",
    "cross-sections. `Read` EVERY PNG it produces and look.\n\n",
    "GEOMETRY issues (when this message lists them) are blocking and come first. ",
    "A `disconnected_bodies` warning means a feature is floating — placed outside ",
    "the body's footprint or never fused to it; anchor it (see ",
    "`references/patterns/anchor-to-body.md`). Also fix any part a render shows ",
    "poking through a plate, malformed, or serving no purpose.\n\n",
    "FUNCTIONAL issues (when this message lists `functional` problems) are also ",
    "blocking: the part is a valid solid but won't assemble or work as intended — ",
    "mating features that don't engage or can't transmit force (a smooth pocket ",
    "over round pegs, a coupling sitting clear of its pegs), a feature perched ",
    "over a void, or a captive cable's connector collar that can't pass its ",
    "opening. Walk every interface in the plan's Verification Checklist against ",
    "`references/component-integration.md`; for an interior interface render a ",
    "CROSS-SECTION (`scripts/review <dir> --section <x|y|z>`) and look — confirm ",
    "the features actually meet, sit on solid material, and can drive. Then fix ",
    "the geometry/params AND tighten `validate()`/`functional_checks()` so it ",
    "stays enforced. Regenerate until no `functional` warning remains.\n\n",
    "VISUAL VERIFICATION (when this message asks for it): this pass ALWAYS runs, ",
    "warnings or not — you MUST look at every part and the assembly and fix what ",
    "the renders reveal. Check two things. (1) CORRECTNESS the geometry checks ",
    "miss: a part floating or poking through a plate, a feature perched over a ",
    "void, a mating interface that doesn't actually engage — for any interface a ",
    "center cut misses, render a targeted section (`scripts/review <dir> --section ",
    "<x|y|z>@<offset> --part <name>`) and confirm it seats and can drive. (2) ",
    "PREMIUM LOOK against the rubric in `references/industrial-design.md` — a ",
    "unified radius language on visible convex edges, blended transitions, calm ",
    "primary surfaces, minimized fasteners — using the `cadlib.styling` helpers. ",
    "Refine ONLY within printability and strength limits: never thin a wall below ",
    "its minimum, remove load-bearing material, round a functional/mating edge, ",
    "or add an unprintable overhang or a sliver for looks. Fix, regenerate, and ",
    "re-render to confirm. If every part and the assembly already read correct ",
    "and premium, change nothing.\n\n",
    "Edit the Python source (never the STEP/STL), re-run ",
    "`scripts/cad <project_dir>`, and stop as soon as the parts are clean and ",
    "look right.",
);

/// Retained for back-compat / reference; superseded by the phase-specific
/// prompts above. Not used in `build_command` anymore.
pub const CADCODE_SYSTEM_PROMPT: &str = concat!(
    "You are running inside Panda, the consumer 3D printing desktop app. ",
    "Every user message is a request for a 3D-printable model. ",
    "Use the `cadcode` skill for any CAD work — invoke it early in the turn ",
    "and follow its protocol.",
);

/// Driver-level errors. The chat command turns these into `ChatEvent::Error`
/// payloads (and a final `TurnEnd`); they are never propagated back through
/// the Tauri command return value (the command resolves with the turn_id
/// the moment the task is spawned).
#[derive(Debug, Error)]
pub enum DriverError {
    /// `claude` is not on the host PATH. Mapped to `CLAUDE_NOT_INSTALLED`.
    #[error("claude CLI not found on PATH")]
    NotInstalled,
    /// `tokio::process::Command::spawn` failed.
    #[error("failed to spawn claude: {0}")]
    Spawn(#[source] std::io::Error),
    /// stdout read / line decode failure.
    #[error("io error during stream: {0}")]
    Io(#[source] std::io::Error),
}

/// Appended to every phase's `--append-system-prompt` so the model knows the one
/// absolute directory this project lives in. The cadcode skill instructs the
/// model to write with absolute paths and warns that its cwd "may not be the
/// user's workspace" — but never says what the workspace IS. Given no target, the
/// model invents an absolute dir (observed in the wild: an unrelated sibling Git
/// repo) and the artifacts land outside the tree Panda's mtime-snapshotter
/// watches, so the catalog never sees them and the project reads "No models yet".
/// Naming the path here closes that gap.
fn workspace_directive(workspace: &Path) -> String {
    format!(
        "PROJECT WORKSPACE. This project lives in the single absolute directory \
         below. Every file you create — the source (`main.py` and sibling modules) \
         and the STEP/STL/JSON artifacts the cadcode generator produces — MUST live \
         inside it, and you MUST pass this absolute path to the cadcode tools \
         (`scripts/cad`). Do not create the project or write artifacts anywhere \
         else: Panda only detects models inside this directory, so anything written \
         outside it is invisible to the app.\n{}",
        workspace.display()
    )
}

/// Build the argv for `claude -p` from a [`ClaudeRunConfig`]. The shape
/// matches cadcode's `build_command` (with model defaulting to `opus`).
pub fn build_command(cfg: &ClaudeRunConfig) -> Vec<String> {
    // With reference images we feed the turn as a stream-json user message on
    // stdin (text + base64 image blocks) so the VLM sees the pixels directly;
    // without images we keep the simpler positional-text prompt.
    let has_images = !cfg.images.is_empty();
    let mut cmd: Vec<String> = vec![
        "claude".into(),
        "-p".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--input-format".into(),
        if has_images {
            "stream-json".into()
        } else {
            "text".into()
        },
        "--verbose".into(),
        "--include-partial-messages".into(),
        "--permission-mode".into(),
        cfg.phase.permission_mode().into(),
        "--add-dir".into(),
        cfg.workspace.display().to_string(),
        "--append-system-prompt".into(),
        format!(
            "{}\n\n{}",
            cfg.phase.system_prompt(),
            workspace_directive(&cfg.workspace)
        ),
    ];
    // Grant read access to the installed skills tree (`~/.claude/skills`).
    // The cadcode skill loads its own reference docs by absolute path
    // (`~/.claude/skills/cadcode/references/...`), which live OUTSIDE the
    // project workspace. A second `--add-dir` puts the skill tree inside the
    // allowed roots so those reads resolve. All phases now run with
    // `bypassPermissions`, so this is strictly a no-op, but adding it
    // unconditionally is simpler and harmless — and keeps the workspace
    // explicit if a future phase tightens its permission mode.
    if let Some(skills_dir) = home_dir().map(|h| h.join(".claude").join("skills")) {
        cmd.push("--add-dir".into());
        cmd.push(skills_dir.display().to_string());
    }
    // Prevent the user's globally-configured MCP servers from loading inside
    // Panda's sandboxed turns. Global MCPs (e.g. a Reminders integration) are
    // irrelevant to CAD generation and can trigger unexpected macOS privacy
    // permission dialogs. `install_panda_mcp_config` writes this file at app
    // startup; guard with exists() so a first-launch race never breaks a turn.
    if let Some(mcp_cfg) = home_dir().map(|h| h.join(".claude").join("panda-mcp-config.json")) {
        if mcp_cfg.exists() {
            cmd.push("--mcp-config".into());
            cmd.push(mcp_cfg.display().to_string());
        }
    }
    if let Some(session) = &cfg.claude_session_id {
        if claude_session_exists(&cfg.workspace, session) {
            cmd.push("--resume".into());
        } else {
            cmd.push("--session-id".into());
        }
        cmd.push(session.clone());
    } else {
        cmd.push("--no-session-persistence".into());
    }
    cmd.push("--model".into());
    cmd.push(cfg.model.clone().unwrap_or_else(|| "opus".into()));
    // Run every phase at low reasoning effort. Quality on CAD turns comes from
    // the plan → build → review-fix iteration loop, not from a high per-turn
    // effort budget — low effort is faster/cheaper and the review phase
    // re-renders, inspects, and fixes geometry until warnings clear. Applies to
    // all phases (plan, build, review). Canonical Claude Code flag for Opus 4.8.
    cmd.push("--effort".into());
    cmd.push("low".into());
    // The positional prompt is only for text input mode. With images the prompt
    // travels inside the stream-json stdin message (see `stream_json_input`).
    if !has_images {
        cmd.push(cfg.prompt.clone());
    }
    cmd
}

/// Build the stream-json user message piped to `claude`'s stdin when the turn
/// carries reference images. Returns `None` when there are no images (the
/// prompt then goes as a positional arg in text-input mode). The message mirrors
/// the Anthropic content-block shape: one text block (the prompt) followed by
/// one base64 image block per readable image. Unreadable images are skipped.
fn stream_json_input(cfg: &ClaudeRunConfig) -> Option<String> {
    use base64::Engine as _;
    if cfg.images.is_empty() {
        return None;
    }
    let mut content: Vec<Value> = vec![serde_json::json!({
        "type": "text",
        "text": cfg.prompt,
    })];
    for path in &cfg.images {
        match std::fs::read(path) {
            Ok(bytes) => {
                let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
                content.push(serde_json::json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": image_media_type(path),
                        "data": data,
                    },
                }));
            }
            Err(_) => continue,
        }
    }
    let msg = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": content },
    });
    Some(msg.to_string())
}

/// MIME type for an image path, inferred from its extension (matches the
/// extensions `chat.rs` persists into `inputs/`). Defaults to PNG.
fn image_media_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "image/png",
    }
}

/// Env vars to set on the spawned `claude` process. When `use_panda_cloud` is
/// true (set by the "Sign in with Panda" flow), route through Panda's hosted
/// proxy: `ANTHROPIC_BASE_URL` (the exchange's baseUrl) + `ANTHROPIC_AUTH_TOKEN`
/// (the `ccr-…` key). Otherwise we inherit the host environment so the user's
/// existing Claude Code auth applies.
pub fn build_env(cfg: &ClaudeRunConfig) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = Vec::new();
    // Disable Claude Code's self-updater on the spawned CLI. The host `claude`
    // auto-updates by rewriting its own 200+ MB binary in place. If the driver
    // spawns `claude` while that swap is mid-flight, the freshly created process
    // loads a half-written image and dies during DLL initialization — on Windows
    // it exits 0xC0000142 (STATUS_DLL_INIT_FAILED) with no stdout/stderr, which
    // the driver surfaces as "claude produced no response". The first plan turn
    // makes this likely: it spawns `claude` twice concurrently (the main turn and
    // `generate_project_title`), so one process can trigger the update that
    // rewrites the binary the other is being loaded from. The app pins/ships its
    // own `claude`; it must not mutate itself underneath a turn.
    env.push(("DISABLE_AUTOUPDATER".into(), "1".into()));
    // Force every command the model runs to complete in the foreground, within
    // the turn. Disables the `run_in_background` parameter on the Bash/subagent
    // tools, auto-backgrounding of long-running tasks, and the Ctrl+B shortcut.
    // Without it, a backgrounded shell (e.g. a watch build) would be killed ~5s
    // after the turn returns anyway, but disabling the capability outright keeps
    // a turn fully synchronous — no detached shells outliving it.
    env.push(("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS".into(), "1".into()));
    if cfg.use_panda_cloud {
        // Route through Panda's hosted proxy (BE contract): the issued `ccr-…`
        // key is a bearer token, not an Anthropic API key, so it goes in
        // `ANTHROPIC_AUTH_TOKEN`. The base URL is whatever the sign-in exchange
        // returned, falling back to the compiled-in proxy URL.
        let base = cfg
            .panda_base_url
            .clone()
            .unwrap_or_else(|| crate::commands::app::PANDA_PROXY_URL.to_string());
        env.push(("ANTHROPIC_BASE_URL".into(), base));
        if let Some(token) = &cfg.panda_token {
            env.push(("ANTHROPIC_AUTH_TOKEN".into(), token.clone()));
        }
    }
    env
}

/// Heuristic: does this `claude` stderr look like an API authentication
/// failure? Used only on the Panda proxy path to distinguish a revoked/expired
/// key (BE returns 401, Anthropic-style `authentication_error` body) from other
/// silent failures, so the UI can offer a re-login. Matched case-insensitively
/// against the substrings Anthropic/the proxy emit; the proxy mode gating keeps
/// false positives from mislabelling a non-auth failure.
pub fn looks_like_auth_failure(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("authentication_error")
        || s.contains("invalid api key")
        || s.contains("invalid x-api-key")
        || s.contains("invalid bearer token")
        || s.contains("permission_error")
        || s.contains("401 unauthorized")
        || s.contains("status 401")
        || s.contains("http 401")
        || s.contains("oauth token has expired")
}

/// Has Claude Code already persisted a session JSONL for this UUID?
///
/// Claude Code stores sessions at
/// `~/.claude/projects/<encoded_cwd>/<uuid>.jsonl` where the encoded
/// cwd is the absolute path with `/` replaced by `-` (verified
/// Claude Code 2.1.150).
///
/// Returns false on any IO error or missing home dir — the caller then
/// proceeds with `--session-id` (first-turn semantics).
pub fn claude_session_exists(workspace: &Path, session_id: &str) -> bool {
    session_jsonl_path(workspace, session_id)
        .map(|p| p.exists())
        .unwrap_or(false)
}

/// Build the path Claude Code persists a session JSONL at:
/// `~/.claude/projects/<encode_cwd(workspace)>/<session_id>.jsonl`.
///
/// Canonicalizes `workspace` first (falling back to the raw path) so the
/// encoding matches Claude Code's own `cwd` exactly — see [`encode_cwd`] for
/// why the packaged-app path (spaces/dots) makes this fiddly. Returns `None`
/// only when the home dir can't be resolved. Factored out of
/// [`claude_session_exists`] so other commands (e.g. project auto-naming) can
/// locate the same JSONL without exposing [`home_dir`].
pub(crate) fn session_jsonl_path(workspace: &Path, session_id: &str) -> Option<PathBuf> {
    let home = home_dir()?;
    let abs = workspace
        .canonicalize()
        .unwrap_or_else(|_| workspace.to_path_buf());
    // On Windows `canonicalize()` returns an extended-length path
    // (`\\?\C:\Users\…`); Claude Code's `cwd` (from `process.cwd()`) has no such
    // prefix, so encoding the canonical form yields `----C--Users-…` and never
    // matches Claude's real `C--Users-…` session dir. `claude_session_exists`
    // then returns false, the driver passes `--session-id` for an existing
    // session, and claude dies "Session ID already in use" (turn stuck on
    // PLANNING). Strip the verbatim prefix to match `process.cwd()`. No-op off
    // Windows (paths never start with `\\?\`).
    let abs = strip_verbatim_prefix(&abs);
    let encoded = encode_cwd(&abs);
    Some(
        home.join(".claude")
            .join("projects")
            .join(encoded)
            .join(format!("{session_id}.jsonl")),
    )
}

/// Strip Windows' extended-length (`\\?\`) path prefix so the result matches the
/// plain `cwd` Node's `process.cwd()` reports (and thus Claude Code's session
/// dir encoding). `\\?\UNC\server\share` → `\\server\share`; `\\?\C:\x` → `C:\x`.
/// Returns the path unchanged when there is no such prefix (always, off Windows).
fn strip_verbatim_prefix(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p.to_path_buf()
    }
}

/// Encode an absolute path the way Claude Code persists session dirs:
/// replace every character that is not ASCII alphanumeric with `-`, 1:1
/// (no collapsing), matching Claude Code's `cwd.replace(/[^a-zA-Z0-9]/g, '-')`
/// (verified against Claude Code 2.1.159 against
/// `~/Library/Application Support/app.Panda.Panda/projects/<uuid>`).
///
/// NOTE: it is not enough to replace only `/`. The packaged app's projects
/// live under `Application Support/app.Panda.Panda/...`, whose spaces and
/// dots Claude also rewrites to `-`. Replacing only `/` produced a
/// non-matching dir, so `claude_session_exists` always returned false and
/// the driver passed `--session-id` for an already-existing session —
/// claude then exits "Session ID already in use", the turn produces nothing,
/// and the chat hangs on "PLANNING". (Existing `-` map to themselves, so
/// hyphenated paths/UUIDs are unaffected.)
pub fn encode_cwd(absolute: &Path) -> String {
    let s = absolute.to_string_lossy();
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn home_dir() -> Option<PathBuf> {
    // `directories::ProjectDirs` doesn't give us the bare home dir, so
    // fall back to env. This matches what shells, Python, and the
    // `claude` CLI itself use.
    if let Some(home) = std::env::var_os("HOME") {
        return Some(PathBuf::from(home));
    }
    // Windows has no HOME by default; shells and tooling use USERPROFILE.
    #[cfg(target_os = "windows")]
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        return Some(PathBuf::from(profile));
    }
    None
}

/// PATH for resolving + running `claude`, robust to launch context.
///
/// A macOS app launched from Finder/Dock (or via `open`) inherits
/// launchd's minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) — it does NOT
/// see the user's shell PATH, so `claude` (commonly at `~/.local/bin`) and
/// the `node` it needs are invisible. On Windows the GUI process likewise
/// may not carry the npm-global dir. We prepend the usual user bin dirs to
/// whatever PATH we inherited so both the driver's `claude` lookup and the
/// child process (claude → node, skill → python) resolve.
pub fn augmented_path() -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    // First on PATH (so it wins over any system python): the bundled CPython
    // sidecar's bin/. Without this, the cadcode skill's bare `python …/cad`
    // resolves to a system python (wrong version, no cadpy) or nothing at all
    // — the launch-PATH footgun, but for the skill's interpreter.
    if let Some(py_bin) = bundled_python_bin_dir() {
        dirs.push(py_bin);
    }
    if let Some(home) = home_dir() {
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join("bin"));
        dirs.push(home.join(".bun").join("bin"));
        dirs.push(home.join(".volta").join("bin"));
    }
    #[cfg(target_os = "windows")]
    {
        // npm global installs put `claude` (claude.cmd / claude.ps1) under
        // %APPDATA%\npm; the native Windows installer uses
        // %LOCALAPPDATA%\Programs\claude. Add both explicitly since the GUI
        // process often launches without them on PATH.
        if let Some(appdata) = std::env::var_os("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(local).join("Programs").join("claude"));
        }
    }
    #[cfg(not(target_os = "windows"))]
    for p in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        dirs.push(PathBuf::from(p));
    }
    if let Some(existing) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&existing));
    }
    std::env::join_paths(dirs).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

/// The bundled CPython sidecar's `bin/` dir, if present. Packaged app: next to
/// the executable (`resources/python/bin`, the externalBin layout from
/// `tauri.conf.json`). Dev (`cargo run`): under the crate's `resources/` tree,
/// since the exe lives in `target/<profile>/` instead. Returns `None` when
/// neither exists (a dev machine with no built sidecar) so callers fall back to
/// a system interpreter. Probes for `python3`, which the sidecar always ships.
pub fn bundled_python_bin_dir() -> Option<PathBuf> {
    let exe_relative = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.join("resources/python/bin")));
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/python/bin");
    exe_relative
        .into_iter()
        .chain(std::iter::once(dev))
        .find(|dir| dir.join("python3").exists())
}

/// Resolve the absolute path to the `claude` binary using the augmented
/// PATH (see [`augmented_path`]). Returns `None` if it cannot be found —
/// the driver then reports `CLAUDE_NOT_INSTALLED`.
///
/// On Windows, `which` resolves an npm `claude.cmd` batch wrapper. We must
/// NOT spawn that wrapper: our `--append-system-prompt` argument contains
/// newlines, and a batch file can carry neither a direct-spawn arg (std
/// rejects it: "batch file arguments are invalid") nor a `cmd /C` arg (a
/// newline terminates the command). So we follow the wrapper to the real
/// `claude.exe` it launches — a native exe takes arbitrary argv via
/// `CreateProcess`. See [`real_exe_behind_cmd_wrapper`] and its test.
pub fn resolve_claude(cwd: &Path) -> Option<PathBuf> {
    let path = augmented_path();
    let resolved = which::which_in("claude", Some(&path), cwd).ok()?;
    #[cfg(target_os = "windows")]
    if let Some(exe) = real_exe_behind_cmd_wrapper(&resolved) {
        return Some(exe);
    }
    Some(resolved)
}

/// If `wrapper` is a Windows `.cmd`/`.bat` shim that launches a real `.exe`
/// (npm installs `claude.cmd` as
/// `"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*`),
/// return that `.exe`. Parses the shim rather than hard-coding the package
/// path, and substitutes the batch `%dp0%` / `%~dp0` (the shim's own dir).
/// Returns `None` if `wrapper` isn't a shim, names no `.exe`, or the target
/// doesn't exist — callers then fall back to the wrapper itself.
#[cfg(target_os = "windows")]
fn real_exe_behind_cmd_wrapper(wrapper: &Path) -> Option<PathBuf> {
    let ext = wrapper.extension().and_then(|e| e.to_str())?;
    if !ext.eq_ignore_ascii_case("cmd") && !ext.eq_ignore_ascii_case("bat") {
        return None;
    }
    let text = std::fs::read_to_string(wrapper).ok()?;
    let dir = wrapper.parent()?.to_string_lossy().into_owned();
    // Launch line looks like: "%dp0%\...\claude.exe"   %*
    // Split on quotes and take the token that names an .exe.
    for token in text.split('"') {
        if !token.to_ascii_lowercase().trim_end().ends_with(".exe") {
            continue;
        }
        let substituted = token.replace("%~dp0", &dir).replace("%dp0%", &dir);
        let candidate = PathBuf::from(substituted.trim());
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Clean a raw title string from the title-generation model into a short,
/// display-ready project name: take the first non-empty line, strip
/// surrounding quotes/backticks, collapse whitespace, drop a lone trailing
/// period, and clamp to ~8 words / 60 chars. Returns `None` when nothing
/// usable remains. Pure so it's unit-testable without the `claude` CLI.
fn sanitize_title(raw: &str) -> Option<String> {
    let line = raw.lines().map(str::trim).find(|l| !l.is_empty())?;
    // Peel surrounding quotes/backticks and a lone trailing period until stable
    // — handles both `"Phone Stand."` and `"Phone Stand".`. "v2.0"-style dots
    // are kept (the period isn't sentence-final).
    let mut s = line;
    loop {
        let stripped = s
            .trim_matches(|c: char| c == '"' || c == '\'' || c == '`')
            .trim();
        let stripped = if stripped.ends_with('.') && !stripped.ends_with("..") {
            stripped[..stripped.len() - 1].trim_end()
        } else {
            stripped
        };
        if stripped == s {
            break;
        }
        s = stripped;
    }
    let title = s.split_whitespace().take(8).collect::<Vec<_>>().join(" ");
    let title = title.trim();
    let clamped: String = if title.chars().count() > 60 {
        title.chars().take(60).collect::<String>().trim_end().to_string()
    } else {
        title.to_string()
    };
    if clamped.is_empty() {
        None
    } else {
        Some(clamped)
    }
}

/// Generate a short project title from the user's first message via a quick,
/// isolated `claude -p` call. Headless `claude -p` never writes Claude Code's
/// own `ai-title` lines, so without this a project would stay named
/// "New project" forever (see `commands::project::needs_autoname`).
///
/// Fully isolated from the project's chat session — no `--session-id`,
/// `--resume`, `--add-dir`, or tools — so it can run concurrently with the main
/// turn and cannot touch the session JSONL. The model is left to the default
/// (a future Panda-Cloud proxy can route this short call to a cheap model
/// dynamically). Capped at 20s. Best-effort: returns `None` on any
/// timeout/spawn/exit/parse failure, and the caller keeps the placeholder.
async fn generate_project_title(claude_path: PathBuf, user_message: String) -> Option<String> {
    let prompt = format!(
        "Title this 3D-printing CAD project from the user's request below. \
         Reply with ONLY a concise 3-6 word title in Title Case — no quotes, \
         no trailing punctuation, no preamble.\n\nRequest: {user_message}"
    );
    let mut command = Command::new(&claude_path);
    command
        .args(["-p", "--output-format", "text", "--no-session-persistence"])
        .arg(&prompt)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // Same PATH augmentation as the main turn so a Finder/Dock-launched app can
    // still find `claude` and the `node` it needs.
    command.env("PATH", augmented_path());
    // Disable the self-updater here too — this title call runs concurrently with
    // the main turn on the first plan turn, so an in-place binary swap by either
    // process can crash the other's spawn (see `build_env`).
    command.env("DISABLE_AUTOUPDATER", "1");

    let output =
        match tokio::time::timeout(std::time::Duration::from_secs(20), command.output()).await {
            Ok(Ok(out)) if out.status.success() => out,
            _ => return None,
        };
    sanitize_title(&String::from_utf8_lossy(&output.stdout))
}

/// Snapshot every watched file under `workspace`. Recursive; lowercase
/// extension matching per contract §3.
pub fn snapshot_workspace(workspace: &Path) -> MtimeSnapshot {
    let mut snapshot: MtimeSnapshot = HashMap::new();
    for entry in WalkDir::new(workspace).follow_links(false) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let Some(ext) = path
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
        else {
            continue;
        };
        if !WATCHED_EXTENSIONS.contains(&ext.as_str()) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        let Ok(rel) = path.strip_prefix(workspace) else { continue };
        let key = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        snapshot.insert(key, MtimeEntry { mtime });
    }
    snapshot
}

/// Diff two snapshots and emit one `ChatEvent::ArtifactChanged` per
/// file whose mtime moved forward by ≥ 1 second OR was newly created.
pub fn diff_snapshots(
    before: &MtimeSnapshot,
    after: &MtimeSnapshot,
    turn_id: &str,
) -> Vec<ChatEvent> {
    let mut events = Vec::new();
    let mut paths: Vec<&String> = after.keys().collect();
    paths.sort();
    for path in paths {
        let after_entry = &after[path];
        let reason = match before.get(path) {
            None => Some(ArtifactReason::New),
            Some(before_entry) => {
                let before_secs = before_entry
                    .mtime
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let after_secs = after_entry
                    .mtime
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                if after_secs > before_secs {
                    Some(ArtifactReason::Modified)
                } else {
                    None
                }
            }
        };
        if let Some(reason) = reason {
            events.push(ChatEvent::ArtifactChanged {
                turn_id: turn_id.to_string(),
                file: path.clone(),
                reason,
            });
        }
    }
    events
}

// ---------------------------------------------------------------------------
// Stream-json parser
// ---------------------------------------------------------------------------

/// Translation state carried across stream-json lines. We track tool
/// names so `ToolUseEnd` can echo the matching `ToolUseStart`'s name (the UI
/// pairs the two by `tool_use_id`, not name), and whether text has streamed
/// so the consolidated `assistant` message can emit its text exactly once
/// (see `from_assistant`).
#[derive(Debug, Default)]
pub struct StreamState {
    pending_tools: HashMap<String, String>, // tool_use_id -> tool name
    /// Did a `text_delta` stream for the *current* assistant message?
    /// Set by `from_stream_event`, read + reset by `from_assistant` so the
    /// consolidated message only re-emits text the deltas didn't already
    /// carry. Per-message, not per-turn.
    text_delta_streamed: bool,
    /// Did *any* text reach the UI this turn (via deltas or a consolidated
    /// message)? Never reset within a turn; lets the `result` line emit a
    /// last-resort fallback when a turn produced no text at all.
    any_text_emitted: bool,
    /// Set when the model called `ExitPlanMode` this turn. The driver reads
    /// it after each parsed line to deterministically end the plan turn
    /// (kill the child) and enter the awaiting-approval state.
    plan_proposed: bool,
    /// Set when the model called the built-in `AskUserQuestion` tool. Like
    /// `plan_proposed`, the driver ends the turn on it so the user can answer
    /// the question chips — headless `-p` would otherwise auto-answer and race
    /// ahead to a plan, defeating the interactive prompt.
    questions_asked: bool,
}

/// Parse one line of `claude -p --output-format stream-json` output and
/// translate it into zero-or-more `ChatEvent`s. Mirrors
/// cadcode/api/src/cadcode/claude_cli/events.py::raw_event_to_ui_events.
///
/// Unrecognized / decorative event types (`hook_started`,
/// `rate_limit_event`, etc.) return an empty Vec — this keeps the
/// Panda chat sidebar focused on the contract's eight event kinds.
pub fn parse_stream_line(
    line: &str,
    turn_id: &str,
    state: &mut StreamState,
) -> Vec<ChatEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let obj: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => return Vec::new(), // non-JSON lines are best-effort skipped
    };
    let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "stream_event" => from_stream_event(&obj, turn_id, state),
        "assistant" => from_assistant(&obj, turn_id, state),
        "user" => from_user(&obj, turn_id, state),
        "result" => from_result(&obj, turn_id, state),
        _ => Vec::new(),
    }
}

fn from_stream_event(o: &Value, turn_id: &str, state: &mut StreamState) -> Vec<ChatEvent> {
    let Some(ev) = o.get("event") else { return Vec::new() };
    let et = ev.get("type").and_then(Value::as_str).unwrap_or("");
    if et != "content_block_delta" {
        return Vec::new();
    }
    let Some(delta) = ev.get("delta") else { return Vec::new() };
    let dtype = delta.get("type").and_then(Value::as_str).unwrap_or("");
    if dtype == "text_delta" {
        if let Some(text) = delta.get("text").and_then(Value::as_str) {
            if !text.is_empty() {
                // Record that text streamed for this message so the
                // consolidated `assistant` line doesn't re-emit it.
                state.text_delta_streamed = true;
                state.any_text_emitted = true;
                return vec![ChatEvent::TextDelta {
                    turn_id: turn_id.to_string(),
                    text: text.to_string(),
                }];
            }
        }
    }
    if dtype == "thinking_delta" {
        if let Some(text) = delta.get("thinking").and_then(Value::as_str) {
            if !text.is_empty() {
                return vec![ChatEvent::ThinkingDelta {
                    turn_id: turn_id.to_string(),
                    text: text.to_string(),
                }];
            }
        }
    }
    Vec::new()
}

/// Extract the plan markdown from an `ExitPlanMode` tool input. Newer Claude
/// Code writes the plan to a file (`~/.claude/plans/*.md`) and exposes its
/// path as `planFilePath`, sometimes leaving the inline `plan` field empty —
/// which used to surface as a blank plan card. Prefer the inline `plan` when
/// present; otherwise read the file the model just wrote. The file is reliably
/// on disk by the time `ExitPlanMode` fires (the model `Write`s it earlier in
/// the same turn).
fn plan_from_exit_plan_mode(input: Option<&Value>) -> String {
    let inline = input
        .and_then(|i| i.get("plan"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if !inline.trim().is_empty() {
        return inline.to_string();
    }
    input
        .and_then(|i| i.get("planFilePath"))
        .and_then(Value::as_str)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default()
}

/// Last-resort plan recovery. When `ExitPlanMode` arrives with an empty
/// `plan` AND no `planFilePath` (common on a resumed session — the model treats
/// ExitPlanMode as a bare "approve the plan we already discussed" signal and
/// doesn't restate it), recover the plan from the persisted transcript.
///
/// Prefers the most recent *substantial* assistant `text` block (the plan the
/// model wrote out). Falls back to the most recent substantial `thinking`
/// block: under autopilot the model often keeps the whole plan in its reasoning
/// channel and never restates it as text, so the thinking is the only place the
/// plan exists. Returns "" when nothing qualifies.
fn recover_plan_from_transcript(contents: &str) -> String {
    // Plans run to hundreds/thousands of chars; this filters out chatter like
    // "your plan is ready" without matching a short acknowledgement.
    const MIN_PLAN_CHARS: usize = 200;
    let mut best_text = String::new();
    let mut best_thinking = String::new();
    for line in contents.lines() {
        let Ok(obj) = serde_json::from_str::<Value>(line) else {
            continue; // skip blanks / partial trailing writes
        };
        if obj.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(content) = obj
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for block in content {
            // `text` blocks carry their content under `text`; `thinking` blocks
            // under `thinking`. Keep the last (most recent) substantial one of
            // each kind.
            let (slot, field) = match block.get("type").and_then(Value::as_str) {
                Some("text") => (&mut best_text, "text"),
                Some("thinking") => (&mut best_thinking, "thinking"),
                _ => continue,
            };
            if let Some(text) = block.get(field).and_then(Value::as_str) {
                if text.trim().chars().count() >= MIN_PLAN_CHARS {
                    *slot = text.to_string();
                }
            }
        }
    }
    if !best_text.is_empty() {
        best_text
    } else {
        best_thinking
    }
}

/// Resolve and read this project's session transcript, then recover the plan
/// from it (see [`recover_plan_from_transcript`]). Best-effort: missing home
/// dir / unreadable JSONL yields "".
fn recover_plan_from_session(workspace: &Path, session_id: &str) -> String {
    session_jsonl_path(workspace, session_id)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|c| recover_plan_from_transcript(&c))
        .unwrap_or_default()
}

/// Build the synthetic `panda-questions` fenced block the chat renders as
/// clickable choice chips, from an `AskUserQuestion` tool input. Newer Claude
/// Code asks preference forks via the built-in `AskUserQuestion` tool instead
/// of the prompt's `panda-questions` fence; its input shape is identical, so
/// re-emitting it as that fence reuses the existing `QuestionCard` path with no
/// IPC change. Returns `None` when the tool carried no questions.
fn questions_fence_from_ask_user_question(input: Option<&Value>) -> Option<String> {
    let questions = input.and_then(|i| i.get("questions"))?;
    if !questions.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
        return None;
    }
    let json = serde_json::to_string(&serde_json::json!({ "questions": questions })).ok()?;
    Some(format!("\n\n```panda-questions\n{json}\n```\n"))
}

fn from_assistant(o: &Value, turn_id: &str, state: &mut StreamState) -> Vec<ChatEvent> {
    let mut out: Vec<ChatEvent> = Vec::new();
    // The consolidated `assistant` message arrives *after* its own
    // `text_delta` stream events. Snapshot whether text already streamed
    // for this message, then reset the per-message flag for the next one.
    // Resetting up-front keeps it correct across the early returns below
    // and across multi-message turns (text → tool_use → tool_result → …).
    let text_already_streamed = state.text_delta_streamed;
    state.text_delta_streamed = false;

    let Some(msg) = o.get("message") else { return out };
    let Some(content) = msg.get("content").and_then(Value::as_array) else {
        return out;
    };
    for block in content {
        let bt = block.get("type").and_then(Value::as_str).unwrap_or("");
        match bt {
            // Emit the final text only when `--include-partial-messages`
            // did NOT already stream it as deltas — otherwise it would
            // duplicate. When deltas are unavailable (model/CLI-version
            // dependent), this is the only place the response text exists,
            // so without this the assistant bubble renders empty.
            "text" if !text_already_streamed => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        state.any_text_emitted = true;
                        out.push(ChatEvent::TextDelta {
                            turn_id: turn_id.to_string(),
                            text: text.to_string(),
                        });
                    }
                }
            }
            "tool_use" => {
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                // `ExitPlanMode` is the CLI's built-in signal that the
                // design plan is ready. Surface it as a dedicated
                // `PlanProposed` event (not a generic tool chip) and flag
                // the turn so the driver can end it deterministically.
                if name == "ExitPlanMode" {
                    let plan = plan_from_exit_plan_mode(block.get("input"));
                    state.any_text_emitted = true;
                    state.plan_proposed = true;
                    out.push(ChatEvent::PlanProposed {
                        turn_id: turn_id.to_string(),
                        plan,
                    });
                    continue;
                }
                // `AskUserQuestion` is the CLI's built-in preference-fork
                // prompt. Convert it to the `panda-questions` fence the chat
                // already renders as choice chips (not a generic tool chip) and
                // flag the turn so the driver ends it for the user to answer.
                if name == "AskUserQuestion" {
                    if let Some(fence) = questions_fence_from_ask_user_question(block.get("input"))
                    {
                        state.any_text_emitted = true;
                        state.questions_asked = true;
                        out.push(ChatEvent::TextDelta {
                            turn_id: turn_id.to_string(),
                            text: fence,
                        });
                    }
                    continue;
                }
                let tu_id = block
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let input = block
                    .get("input")
                    .cloned()
                    .unwrap_or_else(|| Value::Object(Default::default()));
                state.pending_tools.insert(tu_id.clone(), name.clone());
                out.push(ChatEvent::ToolUseStart {
                    turn_id: turn_id.to_string(),
                    tool: name,
                    tool_use_id: tu_id,
                    input,
                });
            }
            _ => {}
        }
    }
    out
}

/// Last-resort fallback: if a whole turn produced no text at all (neither
/// streamed deltas nor a consolidated `assistant` text block — e.g. an
/// unexpected CLI variant), surface the `result` line's top-level
/// `result` string so the bubble isn't left empty. `turn_end` itself is
/// still emitted at the driver level.
fn from_result(o: &Value, turn_id: &str, state: &mut StreamState) -> Vec<ChatEvent> {
    if state.any_text_emitted {
        return Vec::new();
    }
    if let Some(text) = o.get("result").and_then(Value::as_str) {
        if !text.is_empty() {
            state.any_text_emitted = true;
            return vec![ChatEvent::TextDelta {
                turn_id: turn_id.to_string(),
                text: text.to_string(),
            }];
        }
    }
    Vec::new()
}

fn from_user(o: &Value, turn_id: &str, state: &mut StreamState) -> Vec<ChatEvent> {
    let mut out: Vec<ChatEvent> = Vec::new();
    let Some(msg) = o.get("message") else { return out };
    let Some(content) = msg.get("content").and_then(Value::as_array) else {
        return out;
    };
    for block in content {
        if block.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        let tu_id = block
            .get("tool_use_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        // Pair the result back to its start by id. A miss means this result
        // belongs to a tool whose `ToolUseStart` was deliberately suppressed —
        // the intercepted built-ins `AskUserQuestion` / `ExitPlanMode`, which
        // become a questions fence / PlanProposed instead of a tool chip. Their
        // (often error) results must be dropped: with no matching start, the
        // chat reducer would otherwise fabricate a phantom, unnamed "Working"
        // error row and make the app look like it's malfunctioning.
        let Some(tool_name) = state.pending_tools.remove(tu_id) else {
            continue;
        };
        let is_error = block
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        out.push(ChatEvent::ToolUseEnd {
            turn_id: turn_id.to_string(),
            tool: tool_name,
            tool_use_id: tu_id.to_string(),
            ok: !is_error,
            result_summary: summarize_tool_result(block.get("content")),
        });
    }
    out
}

/// Flatten a `tool_result` `content` field to plain text. The CLI sends it
/// either as a bare string or as an array of `{type, text}` blocks.
fn tool_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| {
                if item.get("type").and_then(Value::as_str) == Some("text") {
                    item.get("text").and_then(Value::as_str).map(str::to_string)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Short human summary of a tool's output for the trace timeline — a line
/// count ("3 lines"). `None` when the result is empty or non-text, so the UI
/// simply omits it rather than showing "0 lines". Shared with the session
/// rehydrator (`chat::parse_session_history`) so live and reloaded traces read
/// the same.
pub(crate) fn summarize_tool_result(content: Option<&Value>) -> Option<String> {
    let text = tool_result_text(content);
    let trimmed = text.trim_end();
    if trimmed.is_empty() {
        return None;
    }
    let lines = trimmed.lines().count().max(1);
    Some(format!("{lines} line{}", if lines == 1 { "" } else { "s" }))
}

// ---------------------------------------------------------------------------
// Subprocess driver
// ---------------------------------------------------------------------------

/// Spawn `claude -p`, stream its stream-json output, and forward
/// translated [`ChatEvent`]s to `on_event`. Emits a `TurnStart` first,
/// `ArtifactChanged` events from the post-turn mtime diff, and a final
/// `TurnEnd`. Errors are reported as `ChatEvent::Error` followed by
/// `TurnEnd` — the function still returns `Ok(())` because the caller
/// (chat command) has already resolved with the turn_id.
///
/// On `cancel.cancelled()`, kill the child and emit `Error{ message:
/// "cancelled" }` + `TurnEnd`.
pub async fn spawn_turn<F>(
    workspace_dir: &Path,
    session_id: uuid::Uuid,
    user_message: &str,
    images: &[PathBuf],
    turn_id: &str,
    phase: TurnPhase,
    on_event: F,
    cancel: CancellationToken,
) -> Result<(), DriverError>
where
    F: Fn(ChatEvent) + Send + Sync + 'static,
{
    on_event(ChatEvent::TurnStart {
        turn_id: turn_id.to_string(),
        phase: phase.tag(),
    });

    // Pre-flight: resolve the claude CLI against an augmented PATH so a
    // Finder/Dock-launched app (minimal launchd PATH) still finds it.
    let claude_path = match resolve_claude(workspace_dir) {
        Some(p) => p,
        None => {
            on_event(ChatEvent::Error {
                turn_id: turn_id.to_string(),
                message: "`claude` CLI not found. Install Claude Code (https://claude.ai/install)."
                    .to_string(),
            });
            on_event(ChatEvent::TurnEnd {
                turn_id: turn_id.to_string(),
            });
            return Err(DriverError::NotInstalled);
        }
    };

    if let Err(e) = tokio::fs::create_dir_all(workspace_dir).await {
        on_event(ChatEvent::Error {
            turn_id: turn_id.to_string(),
            message: format!("failed to create workspace dir: {e}"),
        });
        on_event(ChatEvent::TurnEnd {
            turn_id: turn_id.to_string(),
        });
        return Err(DriverError::Io(e));
    }

    // Headless `claude -p` never writes Claude Code's own `ai-title`, so a
    // project would otherwise stay named "New project" forever. On the first
    // plan turn, kick off an isolated title-generation call concurrently — its
    // latency hides behind the slower main turn — and land the result just
    // before `TurnEnd`, where the frontend's refresh-on-`turn_end` picks it up.
    // Gated on the placeholder so it runs at most once per project.
    let title_task = if matches!(phase, TurnPhase::Plan)
        && crate::commands::project::needs_autoname(workspace_dir).await
    {
        Some(tokio::spawn(generate_project_title(
            claude_path.clone(),
            user_message.to_string(),
        )))
    } else {
        None
    };

    let pre_snapshot = snapshot_workspace(workspace_dir);

    // Honor the "Sign in with Panda" path: when the user picked the proxy during
    // onboarding, route this turn through Panda's hosted Claude server. Settings
    // are the source of truth (set by `app_panda_login`); `build_env` turns these
    // fields into `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`. Best-effort: a
    // settings read failure just falls back to the user's own host auth.
    let settings = crate::commands::app::load_settings().await.ok();
    let use_panda_cloud = settings.as_ref().map(|s| s.use_panda_cloud).unwrap_or(false);
    let panda_base_url = settings.as_ref().and_then(|s| s.panda_base_url.clone());
    // Model selected in the composer's switcher; `None` → `build_command`
    // defaults to `opus`. Captured before `settings` is consumed below.
    let model = settings.as_ref().and_then(|s| s.model.clone());
    let panda_token = settings.and_then(|s| s.panda_token);

    let cfg = ClaudeRunConfig {
        prompt: user_message.to_string(),
        workspace: workspace_dir.to_path_buf(),
        claude_session_id: Some(session_id.to_string()),
        model,
        use_panda_cloud,
        panda_token,
        panda_base_url,
        images: images.to_vec(),
        phase,
    };
    let argv = build_command(&cfg);
    let env = build_env(&cfg);

    let debug_stream = claude_stream_debug::enabled();
    let raw_stream = claude_stream_debug::raw();
    let color = debug_stream && !raw_stream && claude_stream_debug::color();
    if debug_stream {
        if raw_stream {
            // Flags only — the trailing prompt/system-prompt are large.
            let flags = argv[1..argv.len().saturating_sub(1)].join(" ");
            eprintln!("[claude:out] spawn {} {}", claude_path.display(), flags);
        } else {
            let resume = argv.iter().any(|a| a == "--resume");
            let sid = claude_stream_debug::short_id(cfg.claude_session_id.as_deref().unwrap_or(""));
            eprintln!(
                "{} {}",
                claude_stream_debug::paint(color, "2", "[claude]"),
                claude_stream_debug::paint(
                    color,
                    "35",
                    &format!(
                        "▶ turn {:?}  model={}  mode={}  session={sid} ({})",
                        phase,
                        cfg.model.as_deref().unwrap_or("opus"),
                        phase.permission_mode(),
                        if resume { "resume" } else { "new" },
                    ),
                ),
            );
        }
    }

    // argv[0] is "claude"; the rest are flags + the prompt. We spawn the
    // resolved absolute path (argv[0] is kept for build_command parity).
    // A Windows `claude.cmd` is run directly — std handles batch wrappers
    // (see resolve_claude); an explicit `cmd /C` would mangle the args.
    // When the turn carries reference images, the prompt+images go in as a
    // stream-json user message on stdin (so the VLM sees the pixels); otherwise
    // the prompt is a positional arg and stdin stays closed.
    let stdin_payload = stream_json_input(&cfg);
    let mut command = Command::new(&claude_path);
    command
        .args(&argv[1..])
        .current_dir(workspace_dir)
        .stdin(if stdin_payload.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Give the child the augmented PATH so claude can find `node` and the
    // cadcode skill can find its tools, regardless of launch context.
    command.env("PATH", augmented_path());
    for (k, v) in &env {
        command.env(k, v);
    }

    let mut child: Child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            on_event(ChatEvent::Error {
                turn_id: turn_id.to_string(),
                message: format!("failed to spawn claude: {e}"),
            });
            on_event(ChatEvent::TurnEnd {
                turn_id: turn_id.to_string(),
            });
            return Err(DriverError::Spawn(e));
        }
    };

    // Feed the stream-json user message (prompt + image blocks) and close stdin
    // so claude's `-p` reader sees EOF and starts the turn. Only present when the
    // turn carries images; otherwise stdin was opened as null.
    if let Some(payload) = stdin_payload {
        if let Some(mut sin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt as _;
            let _ = sin.write_all(payload.as_bytes()).await;
            let _ = sin.write_all(b"\n").await;
            let _ = sin.shutdown().await;
            // drop closes the pipe → EOF for claude.
        }
    }

    // Drain the child's stderr concurrently. Two reasons: (1) an undrained
    // piped stderr deadlocks the child once the ~64 KiB pipe buffer fills;
    // (2) when claude fails fast (bad/duplicate session id, auth, missing
    // node) it prints the reason here and exits with nothing on stdout — we
    // capture it so the turn surfaces a real error instead of hanging on
    // "PLANNING" forever.
    let stderr_buf = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    if let Some(cerr) = child.stderr.take() {
        let sink = stderr_buf.clone();
        tokio::spawn(async move {
            let mut r = BufReader::new(cerr);
            let mut l = String::new();
            loop {
                l.clear();
                match r.read_line(&mut l).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if debug_stream {
                            eprint!("[claude:err] {l}");
                        }
                        if let Ok(mut g) = sink.lock() {
                            if g.len() < 8192 {
                                g.push_str(&l);
                            }
                        }
                    }
                }
            }
        });
    }

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            // Should never happen because we set `Stdio::piped()`.
            on_event(ChatEvent::Error {
                turn_id: turn_id.to_string(),
                message: "claude subprocess did not expose stdout".to_string(),
            });
            on_event(ChatEvent::TurnEnd {
                turn_id: turn_id.to_string(),
            });
            return Err(DriverError::Io(std::io::Error::other(
                "stdout pipe missing",
            )));
        }
    };

    let mut reader = BufReader::with_capacity(STDOUT_BUFFER_BYTES, stdout);
    let mut state = StreamState::default();
    let mut cancelled = false;
    let mut saw_output = false;
    // Running snapshot for incremental artifact emission (Layer 1 of the live
    // build stage): advanced past every mid-turn emission so the final
    // post-turn diff only reports whatever the incremental passes missed.
    let mut running_snapshot = pre_snapshot.clone();
    let mut artifacts_changed = false;

    let mut line = String::new();
    loop {
        line.clear();
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                cancelled = true;
                let _ = child.start_kill();
                break;
            }
            read = reader.read_line(&mut line) => {
                let n = match read {
                    Ok(n) => n,
                    Err(e) => {
                        on_event(ChatEvent::Error {
                            turn_id: turn_id.to_string(),
                            message: format!("read error: {e}"),
                        });
                        let _ = child.start_kill();
                        break;
                    }
                };
                if n == 0 {
                    break; // EOF
                }
                if debug_stream {
                    if raw_stream {
                        // `line` keeps its trailing newline; eprint! avoids
                        // doubling it. Raw stream-json from claude.
                        eprint!("[claude:out] {line}");
                    } else if let Some(s) = claude_stream_debug::pretty_line(&line, "claude", color) {
                        eprintln!("{s}");
                    }
                }
                let events = parse_stream_line(&line, turn_id, &mut state);
                // Either `ExitPlanMode` (plan ready) or `AskUserQuestion`
                // (preference fork) ends the plan turn deterministically.
                let stop_turn = state.plan_proposed || state.questions_asked;
                let mut tool_just_ended = false;
                for ev in events {
                    saw_output = true;
                    if matches!(ev, ChatEvent::ToolUseEnd { .. }) {
                        tool_just_ended = true;
                    }
                    // A `PlanProposed` with an empty plan means the model exited
                    // plan mode without restating it (typical on resume) — and
                    // there was no `planFilePath` to read either. Recover the
                    // plan from the persisted transcript so the card isn't blank.
                    let ev = match ev {
                        ChatEvent::PlanProposed { turn_id: tid, plan } if plan.trim().is_empty() => {
                            ChatEvent::PlanProposed {
                                turn_id: tid,
                                plan: recover_plan_from_session(
                                    workspace_dir,
                                    &session_id.to_string(),
                                ),
                            }
                        }
                        other => other,
                    };
                    on_event(ev);
                }
                // Incremental artifact emission: when a tool just finished, diff
                // the workspace against the running snapshot and emit any new or
                // modified artifacts now, so intermediate models materialize in
                // the viewer mid-build instead of only at turn end. Advancing the
                // running snapshot past each emission keeps the final post-turn
                // diff from re-emitting the same files.
                if tool_just_ended {
                    let now_snapshot = snapshot_workspace(workspace_dir);
                    let inc = diff_snapshots(&running_snapshot, &now_snapshot, turn_id);
                    if !inc.is_empty() {
                        artifacts_changed = true;
                        for ev in inc {
                            on_event(ev);
                        }
                    }
                    running_snapshot = now_snapshot;
                }
                // Kill the child rather than relying on headless `-p` exiting on
                // its own after the tool call. The post-turn diff finds nothing
                // new: the plan turn may run read-only analysis but produces no
                // final artifacts (the prompt bars writing source / generating
                // parts), and a question is asked before any plan file is written.
                if stop_turn {
                    let _ = child.start_kill();
                    break;
                }
            }
        }
    }

    // Best-effort wait for the child to settle so the resulting mtimes
    // reflect any final Edit/Write flushes. `kill_on_drop` will reap if
    // we returned early.
    let status = child.wait().await;

    // Silent failure: claude exited without emitting any stream-json (e.g.
    // duplicate `--session-id`, auth failure, missing `node`). Surface its
    // stderr so the turn reports a real error instead of hanging on
    // "PLANNING". A normal plan turn produces output before we kill it, so
    // `saw_output` stays true there.
    if !cancelled && !saw_output {
        let detail = stderr_buf
            .lock()
            .ok()
            .map(|g| g.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                format!("claude exited without output ({status:?})")
            });
        // On the Panda proxy path, a revoked/expired key surfaces as an auth
        // error here (the BE returns 401). Emit a dedicated event the chat UI
        // turns into a "Sign in again" action instead of a cryptic message.
        if cfg.use_panda_cloud && looks_like_auth_failure(&detail) {
            on_event(ChatEvent::AuthExpired {
                turn_id: turn_id.to_string(),
            });
        } else {
            on_event(ChatEvent::Error {
                turn_id: turn_id.to_string(),
                message: format!("claude produced no response: {detail}"),
            });
        }
    }

    // Post-turn workspace diff. Emit artifact_changed for everything
    // new or with bumped mtime. We do this even when cancelled — the
    // user still wants to see any artifacts produced before cancel.
    let post_snapshot = snapshot_workspace(workspace_dir);
    let diff_events = diff_snapshots(&running_snapshot, &post_snapshot, turn_id);
    if !diff_events.is_empty() {
        artifacts_changed = true;
    }
    for ev in diff_events {
        on_event(ev);
    }

    // Automatic post-build review (silent), run inside this build turn: first
    // geometry auto-fix while cadpy still reports blocking warnings in the
    // `.step.json` sidecars, then one aesthetic-polish pass against the
    // premium-product rubric (gated on the `sharp_edges` advisory). No separate
    // user-visible turn. Best-effort: it never fails the turn.
    if matches!(phase, TurnPhase::Implement) && !cancelled && saw_output && artifacts_changed {
        run_review_fix_loop(
            &claude_path,
            workspace_dir,
            session_id,
            turn_id,
            &on_event,
            &cancel,
        )
        .await;

        // A generate/edit just finished and the review loop has settled the
        // geometry. Auto-save a `Version N` snapshot of the result, capturing the
        // Claude session transcript beside the model — so every build lands a
        // restorable version with its conversation (the Saved States panel
        // reloads its list when opened). Done here, after the review loop, so the
        // snapshot reflects the final fixed files and the fully-flushed session
        // JSONL (every subprocess in this turn has exited by now). Best-effort:
        // the turn never fails on a snapshot error.
        let live = session_jsonl_path(workspace_dir, &session_id.to_string());
        if let Err(e) =
            crate::commands::snapshot::save_snapshot_at(workspace_dir, live.as_deref(), None)
        {
            eprintln!("auto-snapshot after build failed: {e:?}");
        }

        // Best-effort: copy the finished design to panda-social (design-import
        // API). The geometry has settled and the `model_review/` render PNGs the
        // import uses for the cover are on disk. Fires once per project (records
        // a marker), no-ops until a real access token is configured, and runs
        // detached so the ≤120 s upload never blocks TurnEnd or fails the turn.
        let import_ws = workspace_dir.to_path_buf();
        tokio::spawn(async move {
            crate::commands::social::maybe_import_after_build(&import_ws).await;
        });
    }

    // Land the auto-generated project name (if any) before TurnEnd so the
    // frontend's refresh picks it up. Skip on cancel / when the turn produced
    // nothing — the placeholder then survives and a later plan turn retries.
    if let Some(task) = title_task {
        if !cancelled && saw_output {
            if let Ok(Some(title)) = task.await {
                crate::commands::project::set_name_if_placeholder(workspace_dir, &title).await;
            }
        } else {
            task.abort();
        }
    }

    if cancelled {
        on_event(ChatEvent::Error {
            turn_id: turn_id.to_string(),
            message: "cancelled".to_string(),
        });
    }
    on_event(ChatEvent::TurnEnd {
        turn_id: turn_id.to_string(),
    });
    Ok(())
}

/// Max automatic review→fix rounds after a build. Each round is a full claude
/// turn, so this is also the cost ceiling: two rounds catch the common case
/// (fix, then verify) without risking a long unattended loop.
pub const MAX_REVIEW_ROUNDS: usize = 2;

/// Max automatic visual-verification rounds, run after geometry + function are
/// clean. This is the ALWAYS-ON pass that guarantees steps 3 & 4 of the flow —
/// look at every part from all directions + the assembly + interior
/// cross-sections, then fix anything wrong (correctness AND premium look) and
/// regenerate. Unlike the geometry/functional phases it is NOT gated on a
/// warning: a zero-warning build still gets one forced render-inspect-fix round.
/// Capped at 2 (one fix + one verify) and breaks early the instant a round
/// changes nothing, so a clean part pays a single extra round.
pub const MAX_VISUAL_ROUNDS: usize = 2;

/// Max automatic functional/assembly-fix rounds, run after geometry is clean and
/// before visual verification. A `functional` warning means the part can't be
/// assembled/used (e.g. a connector that won't fit its opening), so — like
/// geometry — the loop runs until they're gone, with a generous cap (the user's
/// "guarantee it works"). Re-collects each round and stops the instant they clear.
pub const MAX_FUNCTIONAL_ROUNDS: usize = 3;

/// Whether a warning is advisory rather than a blocking geometry defect.
/// Advisory warnings never gate the geometry-fix loop and never produce the
/// end-of-loop "unresolved issues" note — they only seed the aesthetic-polish
/// pass (e.g. the `sharp_edges` hint). Keyed off `severity == "info"`, not a
/// `kind` allowlist, so any future info-level advisory is classified correctly
/// without touching this code (and can't leak into the geometry gate).
fn is_advisory(w: &GeometryWarning) -> bool {
    w.severity == "info"
}

/// Whether a warning is a project-declared functional/assembly check (the part
/// is a valid solid but can't be assembled/used as intended). These drive the
/// dedicated functional-review phase — they must NOT be lumped into the geometry
/// gate (their severity is `"warning"`, like geometry defects), so the loop
/// classifies them by `kind` and excludes them from the geometry filter.
fn is_functional(w: &GeometryWarning) -> bool {
    w.kind == "functional"
}

/// A deterministic geometry problem cadpy recorded under `validation.warnings`
/// in a `.step.json` sidecar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeometryWarning {
    pub part: String,
    pub kind: String,
    pub detail: String,
    pub severity: String,
}

/// Read every `.step.json` sidecar under `dir` and collect the
/// `validation.warnings` cadpy wrote. Pure + best-effort: unreadable or
/// malformed sidecars are skipped, never fatal.
pub fn collect_workspace_warnings(dir: &Path) -> Vec<GeometryWarning> {
    let mut out = Vec::new();
    for entry in WalkDir::new(dir).follow_links(false).into_iter().flatten() {
        let path = entry.path();
        if !path.is_file() || !path.to_string_lossy().ends_with(".step.json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let Some(warnings) = json
            .get("validation")
            .and_then(|v| v.get("warnings"))
            .and_then(|w| w.as_array())
        else {
            continue;
        };
        let s = |w: &serde_json::Value, k: &str, d: &str| {
            w.get(k).and_then(|v| v.as_str()).unwrap_or(d).to_string()
        };
        for w in warnings {
            out.push(GeometryWarning {
                part: s(w, "part", ""),
                kind: s(w, "kind", ""),
                detail: s(w, "detail", ""),
                severity: s(w, "severity", "warning"),
            });
        }
    }
    out
}

/// Build the silent review-turn prompt from the outstanding warnings. Returns
/// `None` when there is nothing to fix (the loop then stops). The
/// `REVIEW_SYSTEM_PROMPT` carries the how; this message carries the what.
pub fn build_review_prompt(warnings: &[GeometryWarning]) -> Option<String> {
    if warnings.is_empty() {
        return None;
    }
    let mut body = String::from(
        "An automatic geometry check found these problems in the parts you just \
         built. Fix every one, then regenerate until the check is clean:\n\n",
    );
    for w in warnings {
        body.push_str(&format!("- [{}] {}: {}\n", w.part, w.kind, w.detail));
    }
    Some(body)
}

/// Build the silent functional-review prompt from the outstanding `functional`
/// warnings. Returns `None` when there are none (the phase then ends). Frames
/// them as assembly/installation failures — render, physically reason about each
/// step against `references/component-integration.md`, fix the geometry/params,
/// regenerate until the functional check is clean.
pub fn build_functional_prompt(warnings: &[GeometryWarning]) -> Option<String> {
    if warnings.is_empty() {
        return None;
    }
    let mut body = String::from(
        "An automatic FUNCTIONAL check found these assembly/usability problems in \
         the parts you just built — the geometry is valid but the product won't \
         work as intended. Render with `scripts/review`, then for each one \
         physically reason about the assembly step against \
         `references/component-integration.md` (can the component AND its captive \
         cable / connector collar actually get into place — open route, opening \
         sized for the connector, reachable path?). Fix the geometry/params, \
         update the `validate()`/`functional_checks()` so it's enforced, and \
         regenerate until every functional check is clean:\n\n",
    );
    for w in warnings {
        body.push_str(&format!("- [{}] {}: {}\n", w.part, w.kind, w.detail));
    }
    Some(body)
}

/// Build the silent visual-verification prompt. Unlike [`build_review_prompt`]
/// this is NOT gated on warnings — it always asks for one render-inspect-fix pass
/// covering BOTH correctness-by-eye and premium look, so a zero-warning build is
/// still visually checked from every direction. The optional `soft_edge_hint`
/// (the `sharp_edges` advisories) seeds the aesthetic critique with concrete
/// candidates; an empty slice yields a purely visual prompt.
pub fn build_visual_prompt(soft_edge_hint: &[GeometryWarning]) -> String {
    let mut body = String::from(
        "Geometry and function are clean. Do ONE visual verification pass now. \
         Run `python ~/.claude/skills/cadcode/scripts/review <project_dir>` — it \
         renders the assembled model AND every named part from ALL directions (a \
         3/4 iso plus all six axis-aligned faces) and auto-cuts the assembly's x, \
         y, and z center cross-sections. `Read` EVERY PNG it produces and look. \
         Check two things on every part and on the assembly:\n\
         1. CORRECTNESS the renders expose that the geometry checks miss — a part \
         floating or poking through a plate, a feature perched over a void, a \
         mating interface that doesn't actually engage. For any interface a center \
         cut misses, render a targeted section (`scripts/review <dir> --section \
         <x|y|z>@<offset> --part <name>`) and confirm it seats and can transmit \
         its force.\n\
         2. PREMIUM LOOK against the rubric in `references/industrial-design.md` \
         (unified radius language, blended transitions, calm primary surfaces, \
         minimized fasteners).\n\
         Fix anything wrong in the source and regenerate (`scripts/cad`), then \
         re-render to confirm. Refine ONLY within printability and strength limits \
         — never thin a wall below its minimum, remove load-bearing material, \
         round a functional/mating edge, or add an unprintable overhang or sliver; \
         leave functional arrises sharp. If every part and the assembly already \
         read correct and premium, change nothing. Then stop.\n",
    );
    if !soft_edge_hint.is_empty() {
        body.push_str(
            "\nThe deterministic edge check flagged these candidates (verify \
             visually before acting — some arrises are intentional):\n",
        );
        for w in soft_edge_hint {
            body.push_str(&format!("- [{}] {}: {}\n", w.part, w.kind, w.detail));
        }
    }
    body
}

/// Run one silent [`TurnPhase::Review`] round with `prompt`: spawn the child,
/// snapshot/diff the workspace, and surface any changed artifacts. Returns true
/// if this round changed files. Shared by the geometry-fix and aesthetic-polish
/// phases of [`run_review_fix_loop`].
async fn run_review_round<F>(
    claude_path: &Path,
    workspace_dir: &Path,
    session_id: uuid::Uuid,
    turn_id: &str,
    prompt: String,
    on_event: &F,
    cancel: &CancellationToken,
) -> bool
where
    F: Fn(ChatEvent),
{
    let cfg = ClaudeRunConfig {
        prompt,
        workspace: workspace_dir.to_path_buf(),
        claude_session_id: Some(session_id.to_string()),
        model: Some("opus".into()),
        use_panda_cloud: false,
        panda_token: None,
        panda_base_url: None,
        images: Vec::new(),
        phase: TurnPhase::Review,
    };

    let pre = snapshot_workspace(workspace_dir);
    drain_review_child(claude_path, workspace_dir, &cfg, cancel).await;
    let post = snapshot_workspace(workspace_dir);
    let diff = diff_snapshots(&pre, &post, turn_id);
    let changed = !diff.is_empty();
    for ev in diff {
        on_event(ev); // surface fixed/refined parts as they land
    }
    changed
}

/// Emit the one-line "unresolved issues" note when a review phase couldn't
/// converge. `review_label` names the phase (e.g. "geometry", "functional") so
/// geometry and functional bails surface identically-shaped notes.
fn emit_unresolved_note<F>(
    turn_id: &str,
    review_label: &str,
    remaining: &[GeometryWarning],
    on_event: &F,
) where
    F: Fn(ChatEvent),
{
    let mut parts: Vec<String> = remaining
        .iter()
        .map(|w| w.part.clone())
        .filter(|p| !p.is_empty())
        .collect();
    parts.sort();
    parts.dedup();
    on_event(ChatEvent::TextDelta {
        turn_id: turn_id.to_string(),
        text: format!(
            "\n\n_Note: automatic {review_label} review left {} issue(s) \
             unresolved (parts: {}). You may want to inspect those parts._",
            remaining.len(),
            if parts.is_empty() {
                "model".to_string()
            } else {
                parts.join(", ")
            },
        ),
    });
}

/// Automatic post-build review, run silently inside the build turn. Three phases,
/// in priority order — geometry → functional → visual verification:
///
/// 1. **Geometry fix** — while the deterministic check still reports blocking
///    geometry warnings, resume in [`TurnPhase::Review`] and render-inspect-fix
///    (up to [`MAX_REVIEW_ROUNDS`]). If it can't converge, note + stop.
/// 2. **Functional fix** — while any project-declared `functional` warning
///    remains (the part is a valid solid but won't assemble/work), fix it (up to
///    [`MAX_FUNCTIONAL_ROUNDS`]). If it can't converge, surface a user-visible
///    note (the part won't work) + stop — don't fix-up a non-working part.
/// 3. **Visual verification** — once geometry + function are clean, an ALWAYS-ON
///    render-inspect-fix pass (up to [`MAX_VISUAL_ROUNDS`]) over every part from
///    all directions + the assembly + interior cross-sections, checking both
///    correctness-by-eye and premium look. NOT gated on a warning — a
///    zero-warning build still gets one forced visual pass; `sharp_edges` only
///    seeds the aesthetic hint. Breaks early the instant a round changes nothing.
///
/// Best-effort throughout — any failure here must never fail the build turn.
/// Returns whether any artifacts changed.
async fn run_review_fix_loop<F>(
    claude_path: &Path,
    workspace_dir: &Path,
    session_id: uuid::Uuid,
    turn_id: &str,
    on_event: &F,
    cancel: &CancellationToken,
) -> bool
where
    F: Fn(ChatEvent),
{
    let mut changed = false;

    // Phase 1 — geometry fix (gated on deterministic blocking geometry warnings).
    for _ in 0..MAX_REVIEW_ROUNDS {
        if cancel.is_cancelled() {
            return changed;
        }
        // Only BLOCKING geometry defects gate this loop. Advisory aesthetic
        // signals (`sharp_edges`, info) and project `functional` warnings are
        // filtered out so they never trigger the geometry-fix prompt — they have
        // their own phases below, function-first.
        let blocking: Vec<GeometryWarning> = collect_workspace_warnings(workspace_dir)
            .into_iter()
            .filter(|w| !is_advisory(w) && !is_functional(w))
            .collect();
        let Some(prompt) = build_review_prompt(&blocking) else {
            break; // no blocking geometry defects; move on to functional
        };
        changed |= run_review_round(
            claude_path,
            workspace_dir,
            session_id,
            turn_id,
            prompt,
            on_event,
            cancel,
        )
        .await;
    }

    if cancel.is_cancelled() {
        return changed;
    }

    // If geometry never converged, leave the note and stop — fixing function or
    // polishing a part that's still geometrically broken is wasted budget.
    let geometry_remaining: Vec<GeometryWarning> = collect_workspace_warnings(workspace_dir)
        .into_iter()
        .filter(|w| !is_advisory(w) && !is_functional(w))
        .collect();
    if !geometry_remaining.is_empty() {
        emit_unresolved_note(turn_id, "geometry", &geometry_remaining, on_event);
        return changed;
    }

    // Phase 2 — functional fix. Loop until the project's `functional` warnings
    // clear (the user's "guarantee it works"), re-collecting each round.
    for _ in 0..MAX_FUNCTIONAL_ROUNDS {
        if cancel.is_cancelled() {
            return changed;
        }
        let functional: Vec<GeometryWarning> = collect_workspace_warnings(workspace_dir)
            .into_iter()
            .filter(is_functional)
            .collect();
        let Some(prompt) = build_functional_prompt(&functional) else {
            break; // no functional issues; move on to polish
        };
        changed |= run_review_round(
            claude_path,
            workspace_dir,
            session_id,
            turn_id,
            prompt,
            on_event,
            cancel,
        )
        .await;
    }

    if cancel.is_cancelled() {
        return changed;
    }

    // If function never converged, surface it (the part won't work as intended)
    // and stop — don't polish a non-working part.
    let functional_remaining: Vec<GeometryWarning> = collect_workspace_warnings(workspace_dir)
        .into_iter()
        .filter(is_functional)
        .collect();
    if !functional_remaining.is_empty() {
        emit_unresolved_note(turn_id, "functional", &functional_remaining, on_event);
        return changed;
    }

    // Phase 3 — visual verification. ALWAYS runs at least one round, even on a
    // zero-warning build: this is the guaranteed render-inspect-fix pass over
    // every part (all directions) + the assembly + interior cross-sections that
    // closes steps 3 & 4 of the flow. `sharp_edges` advisories only seed the
    // aesthetic hint — they do not gate the phase. The "a round changed nothing"
    // guard keeps a clean part to a single round.
    let mut soft_edges: Vec<GeometryWarning> = collect_workspace_warnings(workspace_dir)
        .into_iter()
        .filter(|w| is_advisory(w))
        .collect();
    for round in 0..MAX_VISUAL_ROUNDS {
        if cancel.is_cancelled() {
            return changed;
        }
        let prompt = build_visual_prompt(&soft_edges);
        let round_changed = run_review_round(
            claude_path,
            workspace_dir,
            session_id,
            turn_id,
            prompt,
            on_event,
            cancel,
        )
        .await;
        changed |= round_changed;
        // Churn guard: a round that changed nothing means the model judged every
        // part and the assembly correct and premium — stop rather than re-prompting.
        if !round_changed {
            break;
        }
        // Re-read so the NEXT round's hint reflects the freshly refined geometry.
        // Skip on the final round — the result would never be read (avoids a
        // wasted workspace walk).
        if round + 1 < MAX_VISUAL_ROUNDS {
            soft_edges = collect_workspace_warnings(workspace_dir)
                .into_iter()
                .filter(|w| is_advisory(w))
                .collect();
        }
    }

    changed
}

/// Spawn one silent Review-phase `claude` child and drain it to EOF. Mirrors
/// the main turn's spawn setup (augmented PATH, drained stderr) but discards the
/// stream — review chatter is not surfaced; only the post-round workspace diff
/// (done by the caller) reaches the user.
async fn drain_review_child(
    claude_path: &Path,
    workspace_dir: &Path,
    cfg: &ClaudeRunConfig,
    cancel: &CancellationToken,
) {
    let argv = build_command(cfg);
    let env = build_env(cfg);
    let mut command = Command::new(claude_path);
    command
        .args(&argv[1..])
        .current_dir(workspace_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.env("PATH", augmented_path());
    for (k, v) in &env {
        command.env(k, v);
    }

    let mut child: Child = match command.spawn() {
        Ok(c) => c,
        Err(_) => return, // best-effort; a build that can't be reviewed just ends
    };

    let debug_stream = claude_stream_debug::enabled();
    let raw_stream = claude_stream_debug::raw();
    let color = debug_stream && !raw_stream && claude_stream_debug::color();

    // Drain stderr so a full pipe can't deadlock the child.
    if let Some(cerr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut r = BufReader::new(cerr);
            let mut l = String::new();
            loop {
                l.clear();
                match r.read_line(&mut l).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if debug_stream {
                            eprint!("[claude:review:err] {l}");
                        }
                    }
                }
            }
        });
    }

    // Drain stdout to EOF without parsing — the review runs silent (except
    // when PANDA_DEBUG_CLAUDE mirrors the stream for debugging).
    if let Some(cout) = child.stdout.take() {
        let mut reader = BufReader::with_capacity(STDOUT_BUFFER_BYTES, cout);
        let mut line = String::new();
        loop {
            line.clear();
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    let _ = child.start_kill();
                    break;
                }
                read = reader.read_line(&mut line) => {
                    match read {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            if debug_stream {
                                if raw_stream {
                                    eprint!("[claude:review:out] {line}");
                                } else if let Some(s) =
                                    claude_stream_debug::pretty_line(&line, "claude:review", color)
                                {
                                    eprintln!("{s}");
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let _ = child.wait().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::thread::sleep;
    use std::time::Duration;

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, b"").unwrap();
    }

    #[test]
    fn review_phase_runs_bypass_and_rides_implement_tag() {
        assert_eq!(TurnPhase::Review.permission_mode(), "bypassPermissions");
        assert_eq!(TurnPhase::Review.tag(), TurnPhaseTag::Implement);
        assert_eq!(TurnPhase::Review.system_prompt(), REVIEW_SYSTEM_PROMPT);
        let prompt = TurnPhase::Review.system_prompt();
        assert!(prompt.contains("scripts/review"));
        // Generalized to cover geometry repair, functional fixes, and the
        // always-on visual verification pass (correctness-by-eye + premium look).
        assert!(prompt.contains("industrial-design"));
        assert!(prompt.contains("component-integration"));
        assert!(prompt.contains("GEOMETRY"));
        assert!(prompt.contains("FUNCTIONAL"));
        assert!(prompt.contains("VISUAL VERIFICATION"));
        assert!(prompt.contains("ALL directions"));
    }

    #[test]
    fn collect_workspace_warnings_reads_sidecars_recursively() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // A clean part: validation present, no warnings.
        fs::create_dir_all(root.join("a")).unwrap();
        fs::write(
            root.join("a").join("clean.step.json"),
            r#"{"validation":{"isSolid":true}}"#,
        )
        .unwrap();
        // A flagged assembly nested deeper.
        fs::create_dir_all(root.join("b").join("nested")).unwrap();
        fs::write(
            root.join("b").join("nested").join("robot.step.json"),
            r#"{"validation":{"warnings":[
                {"part":"chassis","kind":"disconnected_bodies","detail":"3 solids","severity":"error"},
                {"part":"arm","kind":"sliver","detail":"tiny","severity":"warning"}
            ]}}"#,
        )
        .unwrap();
        // A malformed sidecar must be skipped, not fatal.
        fs::write(root.join("broken.step.json"), "{not json").unwrap();

        let mut warnings = collect_workspace_warnings(root);
        warnings.sort_by(|x, y| x.part.cmp(&y.part));
        assert_eq!(warnings.len(), 2);
        assert_eq!(warnings[0].part, "arm");
        assert_eq!(warnings[0].kind, "sliver");
        assert_eq!(warnings[1].part, "chassis");
        assert_eq!(warnings[1].kind, "disconnected_bodies");
        assert_eq!(warnings[1].severity, "error");
    }

    #[test]
    fn build_review_prompt_gates_on_warnings() {
        assert!(build_review_prompt(&[]).is_none());

        let warnings = vec![GeometryWarning {
            part: "chassis".into(),
            kind: "disconnected_bodies".into(),
            detail: "part is 3 separate solids".into(),
            severity: "error".into(),
        }];
        let prompt = build_review_prompt(&warnings).expect("warnings -> prompt");
        assert!(prompt.contains("chassis"));
        assert!(prompt.contains("disconnected_bodies"));
        assert!(prompt.contains("part is 3 separate solids"));
    }

    #[test]
    fn geometry_gate_ignores_aesthetic_only_warnings() {
        // The Phase-1 geometry loop filters aesthetic kinds before
        // build_review_prompt, so a part whose only warning is the advisory
        // `sharp_edges` is geometry-clean → no geometry-fix prompt (it goes to
        // the polish phase instead). Regression for sharp_edges leaking into the
        // "regenerate until the check is clean" geometry framing.
        let warnings = vec![
            GeometryWarning {
                part: "stand".into(),
                kind: "sharp_edges".into(),
                detail: "27 un-softened convex arris(es)".into(),
                severity: "info".into(),
            },
        ];
        let blocking: Vec<GeometryWarning> = warnings
            .into_iter()
            .filter(|w| !is_advisory(w))
            .collect();
        assert!(blocking.is_empty());
        assert!(build_review_prompt(&blocking).is_none());
    }

    #[test]
    fn geometry_gate_excludes_functional_warnings() {
        // A `functional` warning is severity:"warning" (like geometry defects),
        // so it must be excluded from the geometry gate by KIND — otherwise it
        // would be "fixed" with the geometry prompt instead of the functional
        // one. The functional phase gates on it instead.
        let w = |kind: &str, sev: &str| GeometryWarning {
            part: "stand".into(),
            kind: kind.into(),
            detail: "x".into(),
            severity: sev.into(),
        };
        let functional = w("functional", "warning");
        assert!(is_functional(&functional));
        assert!(!is_advisory(&functional)); // not info → would hit geometry gate
        // Geometry gate (used by Phase 1) excludes both advisory and functional.
        let warnings = vec![functional.clone(), w("sharp_edges", "info")];
        let geometry: Vec<GeometryWarning> = warnings
            .iter()
            .filter(|x| !is_advisory(x) && !is_functional(x))
            .cloned()
            .collect();
        assert!(geometry.is_empty());
        assert!(build_review_prompt(&geometry).is_none());
        // The functional phase picks it up.
        let fns: Vec<GeometryWarning> =
            warnings.into_iter().filter(is_functional).collect();
        assert_eq!(fns.len(), 1);
    }

    #[test]
    fn geometry_gate_blocks_on_collision_warnings() {
        // cadpy's pairwise collision check emits kind:"collision" severity:"error"
        // when two assembled parts interpenetrate. It is neither advisory (info)
        // nor functional, so it must land in the blocking geometry gate and drive
        // the "regenerate until clean" review loop. Regression for an interpene-
        // trating multi-part model being handed back as done.
        let collision = GeometryWarning {
            part: "base|lid".into(),
            kind: "collision".into(),
            detail: "parts 'base' and 'lid' interpenetrate by 2000.0 mm^3".into(),
            severity: "error".into(),
        };
        assert!(!is_advisory(&collision));
        assert!(!is_functional(&collision));
        let blocking: Vec<GeometryWarning> = vec![collision]
            .into_iter()
            .filter(|w| !is_advisory(w) && !is_functional(w))
            .collect();
        assert_eq!(blocking.len(), 1);
        let prompt = build_review_prompt(&blocking).expect("collision -> prompt");
        assert!(prompt.contains("collision"));
        assert!(prompt.contains("interpenetrate"));
    }

    #[test]
    fn build_functional_prompt_gates_and_lists() {
        assert!(build_functional_prompt(&[]).is_none());
        let warnings = vec![GeometryWarning {
            part: "stand".into(),
            kind: "functional".into(),
            detail: "puck connector won't fit the opening".into(),
            severity: "warning".into(),
        }];
        let prompt = build_functional_prompt(&warnings).expect("warnings -> prompt");
        assert!(prompt.contains("FUNCTIONAL"));
        assert!(prompt.contains("component-integration"));
        assert!(prompt.contains("stand"));
        assert!(prompt.contains("puck connector won't fit the opening"));
    }

    #[test]
    fn is_advisory_keys_off_info_severity() {
        let w = |kind: &str, sev: &str| GeometryWarning {
            part: "m".into(),
            kind: kind.into(),
            detail: String::new(),
            severity: sev.into(),
        };
        assert!(is_advisory(&w("sharp_edges", "info")));
        assert!(!is_advisory(&w("disconnected_bodies", "error")));
        assert!(!is_advisory(&w("sliver", "warning")));
        assert!(!is_advisory(&w("invalid_brep", "warning")));
        // A future info-level advisory of a different kind is classified
        // correctly with no allowlist edit — the whole point of keying on
        // severity rather than the `kind` string.
        assert!(is_advisory(&w("thin_wall", "info")));
    }

    #[test]
    fn build_visual_prompt_is_unconditional_and_seeds_hint() {
        // No hint → still a full visual-verification prompt (not gated on
        // warnings): it must cover both correctness-by-eye and the premium look,
        // and ask for all-direction renders.
        let bare = build_visual_prompt(&[]);
        assert!(bare.contains("visual verification"));
        assert!(bare.contains("ALL directions"));
        assert!(bare.contains("CORRECTNESS"));
        assert!(bare.contains("industrial-design"));
        assert!(!bare.contains("candidates"));

        // With a sharp_edges hint → the candidate is listed.
        let hint = vec![GeometryWarning {
            part: "lid".into(),
            kind: "sharp_edges".into(),
            detail: "7 un-softened convex arris(es)".into(),
            severity: "info".into(),
        }];
        let seeded = build_visual_prompt(&hint);
        assert!(seeded.contains("candidates"));
        assert!(seeded.contains("lid"));
        assert!(seeded.contains("sharp_edges"));
    }

    #[test]
    fn collect_workspace_warnings_reads_sharp_edges_advisory() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(
            root.join("tray.step.json"),
            r#"{"validation":{"warnings":[
                {"part":"tray","kind":"sharp_edges","detail":"12 arrises","severity":"info"}
            ]}}"#,
        )
        .unwrap();
        let warnings = collect_workspace_warnings(root);
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].kind, "sharp_edges");
        assert_eq!(warnings[0].severity, "info");
        // It must not be treated as a blocking geometry defect.
        assert!(is_advisory(&warnings[0]));
    }

    #[test]
    fn snapshot_picks_up_watched_extensions_recursively() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(&root.join("main.py"));
        touch(&root.join("model.step"));
        touch(&root.join("parts").join("base.py"));
        touch(&root.join("readme.txt")); // not watched
        let snap = snapshot_workspace(root);
        let mut sorted: Vec<String> = snap.keys().cloned().collect();
        sorted.sort();
        assert_eq!(sorted, vec!["main.py", "model.step", "parts/base.py"]);
    }

    #[test]
    fn diff_emits_new_then_modified() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(&root.join("a.py"));
        let before = snapshot_workspace(root);

        sleep(Duration::from_millis(1100));
        touch(&root.join("b.py"));
        // Bump mtime of a.py forward by a full second.
        fs::write(root.join("a.py"), b"// updated").unwrap();
        let after = snapshot_workspace(root);

        let events = diff_snapshots(&before, &after, "t-1");
        let kinds: Vec<(String, String)> = events
            .iter()
            .map(|e| match e {
                ChatEvent::ArtifactChanged { file, reason, .. } => (
                    file.clone(),
                    match reason {
                        ArtifactReason::New => "new".into(),
                        ArtifactReason::Modified => "modified".into(),
                    },
                ),
                _ => unreachable!(),
            })
            .collect();
        assert!(kinds.contains(&("b.py".into(), "new".into())));
        assert!(kinds.contains(&("a.py".into(), "modified".into())));
    }

    // Mirrors the live-build-stage running-snapshot loop: seed the running
    // snapshot from a pre-turn snapshot, diff after each tool finishes while
    // advancing the running snapshot past every emission, then a final diff.
    // Each artifact must surface exactly once across the incremental passes and
    // the final diff — never duplicated.
    #[test]
    fn running_snapshot_emits_each_artifact_once() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        let pre = snapshot_workspace(root);
        let mut running = pre.clone();
        let mut all: Vec<String> = Vec::new();

        // First tool finishes: part_a.step lands.
        touch(&root.join("part_a.step"));
        let snap1 = snapshot_workspace(root);
        let inc1 = diff_snapshots(&running, &snap1, "t-1");
        all.extend(inc1.iter().map(file_of));
        running = snap1;

        // Second tool finishes: part_b.stl lands.
        touch(&root.join("part_b.stl"));
        let snap2 = snapshot_workspace(root);
        let inc2 = diff_snapshots(&running, &snap2, "t-1");
        all.extend(inc2.iter().map(file_of));
        running = snap2;

        // Final post-turn diff against the advanced running snapshot: nothing
        // new since the last incremental pass, so it must be empty.
        let post = snapshot_workspace(root);
        let final_diff = diff_snapshots(&running, &post, "t-1");
        all.extend(final_diff.iter().map(file_of));

        assert!(final_diff.is_empty(), "final diff should not re-emit already-emitted artifacts");
        let mut sorted = all.clone();
        sorted.sort();
        assert_eq!(sorted, vec!["part_a.step".to_string(), "part_b.stl".to_string()]);
        // No duplicates: deduped length equals total length.
        sorted.dedup();
        assert_eq!(sorted.len(), all.len(), "each artifact must be emitted exactly once");
    }

    fn file_of(ev: &ChatEvent) -> String {
        match ev {
            ChatEvent::ArtifactChanged { file, .. } => file.clone(),
            _ => unreachable!(),
        }
    }

    #[test]
    fn build_command_includes_workspace_and_prompt() {
        let cfg = ClaudeRunConfig {
            prompt: "make me a hook".into(),
            workspace: PathBuf::from("/tmp/proj"),
            claude_session_id: None,
            model: None,
            use_panda_cloud: false,
            panda_token: None,
            panda_base_url: None,
            images: Vec::new(),
            phase: TurnPhase::Plan,
        };
        let cmd = build_command(&cfg);
        assert_eq!(cmd[0], "claude");
        assert!(cmd.contains(&"--add-dir".to_string()));
        assert!(cmd.contains(&"/tmp/proj".to_string()));
        assert!(cmd.contains(&"make me a hook".to_string()));
        assert!(cmd.contains(&"--no-session-persistence".to_string()));
    }

    #[test]
    fn build_command_grants_read_access_to_skills_tree() {
        // The cadcode skill reads its reference docs by absolute path under
        // `~/.claude/skills`, outside the workspace. A second `--add-dir`
        // keeps that tree inside the allowed roots for every phase.
        let cfg = ClaudeRunConfig {
            prompt: "make me a hook".into(),
            workspace: PathBuf::from("/tmp/proj"),
            claude_session_id: None,
            model: None,
            use_panda_cloud: false,
            panda_token: None,
            panda_base_url: None,
            images: Vec::new(),
            phase: TurnPhase::Plan,
        };
        let cmd = build_command(&cfg);
        let skills = home_dir()
            .map(|h| h.join(".claude").join("skills").display().to_string())
            .expect("home dir resolves in test env");
        // Two distinct --add-dir roots: the workspace and the skills tree.
        let add_dirs: Vec<&String> = cmd
            .iter()
            .enumerate()
            .filter(|(i, a)| *a == "--add-dir" && *i + 1 < cmd.len())
            .map(|(i, _)| &cmd[i + 1])
            .collect();
        assert!(add_dirs.contains(&&"/tmp/proj".to_string()));
        assert!(add_dirs.contains(&&skills));
    }

    #[test]
    fn build_command_uses_stream_json_input_and_inlines_images() {
        // Write a tiny fake image so stream_json_input can read + base64 it.
        let tmp = std::env::temp_dir().join(format!("panda-img-test-{}.png", std::process::id()));
        std::fs::write(&tmp, b"\x89PNG\r\n\x1a\nFAKE").unwrap();
        let cfg = ClaudeRunConfig {
            prompt: "match this reference".into(),
            workspace: PathBuf::from("/tmp/proj"),
            claude_session_id: None,
            model: None,
            use_panda_cloud: false,
            panda_token: None,
            panda_base_url: None,
            images: vec![tmp.clone()],
            phase: TurnPhase::Plan,
        };
        let cmd = build_command(&cfg);
        // With images we switch to stream-json input and DON'T pass the prompt
        // as a positional arg (it rides in the stdin message instead).
        let if_pos = cmd.iter().position(|a| a == "--input-format").unwrap();
        assert_eq!(cmd[if_pos + 1], "stream-json");
        assert!(
            !cmd.contains(&"match this reference".to_string()),
            "prompt must not be a positional arg in stream-json mode"
        );

        // The stdin payload is one JSON user message: a text block + one base64
        // image block whose media type matches the extension.
        let payload = stream_json_input(&cfg).expect("payload when images present");
        let v: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(v["type"], "user");
        let content = v["message"]["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "match this reference");
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[1]["source"]["media_type"], "image/png");
        assert!(!content[1]["source"]["data"].as_str().unwrap().is_empty());

        // No images → no stdin payload, prompt stays positional.
        let cfg_noimg = ClaudeRunConfig {
            images: Vec::new(),
            ..cfg.clone()
        };
        assert!(stream_json_input(&cfg_noimg).is_none());
        let cmd_noimg = build_command(&cfg_noimg);
        let if2 = cmd_noimg.iter().position(|a| a == "--input-format").unwrap();
        assert_eq!(cmd_noimg[if2 + 1], "text");
        assert!(cmd_noimg.contains(&"match this reference".to_string()));

        std::fs::remove_file(&tmp).ok();
    }

    #[test]
    fn build_command_mcp_config_included_when_file_exists() {
        // Create a real temp file so the exists() guard passes.
        let tmp = std::env::temp_dir().join("panda-mcp-config-test.json");
        std::fs::write(&tmp, r#"{"mcpServers":{}}"#).unwrap();

        // Point HOME at a dir that contains the file via a symlink-free path.
        // Simplest: just verify the logic by calling build_command in an env
        // where the file is at the expected location.  We do this by temporarily
        // setting HOME to a temp dir that has the right sub-path.
        let home_tmp = std::env::temp_dir().join("panda-mcp-config-home-test");
        let claude_dir = home_tmp.join(".claude");
        std::fs::create_dir_all(&claude_dir).unwrap();
        let cfg_path = claude_dir.join("panda-mcp-config.json");
        std::fs::write(&cfg_path, r#"{"mcpServers":{}}"#).unwrap();

        // Temporarily override HOME so home_dir() resolves to our temp dir.
        let prev_home = std::env::var_os("HOME");
        std::env::set_var("HOME", &home_tmp);

        let cfg = ClaudeRunConfig {
            prompt: "test".into(),
            workspace: PathBuf::from("/tmp/proj"),
            claude_session_id: None,
            model: None,
            use_panda_cloud: false,
            panda_token: None,
            panda_base_url: None,
            images: Vec::new(),
            phase: TurnPhase::Plan,
        };
        let cmd = build_command(&cfg);

        // Restore HOME before any assert so we don't poison other tests.
        match prev_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }

        let mc_pos = cmd.iter().position(|a| a == "--mcp-config");
        assert!(mc_pos.is_some(), "--mcp-config flag should be present");
        assert_eq!(cmd[mc_pos.unwrap() + 1], cfg_path.display().to_string());

        let _ = std::fs::remove_file(&cfg_path);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn build_command_mcp_config_omitted_when_file_absent() {
        let home_tmp = std::env::temp_dir().join("panda-mcp-config-absent-test");
        std::fs::create_dir_all(home_tmp.join(".claude")).unwrap();
        // Deliberately do NOT write panda-mcp-config.json here.

        let prev_home = std::env::var_os("HOME");
        std::env::set_var("HOME", &home_tmp);

        let cfg = ClaudeRunConfig {
            prompt: "test".into(),
            workspace: PathBuf::from("/tmp/proj"),
            claude_session_id: None,
            model: None,
            use_panda_cloud: false,
            panda_token: None,
            panda_base_url: None,
            images: Vec::new(),
            phase: TurnPhase::Plan,
        };
        let cmd = build_command(&cfg);

        match prev_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }

        assert!(
            !cmd.iter().any(|a| a == "--mcp-config"),
            "--mcp-config should be absent when config file does not exist"
        );
    }

    #[test]
    fn build_command_plan_phase_uses_bypass_mode_and_prompt() {
        let cfg = ClaudeRunConfig {
            prompt: "an esp32 enclosure".into(),
            workspace: PathBuf::from("/tmp/proj"),
            claude_session_id: None,
            model: None,
            use_panda_cloud: false,
            panda_token: None,
            panda_base_url: None,
            images: Vec::new(),
            phase: TurnPhase::Plan,
        };
        let cmd = build_command(&cfg);
        // Plan now runs with full permission so it can perform read-only
        // analysis (e.g. compute CoM from an existing STEP) to back the plan;
        // the prompt — not the CLI — bars writing source / generating parts.
        let pm = cmd.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(cmd[pm + 1], "bypassPermissions");
        // append-system-prompt is the planning prompt
        let sp = cmd.iter().position(|a| a == "--append-system-prompt").unwrap();
        assert!(cmd[sp + 1].starts_with(PLAN_SYSTEM_PROMPT));
        assert!(cmd[sp + 1].contains("PLANNING mode"));
        // The absolute workspace path is named so the model writes the project
        // INTO the dir Panda watches, not an invented one.
        assert!(cmd[sp + 1].contains("PROJECT WORKSPACE"));
        assert!(cmd[sp + 1].contains("/tmp/proj"));
        // The plan must carry the premium-design bar and a per-part Form clause.
        assert!(cmd[sp + 1].contains("AESTHETIC BAR"));
        assert!(cmd[sp + 1].contains("industrial-design"));
        assert!(cmd[sp + 1].contains("Form"));
    }

    #[test]
    fn build_command_implement_phase_uses_bypass_permissions_and_prompt() {
        let cfg = ClaudeRunConfig {
            prompt: "build it".into(),
            workspace: PathBuf::from("/tmp/proj"),
            claude_session_id: None,
            model: None,
            use_panda_cloud: false,
            panda_token: None,
            panda_base_url: None,
            images: Vec::new(),
            phase: TurnPhase::Implement,
        };
        let cmd = build_command(&cfg);
        let pm = cmd.iter().position(|a| a == "--permission-mode").unwrap();
        // Build phase must run unattended: acceptEdits still prompts for Bash,
        // which blocks the cadcode generator (a `python … cad` Bash command).
        assert_eq!(cmd[pm + 1], "bypassPermissions");
        let sp = cmd.iter().position(|a| a == "--append-system-prompt").unwrap();
        assert!(cmd[sp + 1].starts_with(IMPLEMENT_SYSTEM_PROMPT));
        assert!(cmd[sp + 1].contains("APPROVED"));
        // The build must write the project INTO the watched workspace dir, named
        // by its absolute path — otherwise artifacts land where Panda can't see
        // them and the project reads "No models yet".
        assert!(cmd[sp + 1].contains("PROJECT WORKSPACE"));
        assert!(cmd[sp + 1].contains("/tmp/proj"));
        // Build must hit the premium look and run a render-and-self-critique pass.
        assert!(cmd[sp + 1].contains("industrial-design"));
        assert!(cmd[sp + 1].contains("scripts/review"));
        // ...and make it assemble/work (component-integration discipline).
        assert!(cmd[sp + 1].contains("component-integration"));
    }

    #[test]
    fn sanitize_title_cleans_model_output() {
        // Surrounding quotes stripped, trailing period dropped.
        assert_eq!(sanitize_title("\"Phone Stand\".").as_deref(), Some("Phone Stand"));
        // Backticks + whitespace.
        assert_eq!(sanitize_title("  `Wall Hook`  ").as_deref(), Some("Wall Hook"));
        // First non-empty line wins (model preamble on later lines ignored).
        assert_eq!(
            sanitize_title("\n\nHoneycomb Tray\nHere is your title.").as_deref(),
            Some("Honeycomb Tray"),
        );
        // Word clamp to 8.
        assert_eq!(
            sanitize_title("one two three four five six seven eight nine ten").as_deref(),
            Some("one two three four five six seven eight"),
        );
        // "v2.0"-style dots survive; only a lone sentence-final period goes.
        assert_eq!(sanitize_title("Bracket v2.0").as_deref(), Some("Bracket v2.0"));
        // Nothing usable → None.
        assert_eq!(sanitize_title(""), None);
        assert_eq!(sanitize_title("   \n  "), None);
    }

    #[test]
    fn build_env_panda_cloud_uses_returned_base_url_and_auth_token() {
        let cfg = ClaudeRunConfig {
            prompt: "hi".into(),
            workspace: PathBuf::from("/tmp/proj"),
            claude_session_id: None,
            model: None,
            use_panda_cloud: true,
            panda_token: Some("ccr-tok-123".into()),
            panda_base_url: Some("https://api-panda.autonomous.ai".into()),
            images: Vec::new(),
            phase: TurnPhase::Plan,
        };
        let env = build_env(&cfg);
        let map: HashMap<String, String> = env.into_iter().collect();
        // The BE-issued base URL is used verbatim, and the `ccr-…` key is a
        // bearer token (ANTHROPIC_AUTH_TOKEN), not an API key.
        assert_eq!(
            map.get("ANTHROPIC_BASE_URL").map(String::as_str),
            Some("https://api-panda.autonomous.ai"),
        );
        assert_eq!(
            map.get("ANTHROPIC_AUTH_TOKEN").map(String::as_str),
            Some("ccr-tok-123"),
        );
        // We never set the API-key var on the panda path.
        assert!(!map.contains_key("ANTHROPIC_API_KEY"));
        // The self-updater is always disabled, cloud or not.
        assert_eq!(map.get("DISABLE_AUTOUPDATER").map(String::as_str), Some("1"));
    }

    #[test]
    fn build_env_panda_cloud_falls_back_to_compiled_proxy_url() {
        let cfg = ClaudeRunConfig {
            prompt: "hi".into(),
            workspace: PathBuf::from("/tmp/proj"),
            claude_session_id: None,
            model: None,
            use_panda_cloud: true,
            panda_token: Some("ccr-tok".into()),
            panda_base_url: None,
            images: Vec::new(),
            phase: TurnPhase::Plan,
        };
        let map: HashMap<String, String> = build_env(&cfg).into_iter().collect();
        assert_eq!(
            map.get("ANTHROPIC_BASE_URL").map(String::as_str),
            Some(crate::commands::app::PANDA_PROXY_URL),
        );
    }

    #[test]
    fn looks_like_auth_failure_flags_proxy_401() {
        // Anthropic-style 401 body the proxy returns for a revoked key.
        assert!(looks_like_auth_failure(
            "API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"}}"
        ));
        assert!(looks_like_auth_failure("Error: oauth token has expired"));
        assert!(looks_like_auth_failure("request failed: HTTP 401"));
        // Non-auth failures must NOT be flagged (they get the generic error).
        assert!(!looks_like_auth_failure(
            "Session ID already in use: 1234"
        ));
        assert!(!looks_like_auth_failure("spawn node ENOENT"));
        assert!(!looks_like_auth_failure("overloaded_error: 529"));
    }

    #[test]
    fn build_env_default_disables_autoupdater_and_background_tasks() {
        // Cloud OFF → no model env pushed → claude falls back to the host's own
        // auth (your ~/.claude login). This is the "local, no proxy" path.
        let cfg = ClaudeRunConfig {
            prompt: "hi".into(),
            workspace: PathBuf::from("/tmp/proj"),
            claude_session_id: None,
            model: None,
            use_panda_cloud: false,
            panda_token: None,
            panda_base_url: None,
            images: Vec::new(),
            phase: TurnPhase::Plan,
        };
        let map: HashMap<String, String> = build_env(&cfg).into_iter().collect();
        // Self-updater + background tasks stay disabled (foreground, no mid-turn
        // binary rewrite → 0xC0000142 on Windows).
        assert_eq!(map.get("DISABLE_AUTOUPDATER").map(String::as_str), Some("1"));
        assert_eq!(
            map.get("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS").map(String::as_str),
            Some("1")
        );
        assert!(!map.contains_key("ANTHROPIC_BASE_URL"));
        assert!(!map.contains_key("ANTHROPIC_AUTH_TOKEN"));
        assert!(!map.contains_key("ANTHROPIC_API_KEY"));
    }

    #[test]
    fn encode_cwd_matches_claude_code_convention() {
        // "/" → "-"; existing hyphens are preserved (map to themselves).
        let p = PathBuf::from("/Users/alice/auto/panda-wt-driver/projects/foo");
        let enc = encode_cwd(&p);
        assert_eq!(enc, "-Users-alice-auto-panda-wt-driver-projects-foo");
    }

    #[test]
    fn encode_cwd_rewrites_spaces_and_dots_like_claude() {
        // Regression: the packaged app's projects live under
        // `~/Library/Application Support/app.Panda.Panda/projects/<uuid>`.
        // Claude rewrites spaces AND dots to `-` (not just `/`). Encoding only
        // `/` produced a non-matching session dir, so `claude_session_exists`
        // returned false, the driver passed `--session-id` for an existing
        // session, claude died with "Session ID already in use", and the chat
        // hung on "PLANNING". This is the exact on-disk dir observed for a real
        // project (Claude Code 2.1.159).
        let p = PathBuf::from(
            "/Users/alice/Library/Application Support/app.Panda.Panda/projects/2f1df09b-468d-4a08-a6f2-03ee6fe40f92",
        );
        let enc = encode_cwd(&p);
        assert_eq!(
            enc,
            "-Users-alice-Library-Application-Support-app-Panda-Panda-projects-2f1df09b-468d-4a08-a6f2-03ee6fe40f92",
        );
    }

    #[test]
    fn strip_verbatim_prefix_matches_node_process_cwd() {
        // Regression: Windows `canonicalize()` returns `\\?\C:\…`, but Claude
        // Code's `process.cwd()` (which it encodes into the session dir name) has
        // no verbatim prefix. Encoding the canonical form gave `----C--Users-…`,
        // never matched Claude's `C--Users-…`, so the driver passed `--session-id`
        // for an existing session → "Session ID already in use".
        let drive = strip_verbatim_prefix(&PathBuf::from(r"\\?\C:\Users\PC\AppData\Roaming\Panda"));
        assert_eq!(drive, PathBuf::from(r"C:\Users\PC\AppData\Roaming\Panda"));
        assert_eq!(
            encode_cwd(&drive),
            "C--Users-PC-AppData-Roaming-Panda",
            "must match the dir Claude Code actually writes",
        );
        // UNC verbatim prefix collapses back to a plain UNC path.
        let unc = strip_verbatim_prefix(&PathBuf::from(r"\\?\UNC\server\share\proj"));
        assert_eq!(unc, PathBuf::from(r"\\server\share\proj"));
        // No prefix (the POSIX case) is left untouched.
        let posix = strip_verbatim_prefix(&PathBuf::from("/Users/alice/proj"));
        assert_eq!(posix, PathBuf::from("/Users/alice/proj"));
    }

    #[test]
    fn augmented_path_prepends_user_bin_dirs() {
        let path = augmented_path();
        let entries: Vec<PathBuf> = std::env::split_paths(&path).collect();
        let has_local_bin = entries
            .iter()
            .any(|p| p.ends_with(".local/bin") || p.ends_with(".local\\bin"));
        assert!(has_local_bin, "augmented PATH should include ~/.local/bin: {entries:?}");
        // Homebrew + system dirs present regardless of inherited PATH.
        #[cfg(not(target_os = "windows"))]
        {
            assert!(entries.iter().any(|p| p == &PathBuf::from("/opt/homebrew/bin")));
            assert!(entries.iter().any(|p| p == &PathBuf::from("/usr/bin")));
        }
        // npm-global dir present so an npm install of `claude` resolves.
        #[cfg(target_os = "windows")]
        if std::env::var_os("APPDATA").is_some() {
            assert!(
                entries.iter().any(|p| p.ends_with("npm")),
                "augmented PATH should include %APPDATA%\\npm: {entries:?}"
            );
        }
    }

    /// `resolve_claude` must follow an npm `claude.cmd` shim to the real
    /// `claude.exe` it launches — a `.cmd` can't carry our multi-line
    /// `--append-system-prompt` arg (direct spawn → "batch file arguments
    /// are invalid"; `cmd /C` → a newline ends the command), but a native
    /// exe takes arbitrary argv. Mirrors npm's actual shim layout.
    #[cfg(target_os = "windows")]
    #[test]
    fn follows_cmd_shim_to_real_exe() {
        let dir = tempfile::tempdir().unwrap();
        let exe_dir = dir.path().join("node_modules\\@anthropic-ai\\claude-code\\bin");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let exe = exe_dir.join("claude.exe");
        std::fs::write(&exe, b"").unwrap(); // existence is all the parser checks
        let cmd = dir.path().join("claude.cmd");
        std::fs::write(
            &cmd,
            "@ECHO off\r\nSET dp0=%~dp0\r\n\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*\r\n",
        )
        .unwrap();

        let resolved = real_exe_behind_cmd_wrapper(&cmd).expect("should follow shim to exe");
        assert_eq!(resolved, exe);

        // A plain .exe (not a shim) is returned untouched / ignored.
        assert!(real_exe_behind_cmd_wrapper(&exe).is_none());
    }

    #[test]
    fn resolve_claude_finds_binary_when_installed() {
        // Only meaningful when claude is installed somewhere on the
        // augmented PATH (dev machines / CI with Claude Code). Skip
        // otherwise so environments without it stay green.
        if which::which_in("claude", Some(augmented_path()), std::env::current_dir().unwrap())
            .is_err()
        {
            eprintln!("skipping: claude not installed on augmented PATH");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let resolved = resolve_claude(tmp.path());
        assert!(resolved.is_some(), "resolve_claude should find an installed claude");
        assert!(resolved.unwrap().is_absolute());
    }

    #[test]
    fn claude_session_exists_false_when_no_file() {
        let tmp = tempfile::tempdir().unwrap();
        // A random uuid almost certainly won't have a session file in
        // the host's ~/.claude/projects tree.
        let id = uuid::Uuid::new_v4().to_string();
        assert!(!claude_session_exists(tmp.path(), &id));
    }

    #[test]
    fn build_command_uses_session_id_on_first_turn() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = ClaudeRunConfig {
            prompt: "p".into(),
            workspace: tmp.path().to_path_buf(),
            claude_session_id: Some("00000000-0000-0000-0000-000000000001".into()),
            model: None,
            use_panda_cloud: false,
            panda_token: None,
            panda_base_url: None,
            images: Vec::new(),
            phase: TurnPhase::Plan,
        };
        let cmd = build_command(&cfg);
        assert!(cmd.contains(&"--session-id".to_string()));
        assert!(!cmd.contains(&"--resume".to_string()));
        assert!(cmd.contains(&"--model".to_string()));
        assert!(cmd.contains(&"opus".to_string()));
        // Effort is pinned low; quality comes from the review-fix loop.
        let effort = cmd.iter().position(|a| a == "--effort").expect("--effort");
        assert_eq!(cmd[effort + 1], "low");
    }

    // -- stream-json parser --------------------------------------------------

    fn parse_one(line: &str) -> Vec<ChatEvent> {
        let mut state = StreamState::default();
        parse_stream_line(line, "T1", &mut state)
    }

    #[test]
    fn parse_text_delta() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}}"#;
        let evs = parse_one(line);
        assert_eq!(evs.len(), 1);
        match &evs[0] {
            ChatEvent::TextDelta { turn_id, text } => {
                assert_eq!(turn_id, "T1");
                assert_eq!(text, "Hello ");
            }
            other => panic!("expected TextDelta, got {other:?}"),
        }
    }

    #[test]
    fn parse_thinking_delta() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"considering"}}}"#;
        let evs = parse_one(line);
        assert_eq!(evs.len(), 1);
        match &evs[0] {
            ChatEvent::ThinkingDelta { text, .. } => assert_eq!(text, "considering"),
            other => panic!("expected ThinkingDelta, got {other:?}"),
        }
    }

    #[test]
    fn parse_tool_use_start_then_end_pairs_name() {
        let mut state = StreamState::default();
        let asst = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_1","name":"Write","input":{"file_path":"main.py"}}]}}"#;
        let start = parse_stream_line(asst, "T1", &mut state);
        assert_eq!(start.len(), 1);
        match &start[0] {
            ChatEvent::ToolUseStart {
                tool, tool_use_id, ..
            } => {
                assert_eq!(tool, "Write");
                assert_eq!(tool_use_id, "tu_1");
            }
            other => panic!("expected ToolUseStart, got {other:?}"),
        }
        let user = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","is_error":false}]}}"#;
        let end = parse_stream_line(user, "T1", &mut state);
        assert_eq!(end.len(), 1);
        match &end[0] {
            ChatEvent::ToolUseEnd {
                tool,
                tool_use_id,
                ok,
                ..
            } => {
                assert_eq!(tool, "Write"); // looked up from pending_tools
                // The id round-trips so the UI can pair start↔end without
                // relying on the (collision-prone) tool name.
                assert_eq!(tool_use_id, "tu_1");
                assert!(*ok);
            }
            other => panic!("expected ToolUseEnd, got {other:?}"),
        }
    }

    #[test]
    fn tool_use_end_summarizes_result_output_as_line_count() {
        let mut state = StreamState::default();
        let asst = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_g","name":"Grep","input":{"pattern":"foo"}}]}}"#;
        let _ = parse_stream_line(asst, "T1", &mut state);
        // Array-of-text-blocks content with three lines.
        let user = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_g","is_error":false,"content":[{"type":"text","text":"a\nb\nc"}]}]}}"#;
        let end = parse_stream_line(user, "T1", &mut state);
        match &end[0] {
            ChatEvent::ToolUseEnd { result_summary, ok, .. } => {
                assert!(*ok);
                assert_eq!(result_summary.as_deref(), Some("3 lines"));
            }
            other => panic!("expected ToolUseEnd, got {other:?}"),
        }
    }

    #[test]
    fn tool_use_end_summary_handles_string_content_and_singular_and_empty() {
        // Bare-string content, single line → singular "1 line".
        let mut state = StreamState::default();
        let asst = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_r","name":"Read","input":{"file_path":"a.py"}}]}}"#;
        let _ = parse_stream_line(asst, "T1", &mut state);
        let user = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_r","is_error":false,"content":"only one line"}]}}"#;
        match &parse_stream_line(user, "T1", &mut state)[0] {
            ChatEvent::ToolUseEnd { result_summary, .. } => {
                assert_eq!(result_summary.as_deref(), Some("1 line"));
            }
            other => panic!("expected ToolUseEnd, got {other:?}"),
        }

        // Missing/empty content → no summary.
        let asst2 = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_e","name":"Bash","input":{"command":"true"}}]}}"#;
        let _ = parse_stream_line(asst2, "T1", &mut state);
        let user2 = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_e","is_error":false}]}}"#;
        match &parse_stream_line(user2, "T1", &mut state)[0] {
            ChatEvent::ToolUseEnd { result_summary, .. } => {
                assert_eq!(*result_summary, None);
            }
            other => panic!("expected ToolUseEnd, got {other:?}"),
        }
    }

    #[test]
    fn exit_plan_mode_emits_plan_proposed_not_tool_chip() {
        let mut state = StreamState::default();
        let asst = r##"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_p","name":"ExitPlanMode","input":{"plan":"# Plan\n- base\n- lid"}}]}}"##;
        let evs = parse_stream_line(asst, "T1", &mut state);
        assert_eq!(evs.len(), 1);
        match &evs[0] {
            ChatEvent::PlanProposed { turn_id, plan } => {
                assert_eq!(turn_id, "T1");
                assert!(plan.contains("base"));
                assert!(plan.contains("lid"));
            }
            other => panic!("expected PlanProposed, got {other:?}"),
        }
        assert!(state.plan_proposed, "plan_proposed flag must be set");
        // ExitPlanMode must not be tracked as a pending tool (no tool_result
        // is expected once the driver kills the child).
        assert!(state.pending_tools.is_empty());
    }

    #[test]
    fn exit_plan_mode_reads_plan_file_when_inline_empty() {
        // Newer Claude Code writes the plan to a file and may leave the inline
        // `plan` field empty; the driver must fall back to `planFilePath` so
        // the plan card is never blank.
        let tmp = tempfile::tempdir().unwrap();
        let plan_path = tmp.path().join("plan.md");
        std::fs::write(&plan_path, "# Plan from file\n- base\n- lid").unwrap();
        let asst = format!(
            r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","id":"tu_p","name":"ExitPlanMode","input":{{"plan":"","planFilePath":{}}}}}]}}}}"#,
            serde_json::to_string(&plan_path.to_string_lossy().to_string()).unwrap(),
        );
        let evs = parse_one(&asst);
        assert_eq!(evs.len(), 1);
        match &evs[0] {
            ChatEvent::PlanProposed { plan, .. } => {
                assert!(plan.contains("Plan from file"));
                assert!(plan.contains("base") && plan.contains("lid"));
            }
            other => panic!("expected PlanProposed, got {other:?}"),
        }
    }

    #[test]
    fn exit_plan_mode_prefers_inline_plan_over_file() {
        // When both are present, the inline `plan` wins — no file read needed.
        let asst = r##"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_p","name":"ExitPlanMode","input":{"plan":"# Inline plan","planFilePath":"/nonexistent/plan.md"}}]}}"##;
        let evs = parse_one(asst);
        match &evs[0] {
            ChatEvent::PlanProposed { plan, .. } => assert_eq!(plan, "# Inline plan"),
            other => panic!("expected PlanProposed, got {other:?}"),
        }
    }

    #[test]
    fn ask_user_question_becomes_panda_questions_fence_and_ends_turn() {
        // Newer Claude Code asks preference forks via the built-in
        // `AskUserQuestion` tool. The driver converts it to the
        // `panda-questions` fence the chat renders as choice chips, and flags
        // the turn so it ends for the user to answer.
        let mut state = StreamState::default();
        let asst = r##"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_q","name":"AskUserQuestion","input":{"questions":[{"question":"Orientation?","header":"Orient","multiSelect":false,"options":[{"label":"Portrait","description":"tall"},{"label":"Landscape","description":"wide"}]}]}}]}}"##;
        let evs = parse_stream_line(asst, "T1", &mut state);
        assert_eq!(evs.len(), 1);
        match &evs[0] {
            ChatEvent::TextDelta { text, .. } => {
                assert!(text.contains("```panda-questions"), "must emit the fence");
                assert!(text.contains("Orientation?"));
                assert!(text.contains("Portrait") && text.contains("Landscape"));
                // The fenced JSON the chat parses must be `{"questions":[...]}`.
                let start = text.find('{').unwrap();
                let end = text.rfind('}').unwrap();
                let json: serde_json::Value =
                    serde_json::from_str(&text[start..=end]).expect("valid questions JSON");
                assert!(json["questions"].is_array());
            }
            other => panic!("expected TextDelta with fence, got {other:?}"),
        }
        assert!(state.questions_asked, "questions_asked flag must be set");
        // Not tracked as a pending tool (no tool_result once the child is killed).
        assert!(state.pending_tools.is_empty());
    }

    #[test]
    fn ask_user_question_without_questions_is_dropped() {
        // An empty/malformed AskUserQuestion emits nothing and does not end the
        // turn (no choice chips to show).
        let mut state = StreamState::default();
        let asst = r##"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_q","name":"AskUserQuestion","input":{"questions":[]}}]}}"##;
        let evs = parse_stream_line(asst, "T1", &mut state);
        assert!(evs.is_empty());
        assert!(!state.questions_asked);
    }

    #[test]
    fn orphan_tool_result_for_intercepted_builtin_emits_no_tool_use_end() {
        // AskUserQuestion / ExitPlanMode are intercepted in `from_assistant`
        // and deliberately never registered as pending tools (no ToolUseStart).
        // When the model retries a malformed AskUserQuestion, the CLI sends an
        // error `tool_result` for a tool_use_id the driver never started. That
        // orphan end must be dropped — otherwise the chat reducer fabricates a
        // phantom, unnamed ("Working") error row, making the app look broken.
        let mut state = StreamState::default();
        let asst = r##"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_q","name":"AskUserQuestion","input":{"questions":[]}}]}}"##;
        let _ = parse_stream_line(asst, "T1", &mut state);
        let user = r##"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_q","is_error":true,"content":[{"type":"text","text":"need at least one question\nretry"}]}]}}"##;
        let end = parse_stream_line(user, "T1", &mut state);
        assert!(end.is_empty(), "orphan tool_result must not emit ToolUseEnd, got {end:?}");
    }

    #[test]
    fn recover_plan_picks_most_recent_substantial_assistant_text() {
        let long_a = "A".repeat(400);
        // The real plan, written as text in a later turn (with a newline that
        // must round-trip through JSON escaping).
        let plan = format!("# Fridge magnet plan\n{}", "B".repeat(400));
        let assistant_text = |text: &str| {
            serde_json::json!({
                "type": "assistant",
                "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}
            })
            .to_string()
        };
        let transcript = [
            r#"{"type":"user","message":{"role":"user","content":"what can you do?"}}"#.to_string(),
            assistant_text(&long_a),
            assistant_text(&plan),
            assistant_text("On it!"), // short chatter after the plan must not win
            "not json".to_string(),   // partial/blank lines are skipped
        ]
        .join("\n");
        assert_eq!(recover_plan_from_transcript(&transcript), plan);
    }

    #[test]
    fn recover_plan_falls_back_to_thinking_when_no_text_plan() {
        // Under autopilot the model plans entirely in the thinking channel and
        // exits plan mode without a text restatement — recover from thinking.
        let thinking = format!("Plan: {}", "C".repeat(400));
        let transcript = [
            r#"{"type":"user","message":{"role":"user","content":"make a bracket"}}"#.to_string(),
            serde_json::json!({
                "type": "assistant",
                "message": {"role": "assistant", "content": [
                    {"type": "thinking", "thinking": thinking, "signature": "sig"},
                    {"type": "text", "text": "On it!"} // short text must not win
                ]}
            })
            .to_string(),
        ]
        .join("\n");
        assert_eq!(recover_plan_from_transcript(&transcript), thinking);
    }

    #[test]
    fn recover_plan_prefers_text_over_thinking() {
        // When both a substantial text plan and substantial thinking exist, the
        // written text wins regardless of order.
        let thinking = "T".repeat(400);
        let plan = format!("# Real plan\n{}", "P".repeat(400));
        let transcript = serde_json::json!({
            "type": "assistant",
            "message": {"role": "assistant", "content": [
                {"type": "text", "text": plan},
                {"type": "thinking", "thinking": thinking, "signature": "sig"}
            ]}
        })
        .to_string();
        assert_eq!(recover_plan_from_transcript(&transcript), plan);
    }

    #[test]
    fn recover_plan_returns_empty_when_only_chatter() {
        let transcript = concat!(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}]}}"#,
            "\n",
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Your plan is ready."}]}}"#,
        );
        assert_eq!(recover_plan_from_transcript(transcript), "");
    }

    #[test]
    fn parse_tool_result_with_error_flips_ok() {
        let mut state = StreamState::default();
        let _ = parse_stream_line(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_x","name":"Bash","input":{}}]}}"#,
            "T1",
            &mut state,
        );
        let end = parse_stream_line(
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_x","is_error":true}]}}"#,
            "T1",
            &mut state,
        );
        match &end[0] {
            ChatEvent::ToolUseEnd { ok, .. } => assert!(!*ok),
            other => panic!("expected ToolUseEnd, got {other:?}"),
        }
    }

    #[test]
    fn assistant_text_block_emitted_when_no_deltas_streamed() {
        // No partial-message deltas arrived; the consolidated assistant
        // message carries the only copy of the response text.
        let mut state = StreamState::default();
        let asst = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Here is your hook."}]}}"#;
        let evs = parse_stream_line(asst, "T1", &mut state);
        assert_eq!(evs.len(), 1);
        match &evs[0] {
            ChatEvent::TextDelta { text, .. } => assert_eq!(text, "Here is your hook."),
            other => panic!("expected TextDelta, got {other:?}"),
        }
    }

    #[test]
    fn assistant_text_block_suppressed_after_deltas_streamed() {
        // Deltas streamed the text already; the consolidated assistant
        // message must NOT re-emit it (would duplicate the paragraph).
        let mut state = StreamState::default();
        let delta = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Here is your hook."}}}"#;
        let streamed = parse_stream_line(delta, "T1", &mut state);
        assert_eq!(streamed.len(), 1);

        let asst = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Here is your hook."}]}}"#;
        let consolidated = parse_stream_line(asst, "T1", &mut state);
        assert!(
            consolidated.is_empty(),
            "consolidated text must be suppressed when deltas already streamed, got {consolidated:?}"
        );
    }

    #[test]
    fn assistant_text_flag_resets_between_messages() {
        // A turn with a streamed-text message, then a later text-only
        // message whose deltas did NOT stream, must still emit the second.
        let mut state = StreamState::default();
        parse_stream_line(
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"first"}}}"#,
            "T1",
            &mut state,
        );
        // Consolidated for message 1 (suppressed) resets the per-message flag.
        let m1 = parse_stream_line(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"first"}]}}"#,
            "T1",
            &mut state,
        );
        assert!(m1.is_empty());
        // Message 2 has no deltas — its consolidated text must emit.
        let m2 = parse_stream_line(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"second"}]}}"#,
            "T1",
            &mut state,
        );
        assert_eq!(m2.len(), 1);
        match &m2[0] {
            ChatEvent::TextDelta { text, .. } => assert_eq!(text, "second"),
            other => panic!("expected TextDelta, got {other:?}"),
        }
    }

    #[test]
    fn result_fallback_emits_only_when_no_text_emitted() {
        // Turn produced no text at all → the `result` string is surfaced.
        let mut state = StreamState::default();
        let line = r#"{"type":"result","subtype":"success","result":"All done."}"#;
        let evs = parse_stream_line(line, "T1", &mut state);
        assert_eq!(evs.len(), 1);
        match &evs[0] {
            ChatEvent::TextDelta { text, .. } => assert_eq!(text, "All done."),
            other => panic!("expected TextDelta, got {other:?}"),
        }

        // When text already streamed, the result fallback stays silent.
        let mut state2 = StreamState::default();
        parse_stream_line(
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"streamed"}}}"#,
            "T1",
            &mut state2,
        );
        let evs2 = parse_stream_line(line, "T1", &mut state2);
        assert!(evs2.is_empty(), "result fallback must not double text, got {evs2:?}");
    }

    #[test]
    fn parse_garbage_line_returns_empty() {
        assert!(parse_one("not json at all").is_empty());
        assert!(parse_one("").is_empty());
        assert!(parse_one("   ").is_empty());
    }

    #[test]
    fn parse_unknown_type_returns_empty() {
        // result/system/rate_limit_event etc. all collapse to nothing
        // at the parser level; turn_end is emitted by the driver, not
        // the parser.
        assert!(parse_one(r#"{"type":"result","stop_reason":"end_turn"}"#).is_empty());
        assert!(parse_one(r#"{"type":"system","subtype":"init","model":"opus"}"#).is_empty());
    }

    // -- spawn_turn smoke (requires claude on PATH) --------------------------

    /// Smoke: a fake "claude" can be invoked. We don't run real claude
    /// here (variable, slow, costs subscription quota); instead we
    /// assert that when the binary isn't on PATH, spawn_turn emits
    /// TurnStart + Error + TurnEnd and returns DriverError::NotInstalled.
    #[tokio::test]
    async fn spawn_turn_emits_not_installed_when_claude_missing() {
        // Sandbox HOME + PATH so neither ~/.local/bin nor the inherited
        // PATH can supply a real `claude`. augmented_path() still searches
        // fixed system dirs (/usr/bin, /opt/homebrew/bin); if a real claude
        // lives there we can't simulate "missing", so skip in that case.
        let tmp = tempfile::tempdir().unwrap();
        let home_tmp = tempfile::tempdir().unwrap();
        let old_path = std::env::var_os("PATH").unwrap_or_default();
        let old_home = std::env::var_os("HOME");
        std::env::set_var("PATH", tmp.path());
        std::env::set_var("HOME", home_tmp.path());

        if resolve_claude(tmp.path()).is_some() {
            std::env::set_var("PATH", &old_path);
            if let Some(h) = &old_home {
                std::env::set_var("HOME", h);
            }
            eprintln!("skipping: claude resolvable from a system dir");
            return;
        }

        let workspace = tempfile::tempdir().unwrap();
        let events = std::sync::Arc::new(parking_lot::Mutex::new(Vec::<ChatEvent>::new()));
        let events_clone = events.clone();
        let cancel = CancellationToken::new();
        let res = spawn_turn(
            workspace.path(),
            uuid::Uuid::nil(),
            "hello",
            &[],
            "T-smoke",
            TurnPhase::Plan,
            move |e| events_clone.lock().push(e),
            cancel,
        )
        .await;

        // Restore env first so the test runner / later tests are unaffected.
        std::env::set_var("PATH", old_path);
        if let Some(h) = &old_home {
            std::env::set_var("HOME", h);
        }

        assert!(matches!(res, Err(DriverError::NotInstalled)));
        let evs = events.lock();
        assert!(matches!(evs.first(), Some(ChatEvent::TurnStart { .. })));
        assert!(evs
            .iter()
            .any(|e| matches!(e, ChatEvent::Error { message, .. } if message.contains("claude"))));
        assert!(matches!(evs.last(), Some(ChatEvent::TurnEnd { .. })));
    }

    /// Optional live smoke: if `claude` is on PATH, `claude --version`
    /// exits 0. Skip otherwise so CI on environments without Claude
    /// Code stays green.
    #[test]
    fn live_claude_version_smoke() {
        let cwd = std::env::current_dir().unwrap();
        let Some(claude) = resolve_claude(&cwd) else {
            eprintln!("skipping: claude not resolvable");
            return;
        };
        // Spawn the resolved path directly — std runs a Windows `claude.cmd`
        // wrapper for us. (The old bare `Command::new("claude")` failed with
        // "program not found" because CreateProcess only appends `.exe`.)
        let out = std::process::Command::new(&claude)
            .arg("--version")
            .output()
            .expect("claude --version should run when resolvable");
        assert!(out.status.success(), "claude --version should exit 0");
    }

    /// Optional live end-to-end of project auto-naming: real `claude` generates
    /// a title and `set_name_if_placeholder` upgrades a placeholder
    /// `project.json` — exactly what `spawn_turn` does on the first plan turn,
    /// and the field the switcher renders. Ignored by default (costs claude
    /// quota + network); run with
    /// `cargo test --manifest-path desktop/src-tauri/Cargo.toml -- --ignored --nocapture live_autoname`.
    #[tokio::test]
    #[ignore]
    async fn live_autoname_upgrades_placeholder_project() {
        let cwd = std::env::current_dir().unwrap();
        let Some(claude) = resolve_claude(&cwd) else {
            eprintln!("skipping: claude not resolvable");
            return;
        };
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("027cd40f-c864-49d9-a1cc-6854342a5192");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("project.json"),
            r#"{"id":"027cd40f-c864-49d9-a1cc-6854342a5192","name":"New project","created_at":1,"updated_at":2}"#,
        )
        .unwrap();

        let title = generate_project_title(
            claude,
            "a phone stand for my desk that holds my iphone at an angle".to_string(),
        )
        .await
        .expect("claude should return a title");
        eprintln!("generated title: {title:?}");

        assert!(
            crate::commands::project::set_name_if_placeholder(&dir, &title).await,
            "placeholder should be upgraded"
        );
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("project.json")).unwrap()).unwrap();
        let name = json["name"].as_str().unwrap();
        eprintln!("project.json name is now: {name:?}");
        assert_ne!(name, "New project");
        assert!(!name.is_empty());
    }

    /// Optional live end-to-end of a real PLAN turn through `spawn_turn` —
    /// the exact path that broke on Windows. It spawns the resolved `claude`
    /// with the multi-line `--append-system-prompt`; a `.cmd`/`cmd /C` route
    /// fails here ("Input must be provided ..." / "batch file arguments are
    /// invalid"), while the real `.exe` resolved by `resolve_claude` does
    /// not. Asserts the turn produces content and no arg-passing error.
    /// Ignored by default (costs quota + network); run with:
    /// `cargo test --manifest-path desktop/src-tauri/Cargo.toml -- --ignored --nocapture live_plan_turn`
    #[tokio::test]
    #[ignore]
    async fn live_plan_turn_passes_multiline_system_prompt() {
        let workspace = tempfile::tempdir().unwrap();
        if resolve_claude(workspace.path()).is_none() {
            eprintln!("skipping: claude not resolvable");
            return;
        }
        let events = std::sync::Arc::new(parking_lot::Mutex::new(Vec::<ChatEvent>::new()));
        let sink = events.clone();
        let res = spawn_turn(
            workspace.path(),
            uuid::Uuid::new_v4(), // fresh session so reruns don't collide
            "design a simple 20mm cube keychain with a 4mm hole",
            &[],
            "T-live-plan",
            TurnPhase::Plan,
            move |e| sink.lock().push(e),
            CancellationToken::new(),
        )
        .await;
        assert!(res.is_ok(), "spawn_turn returned Err: {res:?}");

        let evs = events.lock();
        for e in evs.iter() {
            if let ChatEvent::Error { message, .. } = e {
                assert!(
                    !message.contains("Input must be provided")
                        && !message.contains("batch file arguments are invalid")
                        && !message.contains("failed to spawn"),
                    "arg-passing regression: {message:?}"
                );
            }
        }
        let produced_content = evs.iter().any(|e| {
            matches!(
                e,
                ChatEvent::TextDelta { .. }
                    | ChatEvent::ThinkingDelta { .. }
                    | ChatEvent::ToolUseStart { .. }
                    | ChatEvent::PlanProposed { .. }
            )
        });
        assert!(produced_content, "no content from claude; events: {evs:?}");
        assert!(matches!(evs.last(), Some(ChatEvent::TurnEnd { .. })));
    }
}
