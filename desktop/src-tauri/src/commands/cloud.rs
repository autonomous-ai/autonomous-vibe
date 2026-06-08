//! `cloud_*` IPC commands — Bambu cloud account login + cloud-transport
//! printing. Companion to `commands/printer.rs` (the LAN path).
//!
//! Flow:
//!   1. `cloud_login_request_code(account)` → Bambu emails a 6-digit code.
//!   2. `cloud_login_submit_code(account, code)` → access token; we derive the
//!      MQTT username (`u_<uid>`) from the JWT when the token is one, else from
//!      the `/my/profile` endpoint (newer Bambu tokens are opaque), plus the
//!      expiry, and persist the account to `bambu-cloud.json` (sensitive —
//!      never returned to JS).
//!   3. `printer_discover_cloud()` → `GET .../user/bind` lists the account's
//!      printers; each upserts into the shared `bambu-printers.json` tagged
//!      `transport: cloud`, so `printer_list`/`printer_status`/… stay one path.
//!
//! Status + start reuse `printer::mqtt_request_status` / `publish_start_command`
//! with a cloud `MqttTarget` (broker host + `u_<uid>` + token, verifying TLS).
//! Upload + print-job hit the cloud REST API.
//!
//! Cloud endpoints used for upload + print-job are derived from community
//! traffic analysis (unofficial) and may change; they are isolated here and
//! marked `untested against a real account`.

use crate::commands::printer::{self, MqttTarget, MqttTls, PrinterRecord};
use crate::ipc::types::{
    CloudAccountStatus, CloudLoginChallenge, CloudLoginRequest, CloudLoginSubmit,
    CloudPasswordLogin, CloudRegion, PrinterCard, PrinterStatus, PrinterTransport,
};
use crate::ipc::{IpcError, IpcResult};
use crate::paths;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

/// Refresh the token this many seconds before its actual expiry, so a call
/// that's about to go out doesn't race the boundary.
const REFRESH_SKEW_SECS: i64 = 120;

/// Cloud printer ids are prefixed with this so they live in a separate
/// keyspace from LAN records (which key on the bare serial) inside the
/// shared `bambu-printers.json`.
const CLOUD_ID_PREFIX: &str = "cloud:";

/// Fallback token lifetime when the login/refresh response carries neither an
/// `expiresIn` nor a decodable JWT `exp` (30 days — Bambu's typical window).
const DEFAULT_TTL_SECS: i64 = 30 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Region host map
// ---------------------------------------------------------------------------

fn api_base(region: CloudRegion) -> &'static str {
    match region {
        CloudRegion::Global => "https://api.bambulab.com",
        CloudRegion::China => "https://api.bambulab.cn",
    }
}

fn mqtt_host(region: CloudRegion) -> &'static str {
    match region {
        CloudRegion::Global => "us.mqtt.bambulab.com",
        CloudRegion::China => "cn.mqtt.bambulab.com",
    }
}

// ---------------------------------------------------------------------------
// Persistent account record (lives in `bambu-cloud.json`) — never to JS
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudAccount {
    pub account: String,
    #[serde(default)]
    pub region: CloudRegion,
    /// MQTT username decoded from the JWT (`u_<uid>`).
    pub mqtt_username: String,
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Unix seconds the access token expires (JWT `exp`).
    pub expires_at: i64,
}

impl CloudAccount {
    fn to_status(&self) -> CloudAccountStatus {
        CloudAccountStatus {
            signed_in: true,
            account: Some(self.account.clone()),
            region: Some(self.region),
            expires_at: Some(self.expires_at),
            needs_reauth: needs_refresh(self.expires_at, now_secs(), 0),
        }
    }
}

// ---------------------------------------------------------------------------
// Public Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cloud_login_request_code(req: CloudLoginRequest) -> IpcResult<CloudLoginChallenge> {
    let account = req.account.trim().to_string();
    if account.is_empty() {
        return Err(IpcError::invalid_argument("account is required"));
    }
    send_login_code(&account, req.region).await?;
    Ok(CloudLoginChallenge {
        kind: "codeSent".to_string(),
        tfa_key: None,
    })
}

