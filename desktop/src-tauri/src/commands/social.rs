//! Copy a finished project to panda-social via the design-import API.
//!
//! Contract: `docs/design-import-api.md` in `autonomous-ecm/panda-social-backend`.
//! `POST /api/v1/designs/import` ingests an **already-finished design folder**
//! (a `.py`/`project.json` design plus a resolvable cover image) as a zip and
//! returns the created design synchronously. Nothing AI runs server-side — the
//! client holds no infrastructure secrets, only a user bearer token.
//!
//! This module is the client half: it zips the project workspace (keeping the
//! `<stem>_review/` render PNGs the API uses for the cover, dropping local-only
//! cruft), POSTs it as `multipart/form-data`, and records the result so a given
//! project is imported **once** — not re-published on every subsequent edit.
//!
//! The single entry point is [`maybe_import_after_build`], called best-effort
//! from the chat driver after a build+review settles. It never fails a turn.

use std::io::{Cursor, Write};
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;

use crate::ipc::types::PublishResponse;
use crate::ipc::{IpcError, IpcResult};

/// Base endpoint for the design-import API (see the curl example in the doc).
const IMPORT_URL: &str = "https://panda-social-api.autonomous.ai/api/v1/designs/import";

/// Token-refresh endpoint: `POST {"refresh_token"}` → `{access_token, refresh_token}`.
const REFRESH_URL: &str = "https://panda-social-api.autonomous.ai/api/v1/auth/refresh";

/// Optional compiled-in **refresh** JWT fallback. When left as the placeholder
/// (the default), there is no baked-in token: [`resolve_refresh_token`] returns
/// `None` unless the user has saved one via [`social_set_token`], which makes the
/// Publish flow prompt for a token. Set this to a real refresh token only if you
/// want a shipped default; the user-saved token always takes precedence.
const REFRESH_TOKEN: &str = "REPLACE_WITH_PANDA_SOCIAL_REFRESH_TOKEN";

/// Publish state for imported designs. `draft` keeps them owner-only; flip to
/// `public` to land on the feed immediately (the API's own default).
const IMPORT_STATUS: &str = "draft";

/// Cloudflare cuts responses slower than ~100 s; the repo push + CDN upload can
/// take tens of seconds, so give the client a generous ceiling above that.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Marker written into `<workspace>/.panda/` after a successful import so we
/// don't create a duplicate design on the next build/edit turn.
const IMPORT_MARKER_REL: &str = ".panda/social-import.json";

/// User-provided auth, persisted to `<app-data>/panda-social-auth.json`. Holds
/// the long-lived refresh token the user pastes via [`social_set_token`].
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredAuth {
    refresh_token: String,
}

/// Path to the persisted auth file.
fn auth_path() -> std::path::PathBuf {
    crate::paths::app_data_dir().join("panda-social-auth.json")
}

