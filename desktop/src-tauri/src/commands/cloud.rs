//! `cloud_*` IPC commands — Bambu cloud account login + cloud-transport
//! printing. Companion to `commands/printer.rs` (the LAN path).
//!
//! Flow:
//!   1. `cloud_login_request_code(account)` → Bambu emails a 6-digit code.
//!   2. `cloud_login_submit_code(account, code)` → access token; we decode
//!      the JWT for the MQTT username (`u_<uid>`) + expiry and persist the
//!      account to `bambu-cloud.json` (sensitive — never returned to JS).
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
    CloudAccountStatus, CloudLoginChallenge, CloudLoginRequest, CloudLoginSubmit, CloudRegion,
    PrinterCard, PrinterStatus, PrinterTransport,
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
    let url = format!("{}/v1/user-service/user/sendemail/code", api_base(req.region));
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
    Ok(CloudLoginChallenge {
        kind: "codeSent".to_string(),
        tfa_key: None,
    })
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

    let challenge = classify_login_response(&json);
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
        _ => {
            return Err(IpcError::new(
                "CLOUD_LOGIN_FAILED",
                "verification code was not accepted",
            ));
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
    let jwt = decode_uid_exp(&access_token).ok();
    let mqtt_username = mqtt_username_from(&json, jwt.as_ref());
    let expires_at = response_expiry(&json)
        .or_else(|| jwt.map(|(_, e)| e))
        .unwrap_or_else(|| now_secs() + DEFAULT_TTL_SECS);
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

/// Upload a local print file to the account's cloud storage via a presigned
/// S3 URL. The object is named `remote_name` (the same name
/// `cloud_start_print` references), so upload and start always agree.
///
/// The file uploaded is whatever the caller hands us: today the chat slice
/// path produces plain `.gcode`, so that's what goes up; a `.gcode.3mf`
/// (from the toolbar slice) works too if the frontend passes it. We do NOT
/// silently substitute a sibling file, because the separate `start` call
/// can't observe that choice and would reference a different name.
///
/// untested against a real account — verify in field test before v1 ship
pub(crate) async fn cloud_upload_file(
    record: &PrinterRecord,
    local: &Path,
    remote_name: &str,
) -> IpcResult<()> {
    let account = require_fresh_account().await?;
    let _ = record; // device is referenced at print-job time, not upload time

    let bytes = tokio::fs::read(local).await.map_err(IpcError::from)?;
    let size_str = bytes.len().to_string();

    // 1. Ask Bambu for a presigned upload URL.
    let url = reqwest::Url::parse_with_params(
        &format!(
            "{}/v1/iot-service/api/user/file/upload_url",
            api_base(account.region)
        ),
        &[("filename", remote_name), ("size", size_str.as_str())],
    )
    .map_err(|e| IpcError::new("CLOUD_UPLOAD_FAILED", e.to_string()))?;
    let json: serde_json::Value = http_client()?
        .get(url)
        .bearer_auth(&account.access_token)
        .send()
        .await
        .map_err(|e| IpcError::new("CLOUD_UPLOAD_FAILED", e.to_string()))?
        .json()
        .await
        .map_err(|e| IpcError::new("CLOUD_UPLOAD_FAILED", e.to_string()))?;
    let upload_url = json
        .get("upload_url")
        .or_else(|| json.get("url"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            IpcError::new("CLOUD_UPLOAD_FAILED", "no upload_url in presign response")
        })?
        .to_string();

    // 2. PUT the raw bytes to S3 with minimal headers (the bearer token must
    //    NOT be forwarded to the presigned URL, or the signature mismatches).
    let put = http_client()?
        .put(&upload_url)
        .body(bytes)
        .send()
        .await
        .map_err(|e| IpcError::new("CLOUD_UPLOAD_FAILED", e.to_string()))?;
    if !put.status().is_success() {
        return Err(IpcError::new(
            "CLOUD_UPLOAD_FAILED",
            format!("S3 PUT returned HTTP {}", put.status().as_u16()),
        ));
    }
    Ok(())
}

/// Start a print of an already-uploaded cloud file on the device.
///
/// untested against a real account — verify in field test before v1 ship
pub(crate) async fn cloud_start_print(record: &PrinterRecord, remote_name: &str) -> IpcResult<()> {
    let account = require_fresh_account().await?;
    let serial = record.serial_or_err()?;
    let url = format!(
        "{}/v1/iot-service/api/user/print/job",
        api_base(account.region)
    );
    let body = serde_json::json!({
        "device_id": serial,
        "file_name": remote_name,
    });
    let resp = http_client()?
        .post(url)
        .bearer_auth(&account.access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| IpcError::new("CLOUD_PRINT_FAILED", e.to_string()))?;
    if !resp.status().is_success() {
        return Err(IpcError::new(
            "CLOUD_PRINT_FAILED",
            format!("print-job returned HTTP {}", resp.status().as_u16()),
        ));
    }
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
    // Same resilience as login: don't fail on a non-JWT token. Prefer the
    // existing uid if the refreshed token can't be decoded.
    let jwt = decode_uid_exp(&access_token).ok();
    let mqtt_username = {
        let derived = mqtt_username_from(&json, jwt.as_ref());
        if derived.is_empty() {
            account.mqtt_username.clone()
        } else {
            derived
        }
    };
    let expires_at = response_expiry(&json)
        .or_else(|| jwt.map(|(_, e)| e))
        .unwrap_or_else(|| now_secs() + DEFAULT_TTL_SECS);
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

/// Derive the MQTT username (`u_<uid>`). Prefer the JWT `username` claim;
/// fall back to a `uid`/`userId` carried directly on the login response.
/// Empty string when neither is available (cloud status then degrades, but
/// the bearer-only REST path keeps working).
fn mqtt_username_from(json: &serde_json::Value, jwt: Option<&(String, i64)>) -> String {
    if let Some((u, _)) = jwt {
        if !u.is_empty() {
            return u.clone();
        }
    }
    match json.get("uid").or_else(|| json.get("userId")) {
        Some(serde_json::Value::String(s)) if !s.is_empty() => format!("u_{s}"),
        Some(serde_json::Value::Number(n)) => format!("u_{n}"),
        _ => String::new(),
    }
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
fn decode_uid_exp(token: &str) -> IpcResult<(String, i64)> {
    let payload_b64 = token
        .split('.')
        .nth(1)
        .ok_or_else(|| IpcError::new("CLOUD_TOKEN_INVALID", "access token is not a JWT"))?;
    let raw = decode_b64url(payload_b64)
        .map_err(|e| IpcError::new("CLOUD_TOKEN_INVALID", e.to_string()))?;
    let claims: serde_json::Value = serde_json::from_slice(&raw)
        .map_err(|e| IpcError::new("CLOUD_TOKEN_INVALID", e.to_string()))?;

    // Bambu tokens carry the MQTT username directly as the `username` claim
    // (already `u_<uid>`). Fall back to building it from a `uid`/`userId`.
    let mqtt_username = claims
        .get("username")
        .and_then(|v| v.as_str())
        .filter(|s| s.starts_with("u_"))
        .map(|s| s.to_string())
        .or_else(|| {
            claims
                .get("uid")
                .or_else(|| claims.get("userId"))
                .map(|v| match v {
                    serde_json::Value::String(s) => format!("u_{s}"),
                    other => format!("u_{other}"),
                })
        })
        .ok_or_else(|| IpcError::new("CLOUD_TOKEN_INVALID", "token has no uid/username claim"))?;
    let exp = claims
        .get("exp")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| IpcError::new("CLOUD_TOKEN_INVALID", "token has no exp claim"))?;
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
    fn mqtt_username_prefers_jwt_then_uid_field() {
        let jwt = ("u_jwt".to_string(), 1i64);
        assert_eq!(
            mqtt_username_from(&serde_json::json!({ "uid": 999 }), Some(&jwt)),
            "u_jwt"
        );
        // No JWT → fall back to a uid carried on the response.
        assert_eq!(
            mqtt_username_from(&serde_json::json!({ "uid": 12345 }), None),
            "u_12345"
        );
        assert_eq!(
            mqtt_username_from(&serde_json::json!({ "userId": "777" }), None),
            "u_777"
        );
        // Nothing derivable → empty (status degrades, REST still works).
        assert_eq!(mqtt_username_from(&serde_json::json!({}), None), "");
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