/// Ask Bambu to email a 6-digit login code to `account`. Shared by the
/// code-login command and the password path (when Bambu demands a code as a
/// second factor).
async fn send_login_code(account: &str, region: CloudRegion) -> IpcResult<()> {
    let url = format!("{}/v1/user-service/user/sendemail/code", api_base(region));
    let body = serde_json::json!({ "email": account, "type": "codeLogin" });
    let resp = http_client()?
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| IpcError::new("CLOUD_LOGIN_FAILED", e.to_string()))?;
    if !resp.status().is_success() {
        return Err(IpcError::new(
            "CLOUD_LOGIN_FAILED",
            format!("send-code returned HTTP {}", resp.status().as_u16()),
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn cloud_login_submit_code(
    req: CloudLoginSubmit,
    region: Option<CloudRegion>,
) -> IpcResult<CloudAccountStatus> {
    let account = req.account.trim().to_string();
    let code = req.code.trim().to_string();
    if account.is_empty() || code.is_empty() {
        return Err(IpcError::invalid_argument("account and code are required"));
    }
    let region = region.unwrap_or_default();
    let url = format!("{}/v1/user-service/user/login", api_base(region));
    let body = serde_json::json!({ "account": account, "code": code });
    let json: serde_json::Value = http_client()?
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| IpcError::new("CLOUD_LOGIN_FAILED", e.to_string()))?
        .json()
        .await
        .map_err(|e| IpcError::new("CLOUD_LOGIN_FAILED", e.to_string()))?;
    finish_login(account, region, &json, "verification code was not accepted").await
}

/// Direct email + password sign-in. Same `/user/login` endpoint as the code
/// flow, just with a `password` body. Returns a `CloudLoginChallenge`:
/// - `success` — a token came back; the account is persisted, sign-in is done.
/// - `codeSent` — Bambu mandates an emailed verification code as a second
///   factor (common now). We trigger the email; the UI then collects the code
///   and finishes via `cloud_login_submit_code`.
/// 2FA and bad credentials surface as typed errors.
#[tauri::command]
pub async fn cloud_login_password(req: CloudPasswordLogin) -> IpcResult<CloudLoginChallenge> {
    let account = req.account.trim().to_string();
    if account.is_empty() || req.password.is_empty() {
        return Err(IpcError::invalid_argument("account and password are required"));
    }
    let region = req.region;
    let url = format!("{}/v1/user-service/user/login", api_base(region));
    let body = serde_json::json!({ "account": account, "password": req.password });
    let json: serde_json::Value = http_client()?
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| IpcError::new("CLOUD_LOGIN_FAILED", e.to_string()))?
        .json()
        .await
        .map_err(|e| IpcError::new("CLOUD_LOGIN_FAILED", e.to_string()))?;
    match classify_login_response(&json).kind.as_str() {
        "success" => {
            finish_login(account, region, &json, "email or password was not accepted").await?;
            Ok(CloudLoginChallenge { kind: "success".to_string(), tfa_key: None })
        }
        "tfa" => Err(IpcError::new(
            "CLOUD_TFA_REQUIRED",
            "account requires two-factor authentication, which is not supported yet",
        )),
        // Bambu requires an emailed code as a second factor — send it and ask
        // the UI to collect it.
        "codeSent" => {
            send_login_code(&account, region).await?;
            Ok(CloudLoginChallenge {
                kind: "codeSent".to_string(),
                tfa_key: None,
            })
        }
        _ => Err(IpcError::new(
            "CLOUD_LOGIN_FAILED",
            "email or password was not accepted",
        )),
    }
}

/// Shared login-response handler: classify the `/user/login` JSON, persist the
/// account on success, and return a typed error for any challenge. `bad_creds`
/// is the message used when the response is a plain rejection.
async fn finish_login(
    account: String,
    region: CloudRegion,
    json: &serde_json::Value,
    bad_creds: &str,
) -> IpcResult<CloudAccountStatus> {
    let challenge = classify_login_response(json);
    let access_token = match challenge.kind.as_str() {
        "success" => json
            .get("accessToken")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        "tfa" => {
            return Err(IpcError::new(
                "CLOUD_TFA_REQUIRED",
                "account requires two-factor authentication, which is not supported yet",
            ));
        }
        // Bambu wants an emailed verification code — password sign-in alone
        // can't proceed for this account.
        "codeSent" => {
            return Err(IpcError::new(
                "CLOUD_LOGIN_FAILED",
                "Bambu requires an email verification code for this account; password sign-in is unavailable",
            ));
        }
        _ => {
            return Err(IpcError::new("CLOUD_LOGIN_FAILED", bad_creds.to_string()));
        }
    };
    if access_token.is_empty() {
        return Err(IpcError::new(
            "CLOUD_LOGIN_FAILED",
            "login succeeded but returned no access token",
        ));
    }
    let refresh_token = json
        .get("refreshToken")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    // The token gates login + the REST upload/print path (bearer auth only),
    // so a token we can't decode as a JWT must NOT fail sign-in. Derive the
    // expiry from the response's `expiresIn` (reliable) and the MQTT uid from
    // the JWT when possible — an absent uid only degrades cloud *status*
    // polling, surfaced later by `cloud_mqtt_target`.
    let (mut mqtt_username, expires_at) = derive_identity_and_expiry(&access_token, json);
    // Newer Bambu access tokens are opaque (not JWTs), so the uid can't be
    // decoded from the token. Fall back to the authenticated profile endpoint;
    // best-effort, so a profile outage never blocks an otherwise-valid sign-in.
    if mqtt_username.is_empty() {
        if let Some(u) = fetch_mqtt_username(api_base(region), &access_token).await {
            mqtt_username = u;
        }
    }
    let account_rec = CloudAccount {
        account,
        region,
        mqtt_username,
        access_token,
        refresh_token,
        expires_at,
    };
    save_account(&account_rec).await?;
    Ok(account_rec.to_status())
}

#[tauri::command]
pub async fn cloud_account_status() -> IpcResult<CloudAccountStatus> {
    match load_account().await? {
        Some(acc) => Ok(acc.to_status()),
        None => Ok(CloudAccountStatus::default()),
    }
}

#[tauri::command]
pub async fn cloud_logout() -> IpcResult<()> {
    let path = paths::cloud_account_path();
    if path.exists() {
        tokio::fs::remove_file(&path).await.map_err(IpcError::from)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn printer_discover_cloud() -> IpcResult<Vec<PrinterCard>> {
    let account = require_fresh_account().await?;
    let url = format!("{}/v1/iot-service/api/user/bind", api_base(account.region));
    let json: serde_json::Value = http_client()?
        .get(url)
        .bearer_auth(&account.access_token)
        .send()
        .await
        .map_err(|e| IpcError::new("CLOUD_BIND_FAILED", e.to_string()))?
        .json()
        .await
        .map_err(|e| IpcError::new("CLOUD_BIND_FAILED", e.to_string()))?;

    let records = records_from_bind_response(&json);
    // Upsert each cloud device into the shared printers file so the rest of
    // the printer surface (list/status/upload/start) treats them uniformly.
    let mut file = printer::load_printers_file().await.unwrap_or_default();
    for rec in &records {
        printer::upsert_record(&mut file, rec.clone());
    }
    printer::save_printers_file(&file).await?;
    Ok(records.iter().map(|r| r.to_card()).collect())
}

// ---------------------------------------------------------------------------
// Called from printer.rs when a record is `transport: cloud`
// ---------------------------------------------------------------------------

pub(crate) async fn cloud_printer_status(
    record: &PrinterRecord,
    timeout: Duration,
) -> IpcResult<PrinterStatus> {
    let account = require_fresh_account().await?;
    let target = cloud_mqtt_target(&account, record)?;
    let report = printer::mqtt_request_status(&target, timeout).await?;
    Ok(printer::parse_status_report(&report))
}

/// Clamp an API response body to a sane length for inclusion in an error
/// message — responses can be large, and we only want a diagnostic peek at what
/// the (undocumented) endpoint actually returned. Char-boundary safe.
fn truncate_body(body: &str) -> String {
    const MAX_CHARS: usize = 500;
    let trimmed = body.trim();
    let out: String = trimmed.chars().take(MAX_CHARS).collect();
    if out.len() < trimmed.len() {
        format!("{out}…")
    } else {
        out
    }
}

// ---------------------------------------------------------------------------
// Cloud print: the real project-based upload + start flow
// ---------------------------------------------------------------------------
//
// Bambu cloud printing is NOT a single presigned PUT. It mirrors what Studio's
// closed `bambu_networking` plugin does, reconstructed from the open-source
// drop-in `ClusterM/open-bambu-networking` (`src/cloud_print.cpp`):
//
//   [A] POST  /v1/iot-service/api/user/project        {"name": <job>}
//        -> { project_id, model_id, profile_id, upload_url, upload_ticket }
//   [B] PUT   <upload_url>                             config 3mf (presigned S3)
//   [C] PUT   /v1/iot-service/api/user/notification    {"upload":{"origin_file_name":..}}
//   [D] GET   /v1/iot-service/api/user/notification?action=upload&ticket=<t>   (poll)
//   [E] PATCH /v1/iot-service/api/user/project/<pid>   placeholder ftp:// url
//   [F] GET   /v1/iot-service/api/user/upload?models=<mid>_<pid>_<plate>.3mf
//        -> { urls: [{ url }] }                        second presigned S3 PUT
//   [G] PUT   <second url>                             print-ready 3mf
//   [H] PATCH /v1/iot-service/api/user/project/<pid>   real url
//   [I] POST  /v1/user-service/my/task                 (MakerWorld history; soft-fail)
//   [J] MQTT  publish `project_file` to device/<serial>/request — THIS starts it.
//
// Mapped onto Panda's two-call surface like LAN (upload = put bytes, start =
// command the printer): `cloud_upload_file` runs [A]-[H] and stashes the ids it
// produced; `cloud_start_print` runs [I]-[J]. We upload the same `.gcode.3mf`
// for both the config (B) and main (G) objects — OrcaSlicer's export already
// carries `Metadata/plate_1.gcode`, which the `project_file` command references
// via `param`. No URL encryption (`url_enc`/RSA) is needed (the reference omits
// it; the firmware re-computes md5 on download, so a placeholder md5 is the
// documented fallback). Still untested against a real account — every step
// folds its HTTP status + body into the error so it is field-correctable.

/// Identifiers produced by the upload phase ([A]-[H]) that the start phase
/// ([I]-[J]) needs in order to reference the uploaded object.
#[derive(Clone)]
struct PendingCloudPrint {
    project_id: String,
    profile_id: String,
    model_id: String,
    main_url: String,
    md5: String,
    remote_name: String,
    plate_index: u32,
}

/// Bridges the upload and start IPC calls (keyed by printer id). Best-effort
/// in-memory hand-off; a stale entry is simply overwritten by the next upload.
fn pending_cloud_prints(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, PendingCloudPrint>> {
    static MAP: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, PendingCloudPrint>>,
    > = std::sync::OnceLock::new();
    MAP.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// The printer re-computes the digest on download, and the reference plugin uses
/// this exact 32-zero fallback when Studio doesn't supply one — so we avoid
/// bundling an md5 implementation while keeping the server schema happy.
const MD5_PLACEHOLDER: &str = "00000000000000000000000000000000";

/// Send a bearer-authed JSON request to a Bambu API endpoint and parse the
/// response. On any non-2xx, fold the HTTP status + body into a typed error
/// tagged with `step`, so a field tester sees exactly which call broke. A 2xx
/// with an empty / non-JSON body (some PUT/PATCH steps) resolves to `Null`.
async fn bbl_send_json(
    builder: reqwest::RequestBuilder,
    token: &str,
    step: &str,
) -> IpcResult<serde_json::Value> {
    let resp = builder
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| IpcError::new("CLOUD_UPLOAD_FAILED", format!("{step}: {e}")))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| IpcError::new("CLOUD_UPLOAD_FAILED", format!("{step}: {e}")))?;
    if !status.is_success() {
        return Err(IpcError::new(
            "CLOUD_UPLOAD_FAILED",
            format!(
                "{step} returned HTTP {}: {}",
                status.as_u16(),
                truncate_body(&body)
            ),
        ));
    }
    Ok(serde_json::from_str(&body).unwrap_or(serde_json::Value::Null))
}

/// PUT raw bytes to a presigned S3 URL. No bearer auth (the signature is in the
/// query string; an extra Authorization header breaks it) and no Content-Type /
/// Expect headers — reqwest adds neither for a raw `.body()`, which is what the
/// V2 presigned signature canonicalizes against.
async fn s3_put(url: &str, bytes: Vec<u8>, step: &str) -> IpcResult<()> {
    let resp = http_client()?
        .put(url)
        .body(bytes)
        .send()
        .await
        .map_err(|e| IpcError::new("CLOUD_UPLOAD_FAILED", format!("{step}: {e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(IpcError::new(
            "CLOUD_UPLOAD_FAILED",
            format!(
                "{step}: S3 PUT returned HTTP {}: {}",
                status.as_u16(),
                truncate_body(&body)
            ),
        ));
    }
    Ok(())
}

/// PATCH the project with the `profile_print_3mf` descriptor pointing at `url`
/// (a placeholder `ftp://` before the real upload [E], the real S3 url after [H]).
async fn patch_project(
    api: &str,
    token: &str,
    project_id: &str,
    profile_id: &str,
    url: &str,
) -> IpcResult<()> {
    bbl_send_json(
        http_client()?
            .patch(format!("{api}/v1/iot-service/api/user/project/{project_id}"))
            .json(&serde_json::json!({
                "profile_id": profile_id,
                "profile_print_3mf": [ { "md5": MD5_PLACEHOLDER, "plate_idx": 1, "url": url } ],
            })),
        token,
        "patch_project",
    )
    .await
    .map(|_| ())
}

/// Poll the notification endpoint until the config upload is acknowledged. In
/// captured traffic the first GET already returns success, so we return on the
/// first 2xx and only loop as a guard.
async fn poll_upload(api: &str, token: &str, ticket: &str) -> IpcResult<()> {
    let url = reqwest::Url::parse_with_params(
        &format!("{api}/v1/iot-service/api/user/notification"),
        &[("action", "upload"), ("ticket", ticket)],
    )
    .map_err(|e| IpcError::new("CLOUD_UPLOAD_FAILED", format!("poll_upload url: {e}")))?;
    for _ in 0..20 {
        let resp = http_client()?
            .get(url.clone())
            .bearer_auth(token)
            .send()
            .await;
        if let Ok(r) = resp {
            if r.status().is_success() {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(IpcError::new(
        "CLOUD_UPLOAD_FAILED",
        "upload notification poll timed out",
    ))
}

/// [A]-[H]: create the cloud project, upload the `.gcode.3mf` to the two
/// presigned slots, and stash the ids the start phase needs. `remote_name` is
/// the object name both phases agree on.
pub(crate) async fn cloud_upload_file(
    record: &PrinterRecord,
    local: &Path,
    remote_name: &str,
) -> IpcResult<()> {
    let account = require_fresh_account().await?;
    let api = api_base(account.region);
    let token = account.access_token.as_str();
    let bytes = tokio::fs::read(local).await.map_err(IpcError::from)?;

    // [A] Create the project + first presigned URL.
    let a = bbl_send_json(
        http_client()?
            .post(format!("{api}/v1/iot-service/api/user/project"))
            .json(&serde_json::json!({ "name": remote_name })),
        token,
        "create_project",
    )
    .await?;
    let get = |k: &str| a.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let project_id = get("project_id");
    let model_id = get("model_id");
    let profile_id = get("profile_id");
    let config_url = get("upload_url");
    let ticket = get("upload_ticket");
    if project_id.is_empty() || config_url.is_empty() {
        return Err(IpcError::new(
            "CLOUD_UPLOAD_FAILED",
            format!(
                "create_project missing project_id/upload_url: {}",
                truncate_body(&a.to_string())
            ),
        ));
    }

    // [B] config 3mf, [C] notify, [D] poll.
    s3_put(&config_url, bytes.clone(), "upload_config_3mf").await?;
    bbl_send_json(
        http_client()?
            .put(format!("{api}/v1/iot-service/api/user/notification"))
            .json(&serde_json::json!({
                "upload": { "origin_file_name": remote_name, "ticket": ticket }
            })),
        token,
        "notify_upload",
    )
    .await?;
    poll_upload(api, token, &ticket).await?;

    // [E] placeholder PATCH.
    patch_project(api, token, &project_id, &profile_id, &format!("ftp://{remote_name}")).await?;

    // [F] second presigned URL for the print-ready 3mf.
    let plate_index: u32 = 1;
    let model_slot = format!("{model_id}_{profile_id}_{plate_index}.3mf");
    let upload_query = reqwest::Url::parse_with_params(
        &format!("{api}/v1/iot-service/api/user/upload"),
        &[("models", model_slot.as_str())],
    )
    .map_err(|e| IpcError::new("CLOUD_UPLOAD_FAILED", format!("get_upload_url url: {e}")))?;
    let f = bbl_send_json(http_client()?.get(upload_query), token, "get_upload_url").await?;
    let main_url = f
        .pointer("/urls/0/url")
        .or_else(|| f.get("upload_url"))
        .or_else(|| f.get("url"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            IpcError::new(
                "CLOUD_UPLOAD_FAILED",
                format!("get_upload_url has no url: {}", truncate_body(&f.to_string())),
            )
        })?
        .to_string();

    // [G] main 3mf, [H] real-url PATCH.
    s3_put(&main_url, bytes, "upload_main_3mf").await?;
    patch_project(api, token, &project_id, &profile_id, &main_url).await?;

    // Hand the ids to the start phase (keyed by printer; same printer, same turn).
    pending_cloud_prints().lock().unwrap().insert(
        record.id.clone(),
        PendingCloudPrint {
            project_id,
            profile_id,
            model_id,
            main_url,
            md5: MD5_PLACEHOLDER.to_string(),
            remote_name: remote_name.to_string(),
            plate_index,
        },
    );
    Ok(())
}

/// POST the MakerWorld task record [I]. Returns the new task id. The caller
/// treats failure as non-fatal: the print is actually started by the MQTT
/// `project_file` command [J], and `/my/task` only feeds MakerWorld history.
async fn create_task(api: &str, token: &str, serial: &str, p: &PendingCloudPrint) -> IpcResult<String> {
    let profile_id = if p.profile_id.is_empty() { "0".to_string() } else { p.profile_id.clone() };
    let body = serde_json::json!({
        "amsMapping": [-1],
        "amsMapping2": [],
        "bedLeveling": true,
        "bedType": "auto",
        "cfg": "0",
        "cover": "",
        "deviceId": serial,
        "mode": "cloud_file",
        "modelId": p.model_id,
        "plateIndex": p.plate_index,
        "profileId": profile_id,
        "projectId": p.project_id,
        "sequence_id": "20000",
        "title": p.remote_name,
        "url": p.main_url,
    });
    let resp = bbl_send_json(
        http_client()?
            .post(format!("{api}/v1/user-service/my/task"))
            .json(&body),
        token,
        "create_task",
    )
    .await?;
    let id = match resp.get("id") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Number(n)) => n.to_string(),
        _ => String::new(),
    };
    if id.is_empty() {
        return Err(IpcError::new("CLOUD_PRINT_FAILED", "create_task missing id"));
    }
    Ok(id)
}

/// Build the MQTT `project_file` command [J] — the message the firmware acts on
/// to fetch the 3mf from S3 and start the job. Mirrors the reference plugin's
/// `build_project_file_json`, trimmed to a single-plate, no-AMS print with
/// conservative calibration defaults.
fn build_project_file_payload(p: &PendingCloudPrint, task_id: &str) -> serde_json::Value {
    let param = format!("Metadata/plate_{}.gcode", p.plate_index.max(1));
    serde_json::json!({
        "print": {
            "sequence_id": printer::sequence_id(),
            "command": "project_file",
            "param": param,
            "project_id": p.project_id,
            "profile_id": p.profile_id,
            "task_id": task_id,
            "subtask_id": "0",
            "subtask_name": p.remote_name,
            "file": p.remote_name,
            "url": p.main_url,
            "md5": p.md5,
            "bed_type": "auto",
            "bed_leveling": true,
            "flow_cali": false,
            "vibration_cali": false,
            "layer_inspect": false,
            "timelapse": false,
            "use_ams": false,
            "ams_mapping": "",
            "ams_mapping2": [],
            "cfg": "0",
        }
    })
}

/// [I]-[J]: create the task record, then publish the `project_file` command that
/// starts the job. Consumes the ids stashed by `cloud_upload_file`.
///
/// untested against a real account — verify in field test before v1 ship
pub(crate) async fn cloud_start_print(record: &PrinterRecord, remote_name: &str) -> IpcResult<()> {
    let _ = remote_name; // upload + start agree by construction (same turn)
    let account = require_fresh_account().await?;
    let api = api_base(account.region);
    let token = account.access_token.as_str();
    let serial = record.serial_or_err()?.to_string();

    let pending = pending_cloud_prints()
        .lock()
        .unwrap()
        .remove(&record.id)
        .ok_or_else(|| {
            IpcError::new(
                "CLOUD_PRINT_FAILED",
                "no uploaded cloud file for this printer — upload must run before start",
            )
        })?;

    // [I] Task record — soft-fail, since [J] is what actually starts the print.
    let task_id = match create_task(api, token, &serial, &pending).await {
        Ok(id) => id,
        Err(e) => {
            eprintln!("cloud_start_print: create_task soft-fail ({}); continuing", e.message);
            "0".to_string()
        }
    };

    // [J] Publish `project_file` to device/<serial>/request over the cloud broker.
    let payload = build_project_file_payload(&pending, &task_id);
    let target = cloud_mqtt_target(&account, record)?;
    printer::publish_start_command(&target, &payload, Duration::from_secs(5)).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

fn http_client() -> IpcResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| IpcError::internal(format!("http client build failed: {e}")))
}

// ---------------------------------------------------------------------------
// Token freshness + refresh
// ---------------------------------------------------------------------------

/// Load the account, refreshing the token if it's near expiry. Returns a
/// typed `CLOUD_REAUTH_REQUIRED` error when there's no signed-in account or
/// the token is stale and cannot be refreshed.
async fn require_fresh_account() -> IpcResult<CloudAccount> {
    let account = load_account()
        .await?
        .ok_or_else(|| IpcError::new("CLOUD_REAUTH_REQUIRED", "not signed in to Bambu cloud"))?;
    if !needs_refresh(account.expires_at, now_secs(), REFRESH_SKEW_SECS) {
        return Ok(account);
    }
    match refresh_token(&account).await {
        Ok(refreshed) => {
            save_account(&refreshed).await?;
            Ok(refreshed)
        }
        // Keep the stale record on disk (the refresh_token may work later) but
        // tell the caller to re-auth now.
        Err(_) => Err(IpcError::new(
            "CLOUD_REAUTH_REQUIRED",
            "Bambu cloud session expired — sign in again",
        )),
    }
}

async fn refresh_token(account: &CloudAccount) -> IpcResult<CloudAccount> {
    let refresh = account
        .refresh_token
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| IpcError::new("CLOUD_REAUTH_REQUIRED", "no refresh token"))?;
    let url = format!(
        "{}/v1/user-service/user/refreshtoken",
        api_base(account.region)
    );
    let body = serde_json::json!({ "refreshToken": refresh });
    let json: serde_json::Value = http_client()?
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| IpcError::new("CLOUD_REAUTH_REQUIRED", e.to_string()))?
        .json()
        .await
        .map_err(|e| IpcError::new("CLOUD_REAUTH_REQUIRED", e.to_string()))?;
    let access_token = json
        .get("accessToken")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| IpcError::new("CLOUD_REAUTH_REQUIRED", "refresh returned no token"))?
        .to_string();
    let refresh_token = json
        .get("refreshToken")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| account.refresh_token.clone());
    // Same resilience as login: don't fail on a non-JWT token. Prefer a freshly
    // derived identity, but keep the existing one if the refreshed token yields
    // nothing (so a refresh never strips a working MQTT identity).
    let (derived_username, expires_at) = derive_identity_and_expiry(&access_token, &json);
    let mqtt_username = if !derived_username.is_empty() {
        derived_username
    } else if !account.mqtt_username.is_empty() {
        account.mqtt_username.clone()
    } else {
        // Opaque token and no stored identity yet (e.g. signed in before this
        // fix): fetch it from the profile endpoint so the refresh self-heals.
        fetch_mqtt_username(api_base(account.region), &access_token)
            .await
            .unwrap_or_default()
    };
    Ok(CloudAccount {
        account: account.account.clone(),
        region: account.region,
        mqtt_username,
        access_token,
        refresh_token,
        expires_at,
    })
}