/// The refresh token the user saved, if any.
fn stored_refresh_token() -> Option<String> {
    let bytes = std::fs::read(auth_path()).ok()?;
    let auth: StoredAuth = serde_json::from_slice(&bytes).ok()?;
    let t = auth.refresh_token.trim().to_string();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

/// Persist the user's refresh token (overwrites any previous one).
fn store_refresh_token(refresh: &str) -> std::io::Result<()> {
    let path = auth_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let auth = StoredAuth {
        refresh_token: refresh.to_string(),
    };
    let bytes = serde_json::to_vec_pretty(&auth)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    std::fs::write(path, bytes)
}

/// Forget the saved token (sign out / test the prompt path). Absent file is ok.
fn clear_stored_token() -> std::io::Result<()> {
    match std::fs::remove_file(auth_path()) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Resolve the effective refresh token: the user-saved one first, else the
/// compiled-in default (skipped while it's the placeholder / empty). `None`
/// means "no token — the UI must prompt for one".
fn resolve_refresh_token() -> Option<String> {
    if let Some(t) = stored_refresh_token() {
        return Some(t);
    }
    let baked = REFRESH_TOKEN.trim();
    if baked.is_empty() || baked == "REPLACE_WITH_PANDA_SOCIAL_REFRESH_TOKEN" {
        None
    } else {
        Some(baked.to_string())
    }
}

/// Accept either a raw refresh-token JWT or the web app's auth-state JSON blob
/// (`{"state":{"refreshToken":…}}`) and pull the refresh token out of it.
fn parse_refresh_token_input(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    // JSON blob — dig out the refresh token from the common shapes.
    if s.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(s) {
            const PATHS: &[&[&str]] = &[
                &["state", "refreshToken"],
                &["state", "refresh_token"],
                &["refreshToken"],
                &["refresh_token"],
            ];
            for path in PATHS {
                let mut cur = &v;
                let mut ok = true;
                for key in *path {
                    match cur.get(key) {
                        Some(next) => cur = next,
                        None => {
                            ok = false;
                            break;
                        }
                    }
                }
                if ok {
                    if let Some(tok) = cur.as_str() {
                        if is_jwt(tok) {
                            return Some(tok.to_string());
                        }
                    }
                }
            }
            return None;
        }
    }
    // Bare JWT.
    if is_jwt(s) {
        Some(s.to_string())
    } else {
        None
    }
}

/// Loose JWT shape check: three dot-separated segments, `eyJ…` header.
fn is_jwt(s: &str) -> bool {
    s.split('.').count() == 3 && s.starts_with("eyJ")
}

/// Why we couldn't get an access token — the caller turns both into a
/// `SOCIAL_TOKEN_REQUIRED` error so the UI prompts for a (new) token.
enum AuthError {
    /// No token configured at all.
    Missing,
    /// A token exists but the refresh endpoint rejected it (expired/invalid).
    Rejected(String),
}

/// Resolve a refresh token and trade it for a fresh access token.
async fn obtain_access_token(client: &reqwest::Client) -> Result<String, AuthError> {
    let refresh = resolve_refresh_token().ok_or(AuthError::Missing)?;
    fetch_access_token(client, &refresh)
        .await
        .map_err(|e| AuthError::Rejected(e.to_string()))
}

/// reqwest client with the shared import timeout.
fn http_client() -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()?)
}

/// Exchange the refresh token for a fresh, short-lived access token
/// (`POST /auth/refresh`). Returns the `access_token`; the rotated refresh token
/// in the response is ignored (the hardcoded one stays valid until its `exp`).
async fn fetch_access_token(client: &reqwest::Client, refresh: &str) -> anyhow::Result<String> {
    #[derive(Deserialize)]
    struct TokenResp {
        #[serde(default)]
        access_token: String,
    }
    let resp = client
        .post(REFRESH_URL)
        .json(&serde_json::json!({ "refresh_token": refresh }))
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("token refresh returned {status}: {}", body.trim());
    }
    let parsed: TokenResp = resp.json().await?;
    if parsed.access_token.is_empty() {
        anyhow::bail!("token refresh returned no access_token");
    }
    Ok(parsed.access_token)
}

/// The subset of the `201 Created` design-detail response we persist as
/// provenance in the import marker. Everything else in the body is ignored.
#[derive(Debug, Clone, Deserialize)]
struct ImportedDesign {
    id: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    project_url: String,
}

/// On-disk record of a completed import, written to [`IMPORT_MARKER_REL`].
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ImportMarker {
    design_id: String,
    slug: String,
    title: String,
    status: String,
    project_url: String,
    imported_at: i64,
}

