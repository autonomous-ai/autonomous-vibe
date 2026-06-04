//! Custom `pandaasset://` URI scheme that streams the open project's files
//! to the webview.
//!
//! The catalog hands the frontend `pandaasset://localhost/<project-relative
//! path>` URLs (see [`crate::commands::catalog`]); cadjs `fetch()`es them to
//! load STL/PNG bytes for the 3D viewer. We resolve each request against
//! the active project dir — the same scoping as `file_read_bytes` — and
//! return the bytes. Without this bridge no model can render: the prior
//! `tauri://localhost/...` URLs resolved to the app's own frontend origin
//! and 404'd.

use crate::paths;
use crate::state::AppState;
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};
use std::path::Path;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext};

/// The URI scheme name. `pandaasset://localhost/<rel>` in the webview.
pub const SCHEME: &str = "pandaasset";

/// Characters we percent-encode in a path. `/` is intentionally left intact
/// so nested artifacts (`parts/base.stl`) keep their segments.
const PATH_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'?')
    .add(b'`')
    .add(b'{')
    .add(b'}');

/// Build the webview URL for a project-relative path. Tauri serves custom
/// URI schemes at `scheme://localhost/...` on macOS/Linux but at
/// `http://scheme.localhost/...` on Windows (WebView2) — mirror that here or
/// `fetch()` fails with a bare "Failed to fetch" on Windows.
pub fn asset_url(workspace_relative: &str) -> String {
    let encoded = utf8_percent_encode(workspace_relative, PATH_ENCODE_SET);
    #[cfg(target_os = "windows")]
    {
        format!("http://{SCHEME}.localhost/{encoded}")
    }
    #[cfg(not(target_os = "windows"))]
    {
        format!("{SCHEME}://localhost/{encoded}")
    }
}

/// `register_uri_scheme_protocol` handler.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let state = ctx.app_handle().state::<AppState>();
    match resolve_bytes(&state, request.uri().path()) {
        Ok((bytes, content_type)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type)
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(bytes)
            .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR)),
        Err(status) => empty(status),
    }
}

fn resolve_bytes(
    state: &AppState,
    uri_path: &str,
) -> Result<(Vec<u8>, &'static str), StatusCode> {
    let id = state.active_project().ok_or(StatusCode::NOT_FOUND)?;
    let rel = percent_decode_str(uri_path.trim_start_matches('/'))
        .decode_utf8()
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    // resolve_in_project rejects `..` traversal.
    let resolved = paths::resolve_in_project(&id, &rel).map_err(|_| StatusCode::FORBIDDEN)?;
    let bytes = std::fs::read(&resolved).map_err(|_| StatusCode::NOT_FOUND)?;
    Ok((bytes, content_type_for(&resolved)))
}

fn content_type_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("stl") => "model/stl",
        Some("3mf") => "model/3mf",
        Some("png") => "image/png",
        Some("json") => "application/json",
        Some("step") | Some("stp") => "application/step",
        _ => "application/octet-stream",
    }
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .expect("static empty response is always valid")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_url_encodes_spaces_but_keeps_slashes() {
        #[cfg(target_os = "windows")]
        let (base, nested) = (
            "http://pandaasset.localhost/model.stl",
            "http://pandaasset.localhost/parts/base%20plate.stl",
        );
        #[cfg(not(target_os = "windows"))]
        let (base, nested) = (
            "pandaasset://localhost/model.stl",
            "pandaasset://localhost/parts/base%20plate.stl",
        );
        assert_eq!(asset_url("model.stl"), base);
        assert_eq!(asset_url("parts/base plate.stl"), nested);
    }

    #[test]
    fn no_active_project_is_not_found() {
        let state = AppState::new();
        let err = resolve_bytes(&state, "/model.stl").unwrap_err();
        assert_eq!(err, StatusCode::NOT_FOUND);
    }

    #[test]
    fn traversal_is_forbidden() {
        let state = AppState::new();
        state.set_active_project(Some("proj".into()));
        let err = resolve_bytes(&state, "/../../etc/passwd").unwrap_err();
        assert_eq!(err, StatusCode::FORBIDDEN);
    }
}