/// Read the token lifetime from a login/refresh response: Bambu returns
/// `expiresIn` (seconds from now). `None` if absent.
fn response_expiry(json: &serde_json::Value) -> Option<i64> {
    json.get("expiresIn")
        .and_then(|v| v.as_i64())
        .filter(|s| *s > 0)
        .map(|secs| now_secs() + secs)
}

/// MQTT username from the login response body's own `uid`/`userId` field.
fn uid_from_response(json: &serde_json::Value) -> Option<String> {
    match json.get("uid").or_else(|| json.get("userId")) {
        Some(serde_json::Value::String(s)) if !s.is_empty() => Some(format!("u_{s}")),
        Some(serde_json::Value::Number(n)) => Some(format!("u_{n}")),
        _ => None,
    }
}

/// Decode the JWT payload (middle segment) into its claims object. No signature
/// check — we're reading our own token, not trusting a third party. `None` when
/// the token isn't a decodable 3-part JWT (e.g. an opaque token).
fn decode_jwt_claims(token: &str) -> Option<serde_json::Value> {
    let payload_b64 = token.split('.').nth(1)?;
    let raw = decode_b64url(payload_b64).ok()?;
    serde_json::from_slice(&raw).ok()
}

/// MQTT username (`u_<uid>`) from JWT claims, tolerant of claim shape: a
/// `username` already in `u_…` form, a digit-only `username`, or a numeric
/// `uid`/`userId`/`user_id`/`userid`/`sub` claim. Decoupled from `exp` so a
/// missing/odd expiry never costs us the identity.
fn mqtt_username_from_claims(claims: &serde_json::Value) -> Option<String> {
    if let Some(s) = claims.get("username").and_then(|v| v.as_str()) {
        if s.starts_with("u_") {
            return Some(s.to_string());
        }
        if !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()) {
            return Some(format!("u_{s}"));
        }
    }
    for key in ["uid", "userId", "user_id", "userid", "sub"] {
        match claims.get(key) {
            Some(serde_json::Value::String(s)) if !s.is_empty() => return Some(format!("u_{s}")),
            Some(serde_json::Value::Number(n)) => return Some(format!("u_{n}")),
            _ => {}
        }
    }
    None
}