/// Best-effort: copy the just-built project to panda-social. Safe to call after
/// every build — it silently does nothing unless all of these hold:
///
/// * a real access token is configured (not the placeholder),
/// * the project has a generated model on disk (a root-level `.step`/`.stl`),
/// * a render PNG exists for the cover (`<stem>_review/…png`),
/// * the project hasn't already been imported (no import marker),
///
/// and it never propagates an error: a failed upload just logs and leaves the
/// project un-imported (a later build retries). The heavy work (zip + a
/// ≤120 s HTTP upload) runs off the async reactor via `spawn_blocking` for the
/// zip; callers typically fire-and-forget this on a detached task so the chat
/// turn doesn't wait on it.
pub async fn maybe_import_after_build(workspace: &Path) {
    let name = workspace
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    log_line(&format!("evaluating project {name}"));

    if resolve_refresh_token().is_none() {
        log_line("skip: no token configured (publish once from the app to sign in)");
        return;
    }
    if !has_model(workspace) {
        log_line(&format!("skip {name}: no .step/.stl model at workspace root"));
        return;
    }
    if !has_cover(workspace) {
        // The import needs a resolvable cover (400 otherwise); it comes from the
        // `<stem>_review/` render PNGs. If the review pass didn't render any, skip
        // rather than upload a zip doomed to be rejected — a later build retries.
        log_line(&format!("skip {name}: no render PNG for a cover yet"));
        return;
    }
    if workspace.join(IMPORT_MARKER_REL).exists() {
        log_line(&format!("skip {name}: already imported (marker present)"));
        return;
    }

    let client = match http_client() {
        Ok(c) => c,
        Err(e) => {
            log_line(&format!("skip {name}: http client build failed: {e:?}"));
            return;
        }
    };
    let access = match obtain_access_token(&client).await {
        Ok(a) => a,
        Err(AuthError::Missing) => {
            log_line(&format!("skip {name}: no token configured"));
            return;
        }
        Err(AuthError::Rejected(msg)) => {
            log_line(&format!("skip {name}: token rejected ({msg})"));
            return;
        }
    };

    log_line(&format!("importing {name} → {IMPORT_URL} (status={IMPORT_STATUS})"));
    match import(workspace, &access, &client).await {
        Ok(design) => {
            if let Err(e) = write_marker(workspace, &design) {
                log_line(&format!("{name}: import ok but marker write failed: {e:?}"));
            }
            log_line(&format!(
                "imported {name} as design {} (slug={}, status={}) {}",
                design.id, design.slug, design.status, design.project_url
            ));
        }
        Err(ImportError::Unauthorized(code)) => {
            // Token is bad — forget it so the next manual publish prompts.
            log_line(&format!("import for {name} got {code} — clearing saved token"));
            let _ = clear_stored_token();
        }
        Err(e) => {
            // Best-effort — a later build will retry (no marker was written).
            log_line(&format!("import FAILED for {name}: {e:?}"));
        }
    }
}

/// IPC: publish the given project to panda-social on demand (the "Publish"
/// button). Resolves the project's workspace, then delegates to
/// [`publish_project`]. Unlike the silent post-build hook, this returns a typed
/// result so the UI can report success, the design URL, or a clear error.
#[tauri::command]
pub async fn project_publish(id: String) -> IpcResult<PublishResponse> {
    crate::commands::project::validate_id(&id)?;
    let workspace = crate::paths::project_root(&id);
    if !workspace.exists() {
        return Err(IpcError::new("PROJECT_NOT_FOUND", format!("no project {id}")));
    }
    publish_project(&workspace).await
}

/// IPC: whether a panda-social token is configured (stored or baked-in). The UI
/// uses this to decide whether the Publish flow will need to prompt first.
#[tauri::command]
pub fn social_has_token() -> bool {
    resolve_refresh_token().is_some()
}

/// IPC: save the token the user pasted into the prompt. Accepts a bare refresh
/// JWT or the web app's auth-state JSON, validates it against the refresh
/// endpoint (so a bad/expired/access-only token is rejected up front), then
/// persists it for future publishes.
#[tauri::command]
pub async fn social_set_token(token: String) -> IpcResult<()> {
    let refresh = parse_refresh_token_input(&token).ok_or_else(|| {
        IpcError::new(
            "SOCIAL_INVALID_TOKEN",
            "Couldn't find a token in that text — paste your refresh-token JWT or the sign-in JSON",
        )
    })?;
    let client = http_client().map_err(|e| IpcError::new("SOCIAL_INVALID_TOKEN", format!("{e}")))?;
    // Validate before persisting: a valid refresh token yields an access token.
    fetch_access_token(&client, &refresh).await.map_err(|e| {
        IpcError::new(
            "SOCIAL_INVALID_TOKEN",
            format!("panda-social rejected that token ({e}) — make sure it's a current refresh token"),
        )
    })?;
    store_refresh_token(&refresh)
        .map_err(|e| IpcError::new("SOCIAL_STORE_FAILED", format!("could not save token: {e}")))?;
    log_line("saved a new panda-social token");
    Ok(())
}

/// IPC: forget the saved token (sign out). Baked-in default, if any, still applies.
#[tauri::command]
pub fn social_clear_token() -> IpcResult<()> {
    clear_stored_token()
        .map_err(|e| IpcError::new("SOCIAL_STORE_FAILED", format!("could not clear token: {e}")))?;
    log_line("cleared the saved panda-social token");
    Ok(())
}

/// Publish a project workspace, returning the created (or already-existing)
/// design. Maps every skip/failure reason to a typed [`IpcError`] the UI can act
/// on. Idempotent: if a marker already records an import, the existing design is
/// returned (`already_published = true`) rather than creating a duplicate.
pub async fn publish_project(workspace: &Path) -> IpcResult<PublishResponse> {
    let name = workspace
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();

    // Already published → return the existing design without needing a token.
    if let Some(existing) = read_marker(workspace) {
        log_line(&format!("publish {name}: already imported → returning existing"));
        return Ok(PublishResponse {
            design_id: existing.design_id,
            slug: existing.slug,
            title: existing.title,
            status: existing.status,
            project_url: existing.project_url,
            already_published: true,
        });
    }
    if !has_model(workspace) {
        return Err(IpcError::new(
            "SOCIAL_NO_MODEL",
            "build a model before publishing",
        ));
    }
    if !has_cover(workspace) {
        return Err(IpcError::new(
            "SOCIAL_NO_COVER",
            "no preview render yet to use as the cover — try again after the model finishes rendering",
        ));
    }

    // Obtain an access token; a missing or rejected token becomes
    // SOCIAL_TOKEN_REQUIRED so the UI prompts the user to (re)enter one.
    let client = http_client().map_err(|e| IpcError::new("SOCIAL_IMPORT_FAILED", format!("{e}")))?;
    let access = match obtain_access_token(&client).await {
        Ok(a) => a,
        Err(AuthError::Missing) => {
            return Err(IpcError::new(
                "SOCIAL_TOKEN_REQUIRED",
                "Sign in to panda-social — paste your access token to publish",
            ));
        }
        Err(AuthError::Rejected(msg)) => {
            log_line(&format!("publish {name}: token rejected ({msg}) — clearing saved token"));
            let _ = clear_stored_token();
            return Err(IpcError::new(
                "SOCIAL_TOKEN_REQUIRED",
                "Your panda-social session expired — paste a new token to publish",
            ));
        }
    };

    log_line(&format!("publish {name}: importing → {IMPORT_URL} (status={IMPORT_STATUS})"));
    let design = match import(workspace, &access, &client).await {
        Ok(d) => d,
        // 401/403 on the upload itself → the token is bad; forget it and prompt.
        Err(ImportError::Unauthorized(code)) => {
            log_line(&format!("publish {name}: upload got {code} — clearing saved token"));
            let _ = clear_stored_token();
            return Err(IpcError::new(
                "SOCIAL_TOKEN_REQUIRED",
                "panda-social rejected your session — paste a new token to publish",
            ));
        }
        Err(e) => {
            log_line(&format!("publish {name}: FAILED {e:?}"));
            return Err(IpcError::new("SOCIAL_IMPORT_FAILED", format!("{e:?}")));
        }
    };
    let _ = write_marker(workspace, &design);
    log_line(&format!(
        "publish {name}: ok → design {} (slug={})",
        design.id, design.slug
    ));
    Ok(PublishResponse {
        design_id: design.id,
        slug: design.slug,
        title: design.title,
        status: design.status,
        project_url: design.project_url,
        already_published: false,
    })
}