/// `exp` (unix seconds) from JWT claims, tolerant of integer or float encodings
/// (some issuers serialize it as a float).
fn jwt_exp(claims: &serde_json::Value) -> Option<i64> {
    let e = claims.get("exp")?;
    e.as_i64().or_else(|| e.as_f64().map(|f| f as i64))
}

/// Derive the MQTT identity + expiry that get stored on the account, robustly:
/// the username comes from the JWT claims (or the response `uid`), the expiry
/// from `expiresIn` (or the JWT `exp`), and the two are independent so one
/// failing never discards the other. Logs the available claim keys when no
/// identity can be derived, to aid field diagnosis.
fn derive_identity_and_expiry(access_token: &str, json: &serde_json::Value) -> (String, i64) {
    let claims = decode_jwt_claims(access_token);
    let mqtt_username = claims
        .as_ref()
        .and_then(mqtt_username_from_claims)
        .or_else(|| uid_from_response(json))
        .unwrap_or_default();
    if mqtt_username.is_empty() {
        eprintln!(
            "cloud login: no MQTT identity derived — jwt claim keys={:?}, response keys={:?}",
            claims
                .as_ref()
                .and_then(|c| c.as_object())
                .map(|o| o.keys().cloned().collect::<Vec<_>>()),
            json.as_object()
                .map(|o| o.keys().cloned().collect::<Vec<_>>()),
        );
    }
    let expires_at = response_expiry(json)
        .or_else(|| claims.as_ref().and_then(jwt_exp))
        .unwrap_or_else(|| now_secs() + DEFAULT_TTL_SECS);
    (mqtt_username, expires_at)
}