/// True once cadpy has written a printable model to the workspace root. The
/// primary artifact is named after the project stem (e.g. `<project-id>.stl`),
/// **not** the literal `model.stl` — so match any top-level `.step`/`.stl`
/// (part meshes live under `<stem>_parts/`, so a root-level hit is the primary).
fn has_model(workspace: &Path) -> bool {
    std::fs::read_dir(workspace)
        .map(|rd| {
            rd.filter_map(Result::ok).any(|e| {
                e.path()
                    .extension()
                    .is_some_and(|x| x.eq_ignore_ascii_case("stl") || x.eq_ignore_ascii_case("step"))
            })
        })
        .unwrap_or(false)
}

/// Append a line to the central import log (`<app-data>/social-import.log`) and
/// stderr. The log file makes imports inspectable even when the app is launched
/// from Finder/Dock, where stderr goes nowhere (see the launch-PATH footgun).
fn log_line(msg: &str) {
    eprintln!("panda-social: {msg}");
    let path = crate::paths::app_data_dir().join("social-import.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write as _;
        let _ = writeln!(f, "[{}] {msg}", now_millis());
    }
}

/// Write the exact upload payload to `<app-data>/social-import-last.zip` for
/// inspection. Best-effort — logs the path or the failure, never propagates.
fn dump_last_zip(zip_bytes: &[u8]) {
    let path = crate::paths::app_data_dir().join("social-import-last.zip");
    match std::fs::write(&path, zip_bytes) {
        Ok(()) => log_line(&format!("wrote upload payload to {}", path.display())),
        Err(e) => log_line(&format!("could not write payload dump: {e:?}")),
    }
}

/// True if the zip will carry at least one render PNG the API can turn into a
/// cover — a `.png` directly inside a `review/`, `<stem>_review/`, or `renders/`
/// directory (any depth), the same locations the server scans. Mirrors the
/// keep-list in [`zip_workspace`]/[`in_skipped_dir`]; if this is true the upload
/// has a resolvable cover.
fn has_cover(workspace: &Path) -> bool {
    WalkDir::new(workspace)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .any(|e| {
            let is_png = e
                .path()
                .extension()
                .is_some_and(|x| x.eq_ignore_ascii_case("png"));
            let in_cover_dir = e.path().parent().and_then(Path::file_name).is_some_and(|d| {
                let d = d.to_string_lossy();
                d == "review" || d == "renders" || d.ends_with("_review")
            });
            is_png && in_cover_dir
        })
}

/// Why an import failed. `Unauthorized` (401/403) means the token is
/// bad/expired — the caller turns it into `SOCIAL_TOKEN_REQUIRED` so the UI
/// re-prompts; everything else is a plain `SOCIAL_IMPORT_FAILED`.
enum ImportError {
    Unauthorized(u16),
    Other(anyhow::Error),
}

impl ImportError {
    fn other<E: Into<anyhow::Error>>(e: E) -> Self {
        ImportError::Other(e.into())
    }
}

impl std::fmt::Debug for ImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ImportError::Unauthorized(code) => write!(f, "unauthorized ({code})"),
            ImportError::Other(e) => write!(f, "{e:?}"),
        }
    }
}

/// Zip the workspace and POST it to the import API with an already-obtained
/// access token. Returns the created design on `201`; a `401`/`403` becomes
/// [`ImportError::Unauthorized`], any other non-201 an [`ImportError::Other`].
async fn import(
    workspace: &Path,
    access: &str,
    client: &reqwest::Client,
) -> Result<ImportedDesign, ImportError> {
    let ws = workspace.to_path_buf();
    let zip_bytes = tokio::task::spawn_blocking(move || zip_workspace(&ws))
        .await
        .map_err(ImportError::other)?
        .map_err(ImportError::other)?;

    // Save the exact bytes we're about to upload so the payload can be inspected
    // (`unzip -l <app-data>/social-import-last.zip`). Overwrites each publish;
    // best-effort — a dump failure never blocks the import.
    dump_last_zip(&zip_bytes);

    let part = reqwest::multipart::Part::bytes(zip_bytes)
        .file_name("design.zip")
        .mime_str("application/zip")
        .map_err(ImportError::other)?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("status", IMPORT_STATUS);

    let resp = client
        .post(IMPORT_URL)
        .bearer_auth(access)
        .multipart(form)
        .send()
        .await
        .map_err(ImportError::other)?;

    let status = resp.status();
    if status == reqwest::StatusCode::CREATED {
        resp.json::<ImportedDesign>().await.map_err(ImportError::other)
    } else if status == reqwest::StatusCode::UNAUTHORIZED
        || status == reqwest::StatusCode::FORBIDDEN
    {
        Err(ImportError::Unauthorized(status.as_u16()))
    } else {
        let body = resp.text().await.unwrap_or_default();
        Err(ImportError::Other(anyhow::anyhow!(
            "import API returned {status}: {}",
            body.trim()
        )))
    }
}

/// The zip carries the **whole project** — every file under the workspace — with
/// only this minimal deny-list of directories excluded, because each would
/// either bloat the upload past the API's ~50 MB window or is meaningless to a
/// published design:
///
/// * `.panda` — Panda's own snapshot/version store; it holds a full copy of the
///   model for *every* saved version (and the server does not strip it), so
///   including it multiplies the zip size and pollutes the design tree.
/// * `.git` — repository internals, large and irrelevant.
/// * dependency/build caches — `node_modules`, `.venv`/`venv`, `__pycache__`,
///   `__MACOSX`, `*.egg-info` — never part of the design.
///
/// Everything else is included: all source, `project.json`, `spec.md`, the
/// model `.step`/`.stl`/`.step.json`, every render, `inputs/`, `.gcode`, `.3mf`,
/// etc. (The server drops its own redundant bits — `inputs/`, `__pycache__`,
/// `*.jsonl` — on ingest, but sending them does no harm.)
const SKIP_DIRS: &[&str] = &[
    ".git",
    ".panda",
    "__pycache__",
    "__MACOSX",
    ".venv",
    "venv",
    "node_modules",
];

/// True if any path component is a directory we skip wholesale (also covers
/// `*.egg-info`).
fn in_skipped_dir(rel: &Path) -> bool {
    rel.components().any(|c| {
        let name = c.as_os_str().to_string_lossy();
        SKIP_DIRS.contains(&name.as_ref()) || name.ends_with(".egg-info")
    })
}

/// True only for files that must never be uploaded regardless of "publish
/// everything": OS cruft, compiled Python, and anything secret-shaped. Real
/// project content (source, models, renders, gcode, 3mf, inputs, transcripts)
/// is always included.
fn skip_file(name: &str) -> bool {
    name == ".DS_Store"
        || name == ".env"
        || name.starts_with(".env.")
        || name.ends_with(".pyc")
        || name.ends_with(".pem")
        || name.ends_with(".key")
        || name.starts_with("secrets.")
}

/// Build a flat-layout zip of the workspace in memory. Entries are stored at
/// paths relative to the workspace root (e.g. `main.py`,
/// `model_review/_assembled.png`) — the "flat"/"wrapper" layout the API
/// accepts. Crucially, `<stem>_review/` render PNGs are kept: the API resolves
/// the design cover from them, and a design with no cover is rejected (400).
fn zip_workspace(workspace: &Path) -> anyhow::Result<Vec<u8>> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let mut file_count = 0usize;
    let mut raw_bytes = 0u64;
    for entry in WalkDir::new(workspace).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let Ok(rel) = path.strip_prefix(workspace) else {
            continue;
        };
        if in_skipped_dir(rel) {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy();
        if skip_file(&file_name) {
            continue;
        }

        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let bytes = std::fs::read(path)?;
        raw_bytes += bytes.len() as u64;
        writer.start_file(rel_str, options)?;
        writer.write_all(&bytes)?;
        file_count += 1;
    }

    if file_count == 0 {
        anyhow::bail!("workspace has no files to import");
    }
    let cursor = writer.finish()?;
    let zip_bytes = cursor.into_inner();
    log_line(&format!(
        "zipped whole project: {file_count} files, {} → {} compressed",
        human_bytes(raw_bytes),
        human_bytes(zip_bytes.len() as u64),
    ));
    if zip_bytes.len() as u64 > 50 * 1024 * 1024 {
        log_line(&format!(
            "warning: zip is {} — over the API's ~50 MB window; upload may time out (524)",
            human_bytes(zip_bytes.len() as u64)
        ));
    }
    Ok(zip_bytes)
}