/// Extract `u_<uid>` from a `/my/profile` response body, preferring the string
/// `uidStr` (avoids any large-integer JSON pitfalls) and falling back to the
/// numeric `uid`/`userId`.
fn mqtt_username_from_profile(json: &serde_json::Value) -> Option<String> {
    json.get("uidStr")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| format!("u_{s}"))
        .or_else(|| uid_from_response(json))
}

/// Fetch the account uid from the authenticated profile endpoint and format it
/// as the MQTT username `u_<uid>`. Bambu's newer access tokens are opaque (not
/// JWTs), so the uid is no longer embedded in the token and must be fetched.
/// Best-effort: any failure yields `None` (cloud status/print then degrade,
/// surfaced by `cloud_mqtt_target`, but the REST upload path still works).
async fn fetch_mqtt_username(api: &str, token: &str) -> Option<String> {
    let json: serde_json::Value = http_client()
        .ok()?
        .get(format!("{api}/v1/user-service/my/profile"))
        .bearer_auth(token)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    mqtt_username_from_profile(&json)
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async fn load_account() -> IpcResult<Option<CloudAccount>> {
    load_account_at(&paths::cloud_account_path()).await
}

async fn load_account_at(path: &Path) -> IpcResult<Option<CloudAccount>> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = tokio::fs::read(path).await.map_err(IpcError::from)?;
    if bytes.is_empty() {
        return Ok(None);
    }
    let acc: CloudAccount = serde_json::from_slice(&bytes)
        .map_err(|e| IpcError::new("CLOUD_ACCOUNT_PARSE_ERROR", e.to_string()))?;
    Ok(Some(acc))
}