/// Compact human-readable byte size for the import log.
fn human_bytes(n: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * KB;
    if n >= MB {
        format!("{:.1} MB", n as f64 / MB as f64)
    } else if n >= KB {
        format!("{:.1} KB", n as f64 / KB as f64)
    } else {
        format!("{n} B")
    }
}

/// Persist the import result so we don't re-publish this project on later
/// builds. Written under `.panda/`, which already exists post-build (snapshots)
/// but is created defensively here.
fn write_marker(workspace: &Path, design: &ImportedDesign) -> anyhow::Result<()> {
    let marker = ImportMarker {
        design_id: design.id.clone(),
        slug: design.slug.clone(),
        title: design.title.clone(),
        status: design.status.clone(),
        project_url: design.project_url.clone(),
        imported_at: now_millis(),
    };
    let path = workspace.join(IMPORT_MARKER_REL);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_vec_pretty(&marker)?)?;
    Ok(())
}

/// Read the import marker if the project was already published.
fn read_marker(workspace: &Path) -> Option<ImportMarker> {
    let bytes = std::fs::read(workspace.join(IMPORT_MARKER_REL)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// On-demand: zip a real project with the production `zip_workspace` and
    /// write the exact payload to disk for manual validation. Ignored by default;
    /// run with the two env vars set:
    ///   PANDA_ZIP_PROJECT=<project-dir> PANDA_ZIP_OUT=<out.zip> \
    ///     cargo test -p panda-desktop dump_project_zip -- --ignored --nocapture
    #[test]
    #[ignore]
    fn dump_project_zip() {
        let project = std::env::var("PANDA_ZIP_PROJECT").expect("set PANDA_ZIP_PROJECT");
        let out = std::env::var("PANDA_ZIP_OUT").expect("set PANDA_ZIP_OUT");
        let bytes = zip_workspace(Path::new(&project)).expect("zip");
        std::fs::write(&out, &bytes).expect("write");
        eprintln!("wrote {} bytes to {out}", bytes.len());
    }

    #[test]
    fn parses_token_from_jwt_or_json_blob() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJ0eXAiOiJyZWZyZXNoIn0.sig";
        // Bare JWT.
        assert_eq!(parse_refresh_token_input(jwt).as_deref(), Some(jwt));
        assert_eq!(parse_refresh_token_input(&format!("  {jwt}\n")).as_deref(), Some(jwt));
        // Web app auth-state blob.
        let blob = format!(r#"{{"state":{{"status":"authenticated","refreshToken":"{jwt}"}}}}"#);
        assert_eq!(parse_refresh_token_input(&blob).as_deref(), Some(jwt));
        // Snake-case top-level.
        let blob2 = format!(r#"{{"refresh_token":"{jwt}"}}"#);
        assert_eq!(parse_refresh_token_input(&blob2).as_deref(), Some(jwt));
        // Garbage / non-JWT → None (prompt stays open).
        assert!(parse_refresh_token_input("not a token").is_none());
        assert!(parse_refresh_token_input("{}").is_none());
        assert!(parse_refresh_token_input("").is_none());
    }

    #[test]
    fn excludes_only_bloat_and_secrets() {
        // Bloat/version dirs are still dropped (they'd blow the size budget).
        assert!(in_skipped_dir(Path::new(".panda/snapshots/x/model.stl")));
        assert!(in_skipped_dir(Path::new(".git/config")));
        assert!(in_skipped_dir(Path::new("__pycache__/x.pyc")));
        assert!(in_skipped_dir(Path::new(".venv/lib/foo.py")));
        // Secrets and OS cruft never upload.
        assert!(skip_file(".env.local"));
        assert!(skip_file("secrets.json"));
        assert!(skip_file("id_rsa.pem"));
        assert!(skip_file(".DS_Store"));
        // Everything else — the WHOLE project — is included now, including the
        // files the old source-only policy dropped.
        assert!(!in_skipped_dir(Path::new("inputs/photo.png")));
        assert!(!skip_file("main.py"));
        assert!(!skip_file("project.json"));
        assert!(!skip_file("model.stl"));
        assert!(!skip_file("model.gcode"));
        assert!(!skip_file("model.gcode.3mf"));
        assert!(!skip_file("conversation_transcript.txt"));
        assert!(!skip_file("spec.md"));
    }

    #[test]
    fn has_model_matches_stem_named_artifacts() {
        // Real projects name the primary artifact after the stem (e.g.
        // `<project-id>.stl`), not the literal `model.stl` — has_model must see it.
        let dir = std::env::temp_dir().join(format!("panda-social-model-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!has_model(&dir));
        std::fs::write(dir.join("ca6a8115-f6c3-40b7-93e3-7ae5e064e39d.stl"), b"solid").unwrap();
        assert!(has_model(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cover_requires_a_review_png() {
        let dir = std::env::temp_dir().join(format!("panda-social-cover-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("model.stl"), b"solid").unwrap();
        // A model with no renders yet → no cover.
        assert!(!has_cover(&dir));
        // A stray PNG that isn't in a cover dir doesn't count.
        std::fs::write(dir.join("thumb.png"), b"png").unwrap();
        assert!(!has_cover(&dir));
        // A render in `<stem>_review/` does.
        std::fs::create_dir_all(dir.join("model_review")).unwrap();
        std::fs::write(dir.join("model_review/_assembled.png"), b"png").unwrap();
        assert!(has_cover(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn zips_whole_project_dropping_only_bloat() {
        let dir = std::env::temp_dir().join(format!("panda-social-zip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("model_review")).unwrap();
        std::fs::create_dir_all(dir.join("parts")).unwrap();
        std::fs::create_dir_all(dir.join("inputs")).unwrap();
        std::fs::create_dir_all(dir.join(".panda/snapshots")).unwrap();
        std::fs::write(dir.join("main.py"), b"def gen_step(): ...").unwrap();
        std::fs::write(dir.join("parts/base.py"), b"...").unwrap();
        std::fs::write(dir.join("spec.md"), b"# Spec").unwrap();
        std::fs::write(dir.join("model.stl"), b"solid").unwrap();
        std::fs::write(dir.join("model.gcode"), b"G1").unwrap();
        std::fs::write(dir.join("model_review/_assembled.png"), b"png").unwrap();
        std::fs::write(dir.join("inputs/photo.png"), b"jpg").unwrap();
        std::fs::write(dir.join("conversation_transcript.txt"), b"chat").unwrap();
        std::fs::write(dir.join(".panda/snapshots/big.stl"), b"huge").unwrap();
        std::fs::write(dir.join(".DS_Store"), b"x").unwrap();

        let bytes = zip_workspace(&dir).unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();

        // The whole project is present — source, parts, model, renders, gcode,
        // inputs, transcript.
        for expected in [
            "main.py",
            "parts/base.py",
            "spec.md",
            "model.stl",
            "model.gcode",
            "model_review/_assembled.png",
            "inputs/photo.png",
            "conversation_transcript.txt",
        ] {
            assert!(names.contains(&expected.to_string()), "missing {expected}");
        }
        // Only the bloat/version store and OS cruft are dropped.
        assert!(!names.iter().any(|n| n.contains(".panda")));
        assert!(!names.contains(&".DS_Store".to_string()));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