async fn save_account(account: &CloudAccount) -> IpcResult<()> {
    let path = paths::cloud_account_path();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    let bytes = serde_json::to_vec_pretty(account).map_err(IpcError::from)?;
    tokio::fs::write(&path, bytes).await.map_err(IpcError::from)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

fn now_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// True when `expires_at` is at or before `now + skew` (i.e. the token is
/// expired or about to expire).
fn needs_refresh(expires_at: i64, now: i64, skew: i64) -> bool {
    expires_at <= now + skew
}

/// Base64url-decode a JWT segment, tolerating both padded and unpadded input.
/// JWTs are spec'd as base64url-without-padding, but we're parsing a third
/// party's token whose exact encoding we don't control, so accept either.
fn decode_b64url(s: &str) -> Result<Vec<u8>, base64::DecodeError> {
    use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
    use base64::Engine;
    let engine = GeneralPurpose::new(
        &base64::alphabet::URL_SAFE,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    engine.decode(s)
}

/// Decode the middle (payload) segment of the JWT access token and pull the
/// MQTT username (`u_<uid>`) + `exp`. We never verify the signature — we're
/// reading our own token's claims, not trusting a third party's.
/// Test-only convenience composing the production claim helpers (kept so the
/// existing JWT-decoding tests read against one call).
#[cfg(test)]
fn decode_uid_exp(token: &str) -> IpcResult<(String, i64)> {
    let claims = decode_jwt_claims(token)
        .ok_or_else(|| IpcError::new("CLOUD_TOKEN_INVALID", "access token is not a JWT"))?;
    let mqtt_username = mqtt_username_from_claims(&claims)
        .ok_or_else(|| IpcError::new("CLOUD_TOKEN_INVALID", "token has no uid/username claim"))?;
    let exp =
        jwt_exp(&claims).ok_or_else(|| IpcError::new("CLOUD_TOKEN_INVALID", "token has no exp claim"))?;
    Ok((mqtt_username, exp))
}

/// Classify a `/user/login` response into a `CloudLoginChallenge`.
fn classify_login_response(json: &serde_json::Value) -> CloudLoginChallenge {
    let has_token = json
        .get("accessToken")
        .and_then(|v| v.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    if has_token {
        return CloudLoginChallenge {
            kind: "success".to_string(),
            tfa_key: None,
        };
    }
    if let Some(tfa) = json
        .get("tfaKey")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        return CloudLoginChallenge {
            kind: "tfa".to_string(),
            tfa_key: Some(tfa.to_string()),
        };
    }
    let login_type = json.get("loginType").and_then(|v| v.as_str()).unwrap_or("");
    match login_type {
        "verifyCode" => CloudLoginChallenge {
            kind: "codeSent".to_string(),
            tfa_key: None,
        },
        _ => CloudLoginChallenge {
            kind: "needPassword".to_string(),
            tfa_key: None,
        },
    }
}

/// Map a `/user/bind` response into cloud `PrinterRecord`s.
fn records_from_bind_response(json: &serde_json::Value) -> Vec<PrinterRecord> {
    let Some(devices) = json.get("devices").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    devices
        .iter()
        .filter_map(|d| {
            let dev_id = d.get("dev_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty())?;
            let name = d
                .get("name")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(dev_id)
                .to_string();
            let model = d
                .get("dev_product_name")
                .or_else(|| d.get("dev_model_name"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("Bambu")
                .to_string();
            let online = d.get("online").and_then(|v| v.as_bool());
            let access_code = d
                .get("dev_access_code")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            Some(PrinterRecord {
                // Namespace cloud ids so a cloud device never clobbers a
                // LAN record for the same physical printer (both would
                // otherwise key on the bare serial). The serial is kept
                // separately for the MQTT topic.
                id: format!("{CLOUD_ID_PREFIX}{dev_id}"),
                model,
                transport: PrinterTransport::Cloud,
                ip_address: None,
                host_name: name,
                access_code,
                serial: Some(dev_id.to_string()),
                online,
            })
        })
        .collect()
}

/// Build the cloud `MqttTarget` for a device: broker host for the account's
/// region, `u_<uid>` username, access token as password, verifying TLS.
fn cloud_mqtt_target(account: &CloudAccount, record: &PrinterRecord) -> IpcResult<MqttTarget> {
    if account.mqtt_username.is_empty() {
        // We couldn't derive `u_<uid>` from the token, so MQTT (live status)
        // is unavailable — but the bearer-only REST path (upload + print-job)
        // still works. Surface a clear, non-fatal code.
        return Err(IpcError::new(
            "CLOUD_NO_MQTT_IDENTITY",
            "live status is unavailable for this cloud session",
        ));
    }
    Ok(MqttTarget {
        host: mqtt_host(account.region).to_string(),
        port: 8883,
        username: account.mqtt_username.clone(),
        password: account.access_token.clone(),
        serial: record.serial_or_err()?.to_string(),
        tls: MqttTls::Verify,
        client_id: format!("panda-cloud-{}", printer::sequence_id()),
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    /// Build an unsigned JWT (`header.payload.`) carrying the given claims.
    fn fake_jwt(claims: serde_json::Value) -> String {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&claims).unwrap());
        format!("eyJhbGciOiJub25lIn0.{payload}.")
    }

    #[test]
    fn decodes_username_and_exp_from_jwt() {
        let token = fake_jwt(serde_json::json!({ "username": "u_1234567890", "exp": 1_900_000_000 }));
        let (user, exp) = decode_uid_exp(&token).unwrap();
        assert_eq!(user, "u_1234567890");
        assert_eq!(exp, 1_900_000_000);
    }

    #[test]
    fn builds_username_from_uid_claim() {
        let token = fake_jwt(serde_json::json!({ "uid": "987654321", "exp": 42 }));
        let (user, exp) = decode_uid_exp(&token).unwrap();
        assert_eq!(user, "u_987654321");
        assert_eq!(exp, 42);
    }

    #[test]
    fn b64url_decode_tolerates_padding() {
        // "hi" base64url-encodes to "aGk=" (padded). The lenient decoder must
        // accept both the padded and unpadded forms.
        assert_eq!(decode_b64url("aGk=").unwrap(), b"hi");
        assert_eq!(decode_b64url("aGk").unwrap(), b"hi");
    }

    #[test]
    fn rejects_token_without_claims() {
        let token = fake_jwt(serde_json::json!({ "foo": "bar" }));
        assert!(decode_uid_exp(&token).is_err());
        assert!(decode_uid_exp("not-a-jwt").is_err());
    }

    #[test]
    fn classify_login_branches() {
        assert_eq!(
            classify_login_response(&serde_json::json!({ "accessToken": "abc" })).kind,
            "success"
        );
        let tfa = classify_login_response(&serde_json::json!({ "tfaKey": "k" }));
        assert_eq!(tfa.kind, "tfa");
        assert_eq!(tfa.tfa_key.as_deref(), Some("k"));
        assert_eq!(
            classify_login_response(&serde_json::json!({ "loginType": "verifyCode" })).kind,
            "codeSent"
        );
        assert_eq!(
            classify_login_response(&serde_json::json!({ "success": false })).kind,
            "needPassword"
        );
    }


    #[test]
    fn response_expiry_reads_expires_in() {
        let now = now_secs();
        let exp = response_expiry(&serde_json::json!({ "expiresIn": 3600 })).unwrap();
        assert!(exp >= now + 3600 && exp <= now + 3600 + 5);
        assert!(response_expiry(&serde_json::json!({})).is_none());
        assert!(response_expiry(&serde_json::json!({ "expiresIn": 0 })).is_none());
    }

    #[test]
    fn derives_mqtt_username_from_claims_or_response() {
        // From JWT claims: a `username` already in `u_` form, a digit-only
        // `username`, or a numeric `uid`/`sub` claim.
        assert_eq!(
            mqtt_username_from_claims(&serde_json::json!({ "username": "u_jwt" })),
            Some("u_jwt".to_string())
        );
        assert_eq!(
            mqtt_username_from_claims(&serde_json::json!({ "username": "12345" })),
            Some("u_12345".to_string())
        );
        assert_eq!(
            mqtt_username_from_claims(&serde_json::json!({ "uid": 999 })),
            Some("u_999".to_string())
        );
        assert_eq!(
            mqtt_username_from_claims(&serde_json::json!({ "sub": "abc" })),
            Some("u_abc".to_string())
        );
        assert_eq!(mqtt_username_from_claims(&serde_json::json!({})), None);

        // Fallback: a uid carried directly on the login response body.
        assert_eq!(
            uid_from_response(&serde_json::json!({ "uid": 12345 })),
            Some("u_12345".to_string())
        );
        assert_eq!(
            uid_from_response(&serde_json::json!({ "userId": "777" })),
            Some("u_777".to_string())
        );
        assert_eq!(uid_from_response(&serde_json::json!({})), None);

        // `exp` tolerates int and float encodings.
        assert_eq!(jwt_exp(&serde_json::json!({ "exp": 1700 })), Some(1700));
        assert_eq!(jwt_exp(&serde_json::json!({ "exp": 1700.0 })), Some(1700));
        assert_eq!(jwt_exp(&serde_json::json!({})), None);
    }

    #[test]
    fn extracts_mqtt_username_from_profile_response() {
        // Opaque-token path: the uid comes from `/my/profile`. Prefer `uidStr`.
        assert_eq!(
            mqtt_username_from_profile(&serde_json::json!({ "uidStr": "1378062920", "uid": 1378062920 })),
            Some("u_1378062920".to_string())
        );
        // No string form → fall back to the numeric `uid`.
        assert_eq!(
            mqtt_username_from_profile(&serde_json::json!({ "uid": 1378062920_i64 })),
            Some("u_1378062920".to_string())
        );
        assert_eq!(mqtt_username_from_profile(&serde_json::json!({})), None);
    }

    #[test]
    fn cloud_target_errors_without_mqtt_identity() {
        let account = CloudAccount {
            account: "me@example.com".into(),
            region: CloudRegion::Global,
            mqtt_username: String::new(),
            access_token: "tok".into(),
            refresh_token: None,
            expires_at: 0,
        };
        let record = PrinterRecord {
            id: "cloud:S1".into(),
            model: "P1S".into(),
            transport: PrinterTransport::Cloud,
            ip_address: None,
            host_name: "Office".into(),
            access_code: None,
            serial: Some("S1".into()),
            online: Some(true),
        };
        let err = cloud_mqtt_target(&account, &record)
            .err()
            .expect("should error without a uid");
        assert_eq!(err.code, "CLOUD_NO_MQTT_IDENTITY");
    }

    #[test]
    fn needs_refresh_boundaries() {
        assert!(needs_refresh(100, 100, 0)); // exactly expired
        assert!(needs_refresh(100, 50, 60)); // within skew
        assert!(!needs_refresh(1000, 100, 60)); // fresh
    }

    #[test]
    fn maps_bind_response_to_cloud_records() {
        let json = serde_json::json!({
            "message": "success",
            "devices": [
                {
                    "dev_id": "01P00A000000000",
                    "name": "Office P1S",
                    "online": true,
                    "dev_model_name": "C12",
                    "dev_product_name": "P1S",
                    "dev_access_code": "12345678"
                },
                { "name": "missing id" }
            ]
        });
        let recs = records_from_bind_response(&json);
        assert_eq!(recs.len(), 1);
        let rec = &recs[0];
        assert_eq!(rec.transport, PrinterTransport::Cloud);
        // Namespaced id keeps cloud records from colliding with a LAN record
        // for the same serial; the serial itself is unprefixed (MQTT topic).
        assert_eq!(rec.id, "cloud:01P00A000000000");
        assert_eq!(rec.serial.as_deref(), Some("01P00A000000000"));
        assert_eq!(rec.model, "P1S");
        assert_eq!(rec.host_name, "Office P1S");
        assert_eq!(rec.online, Some(true));
        assert!(rec.ip_address.is_none());
        // Cloud cards never carry a LAN IP.
        assert!(rec.to_card().ip_address.is_none());
        assert_eq!(rec.to_card().transport, PrinterTransport::Cloud);
    }

    #[test]
    fn cloud_target_uses_broker_token_and_verifying_tls() {
        let account = CloudAccount {
            account: "me@example.com".into(),
            region: CloudRegion::Global,
            mqtt_username: "u_42".into(),
            access_token: "tok".into(),
            refresh_token: None,
            expires_at: 0,
        };
        let record = PrinterRecord {
            id: "S1".into(),
            model: "P1S".into(),
            transport: PrinterTransport::Cloud,
            ip_address: None,
            host_name: "Office".into(),
            access_code: None,
            serial: Some("S1".into()),
            online: Some(true),
        };
        let target = cloud_mqtt_target(&account, &record).unwrap();
        assert_eq!(target.host, "us.mqtt.bambulab.com");
        assert_eq!(target.port, 8883);
        assert_eq!(target.username, "u_42");
        assert_eq!(target.password, "tok");
        assert_eq!(target.serial, "S1");
        assert_eq!(target.tls, MqttTls::Verify);
    }

    #[tokio::test]
    async fn account_round_trips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bambu-cloud.json");
        let account = CloudAccount {
            account: "me@example.com".into(),
            region: CloudRegion::Global,
            mqtt_username: "u_42".into(),
            access_token: "tok".into(),
            refresh_token: Some("r".into()),
            expires_at: 1_900_000_000,
        };
        let bytes = serde_json::to_vec_pretty(&account).unwrap();
        tokio::fs::write(&path, bytes).await.unwrap();
        let loaded = load_account_at(&path).await.unwrap().unwrap();
        assert_eq!(loaded, account);
    }
}
