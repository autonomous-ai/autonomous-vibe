//! `printer_*` IPC commands — real Bambu LAN comms.
//!
//! Track G replaces the canned stub with mDNS discovery (`mdns-sd`),
//! FTPS upload (`suppaftp` with rustls), and MQTT status + start
//! (`rumqttc`). Per the donor `skills/bambu-labs` skill:
//!
//!   - FTPS:   implicit TLS, port 990, user `bblp`, password is the
//!             printer's LAN access code. Plain-gcode uploads land in
//!             `/cache/<job>.gcode` on the printer.
//!   - MQTT:   TLS port 8883, same `bblp` user + access-code auth.
//!             Request topic: `device/{serial}/request`.
//!             Report topic:  `device/{serial}/report`.
//!   - Serial: pulled from the printer's TLS certificate Common Name on
//!             port 8883 (self-signed; we do not verify the cert chain).
//!
//! Storage: `~/Library/Application Support/Panda/bambu-printers.json` (the
//! Bambu access code is sensitive — never log it, never echo it on
//! responses). The path comes from `paths::printers_path()`.

use crate::ipc::types::{
    AddPrinterRequest, PrinterCard, PrinterJob, PrinterState, PrinterStatus, StartPrintRequest,
    UploadGcodeRequest,
};
use crate::ipc::{IpcError, IpcResult};
use crate::paths;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::State;

// ---------------------------------------------------------------------------
// Constants from `skills/bambu-labs/references/local-lan-protocol.md`
// ---------------------------------------------------------------------------

const BAMBU_USERNAME: &str = "bblp";
const FTPS_PORT: u16 = 990;
const MQTT_PORT: u16 = 8883;
const REMOTE_DIR: &str = "cache";

// mDNS service types Bambu printers have been observed advertising on
// hobbyist setups. The skill's protocol doc is silent on the exact type,
// so we scan both candidates and dedupe.
const MDNS_SERVICE_TYPES: &[&str] = &["_bambu._tcp.local.", "_bambulab._tcp.local."];

// ---------------------------------------------------------------------------
// Persistent record (lives in `bambu-printers.json`)
// ---------------------------------------------------------------------------

/// On-disk record; superset of the public `PrinterCard` (it also stores
/// the access code and the cached serial). Never serialize this back to
/// the React client.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrinterRecord {
    pub id: String,
    pub model: String,
    pub ip_address: String,
    pub host_name: String,
    /// Bambu LAN access code (printer-screen value, ~8 digits).
    pub access_code: String,
    /// Serial number (TLS-cert Common Name). Used for the MQTT topic.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
}

impl PrinterRecord {
    fn to_card(&self) -> PrinterCard {
        PrinterCard {
            id: self.id.clone(),
            model: self.model.clone(),
            ip_address: self.ip_address.clone(),
            host_name: self.host_name.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct PrintersFile {
    #[serde(default)]
    pub(crate) printers: Vec<PrinterRecord>,
}

// ---------------------------------------------------------------------------
// Public Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn printer_discover() -> IpcResult<Vec<PrinterCard>> {
    // untested against real printer — verify in field test before v1 ship
    let scan = tokio::task::spawn_blocking(|| discover_blocking(Duration::from_secs(3)))
        .await
        .map_err(|e| IpcError::internal(format!("mDNS scan join error: {e}")))?;
    Ok(scan.unwrap_or_default())
}

#[tauri::command]
pub async fn printer_add(
    req: AddPrinterRequest,
    state: State<'_, AppState>,
) -> IpcResult<PrinterCard> {
    let ip = req.ip_address.trim().to_string();
    let access_code = req.access_code.trim().to_string();
    if ip.is_empty() {
        return Err(IpcError::invalid_argument("ipAddress is required"));
    }
    if access_code.is_empty() {
        return Err(IpcError::invalid_argument("accessCode is required"));
    }

    // Pull the serial off the TLS cert; if the caller gave one, prefer it.
    let serial = match req.serial.as_ref().and_then(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    }) {
        Some(s) => Some(s),
        None => fetch_printer_serial(&ip).await.ok(),
    };

    let id = serial
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("bambu-{}", ip.replace('.', "-")));

    let record = PrinterRecord {
        id: id.clone(),
        model: infer_model_from_serial(serial.as_deref()).to_string(),
        ip_address: ip.clone(),
        host_name: ip.clone(),
        access_code,
        serial,
    };

    persist_add_record(&record).await?;
    let card = record.to_card();
    state.add_printer(card.clone());
    Ok(card)
}

#[tauri::command]
pub async fn printer_list(state: State<'_, AppState>) -> IpcResult<Vec<PrinterCard>> {
    let from_disk = load_printers_file().await.unwrap_or_default();
    // Reconcile in-memory state with the on-disk truth.
    for rec in &from_disk.printers {
        state.add_printer(rec.to_card());
    }
    Ok(from_disk.printers.iter().map(|p| p.to_card()).collect())
}

#[tauri::command]
pub async fn printer_status(printer_id: String) -> IpcResult<PrinterStatus> {
    // untested against real printer — verify in field test before v1 ship
    if printer_id.trim().is_empty() {
        return Err(IpcError::invalid_argument("printerId is required"));
    }
    let record = match find_record(&printer_id).await? {
        Some(r) => r,
        None => {
            return Err(IpcError::new(
                "PRINTER_NOT_FOUND",
                format!("no printer with id {printer_id}"),
            ));
        }
    };
    match poll_printer_status(&record, Duration::from_secs(5)).await {
        Ok(s) => Ok(s),
        Err(_) => Ok(PrinterStatus {
            online: false,
            state: PrinterState::Error,
            job: None,
        }),
    }
}

#[tauri::command]
pub async fn printer_upload_gcode(
    req: UploadGcodeRequest,
    state: State<'_, AppState>,
) -> IpcResult<()> {
    // untested against real printer — verify in field test before v1 ship
    validate_upload_fields(&req)?;
    let record = match find_record(&req.printer_id).await? {
        Some(r) => r,
        None => {
            return Err(IpcError::new(
                "PRINTER_NOT_FOUND",
                format!("no printer with id {}", req.printer_id),
            ));
        }
    };
    let local_path = resolve_gcode_path(state.active_project().as_deref(), &req.gcode_file)?;
    if !local_path.exists() {
        return Err(IpcError::invalid_argument(format!(
            "gcodeFile does not exist on disk: {}",
            local_path.display()
        )));
    }
    let remote_name = req
        .remote_name
        .as_deref()
        .unwrap_or_else(|| {
            local_path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("job.gcode")
        })
        .to_string();

    upload_via_ftps(&record, &local_path, &remote_name).await
}

#[tauri::command]
pub async fn printer_start_print(req: StartPrintRequest) -> IpcResult<()> {
    // untested against real printer — verify in field test before v1 ship
    if !req.confirmed {
        return Err(IpcError::new(
            "CONFIRMATION_REQUIRED",
            "consumer confirmation is required to start a print",
        ));
    }
    if req.printer_id.trim().is_empty() {
        return Err(IpcError::invalid_argument("printerId is required"));
    }
    if req.remote_name.trim().is_empty() {
        return Err(IpcError::invalid_argument("remoteName is required"));
    }
    let record = match find_record(&req.printer_id).await? {
        Some(r) => r,
        None => {
            return Err(IpcError::new(
                "PRINTER_NOT_FOUND",
                format!("no printer with id {}", req.printer_id),
            ));
        }
    };
    let serial = match record.serial.as_deref() {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => fetch_printer_serial(&record.ip_address).await?,
    };
    let payload = build_start_print_payload(&req.remote_name);
    publish_start_command(&record, &serial, &payload, Duration::from_secs(5)).await
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async fn load_printers_file() -> IpcResult<PrintersFile> {
    load_printers_file_at(&paths::printers_path()).await
}

async fn load_printers_file_at(path: &Path) -> IpcResult<PrintersFile> {
    if !path.exists() {
        return Ok(PrintersFile::default());
    }
    let bytes = tokio::fs::read(path).await.map_err(IpcError::from)?;
    if bytes.is_empty() {
        return Ok(PrintersFile::default());
    }
    let parsed: PrintersFile = serde_json::from_slice(&bytes)
        .map_err(|e| IpcError::new("PRINTERS_FILE_PARSE_ERROR", e.to_string()))?;
    Ok(parsed)
}

async fn save_printers_file(file: &PrintersFile) -> IpcResult<()> {
    save_printers_file_at(file, &paths::printers_path()).await
}

async fn save_printers_file_at(file: &PrintersFile, path: &Path) -> IpcResult<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    let bytes = serde_json::to_vec_pretty(file).map_err(IpcError::from)?;
    tokio::fs::write(path, bytes).await.map_err(IpcError::from)?;
    Ok(())
}

async fn persist_add_record(record: &PrinterRecord) -> IpcResult<()> {
    let mut file = load_printers_file().await.unwrap_or_default();
    upsert_record(&mut file, record.clone());
    save_printers_file(&file).await
}

async fn find_record(printer_id: &str) -> IpcResult<Option<PrinterRecord>> {
    let file = load_printers_file().await?;
    Ok(file.printers.into_iter().find(|p| p.id == printer_id))
}

fn upsert_record(file: &mut PrintersFile, record: PrinterRecord) {
    if let Some(existing) = file.printers.iter_mut().find(|p| p.id == record.id) {
        *existing = record;
    } else {
        file.printers.push(record);
    }
}

// ---------------------------------------------------------------------------
// mDNS discovery
// ---------------------------------------------------------------------------

fn discover_blocking(timeout: Duration) -> Result<Vec<PrinterCard>, IpcError> {
    use mdns_sd::{ServiceDaemon, ServiceEvent};
    let daemon = ServiceDaemon::new()
        .map_err(|e| IpcError::new("MDNS_INIT_FAILED", e.to_string()))?;
    let mut receivers = Vec::new();
    for svc in MDNS_SERVICE_TYPES {
        match daemon.browse(svc) {
            Ok(rx) => receivers.push(rx),
            Err(_e) => continue,
        }
    }
    if receivers.is_empty() {
        let _ = daemon.shutdown();
        return Ok(Vec::new());
    }
    let mut seen: HashMap<String, PrinterCard> = HashMap::new();
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        for rx in &receivers {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            // Short, non-blocking sip per receiver. The polling loop is
            // intentionally cheap so a single quiet receiver doesn't
            // starve a chatty one.
            match rx.recv_timeout(Duration::from_millis(150).min(remaining)) {
                Ok(ServiceEvent::ServiceResolved(info)) => {
                    if let Some(card) = card_from_mdns_info(&info) {
                        seen.entry(card.id.clone()).or_insert(card);
                    }
                }
                Ok(_) | Err(_) => {}
            }
        }
    }
    let _ = daemon.shutdown();
    Ok(seen.into_values().collect())
}

fn card_from_mdns_info(info: &mdns_sd::ServiceInfo) -> Option<PrinterCard> {
    let ip = info
        .get_addresses()
        .iter()
        .next()
        .map(|a| a.to_string())?;
    let host = info.get_hostname().to_string();
    let props = collect_txt_properties(info);
    let serial = props
        .get("SN")
        .or_else(|| props.get("serial"))
        .cloned()
        .filter(|s| !s.is_empty());
    let model = props
        .get("DEV_MODEL")
        .or_else(|| props.get("model"))
        .cloned()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Bambu".to_string());
    let id = serial
        .clone()
        .unwrap_or_else(|| format!("bambu-{}", ip.replace('.', "-")));
    Some(PrinterCard {
        id,
        model,
        ip_address: ip,
        host_name: host,
    })
}

fn collect_txt_properties(info: &mdns_sd::ServiceInfo) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for prop in info.get_properties().iter() {
        let k = prop.key().to_string();
        let v = prop.val_str().to_string();
        out.insert(k, v);
    }
    out
}

fn infer_model_from_serial(serial: Option<&str>) -> &'static str {
    // Bambu printer serials are prefixed with a model code: `00M` for
    // A1 Mini, `039`/`03W` for A1, `01P`/`01S` for P1S/P1P, `00W` for X1,
    // etc. This is a heuristic; the user-facing card just needs a label.
    let s = serial.unwrap_or("").to_ascii_uppercase();
    if s.starts_with("00M") {
        "A1 Mini"
    } else if s.starts_with("039") {
        "A1"
    } else if s.starts_with("01P") || s.starts_with("01S") {
        "P1S"
    } else if s.starts_with("00W") || s.starts_with("00C") {
        "X1C"
    } else {
        "Bambu"
    }
}

// ---------------------------------------------------------------------------
// FTPS upload
// ---------------------------------------------------------------------------

async fn upload_via_ftps(
    record: &PrinterRecord,
    local: &Path,
    remote_name: &str,
) -> IpcResult<()> {
    let host = record.ip_address.clone();
    let user = BAMBU_USERNAME.to_string();
    let pass = record.access_code.clone();
    let remote_name = remote_name.to_string();
    let local_buf = local.to_path_buf();
    tokio::task::spawn_blocking(move || ftps_upload_blocking(&host, &user, &pass, &local_buf, &remote_name))
        .await
        .map_err(|e| IpcError::internal(format!("ftps upload join error: {e}")))?
}

fn ftps_upload_blocking(
    host: &str,
    user: &str,
    pass: &str,
    local: &Path,
    remote_name: &str,
) -> IpcResult<()> {
    use std::io::BufReader;
    use suppaftp::types::FileType;
    use suppaftp::{ImplFtpStream, RustlsConnector};

    let config = std::sync::Arc::new(no_verify_rustls_config_suppaftp());
    let connector = RustlsConnector::from(config);

    let addr = format!("{host}:{FTPS_PORT}");
    let stream = ImplFtpStream::connect(&addr)
        .map_err(|e| IpcError::new("FTPS_CONNECT_FAILED", e.to_string()))?;
    let mut ftps = stream
        .into_secure(connector, host)
        .map_err(|e| IpcError::new("FTPS_TLS_FAILED", e.to_string()))?;
    ftps.login(user, pass)
        .map_err(|e| IpcError::new("FTPS_AUTH_FAILED", e.to_string()))?;
    ftps.transfer_type(FileType::Binary)
        .map_err(|e| IpcError::new("FTPS_FAILED", e.to_string()))?;
    // Make sure the remote dir exists; ignore errors (Bambu firmware
    // returns 550 if it already exists).
    let _ = ftps.mkdir(REMOTE_DIR);
    ftps.cwd(REMOTE_DIR)
        .map_err(|e| IpcError::new("FTPS_FAILED", e.to_string()))?;
    let file = std::fs::File::open(local)
        .map_err(|e| IpcError::new("IO_ERROR", e.to_string()))?;
    let mut reader = BufReader::new(file);
    ftps.put_file(remote_name, &mut reader)
        .map_err(|e| IpcError::new("FTPS_UPLOAD_FAILED", e.to_string()))?;
    let _ = ftps.quit();
    Ok(())
}

/// rustls 0.23 `ClientConfig` for the suppaftp side that accepts any
/// server certificate. Bambu printers ship self-signed certs.
fn no_verify_rustls_config_suppaftp() -> suppaftp::rustls::ClientConfig {
    use suppaftp::rustls::client::danger::{
        HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
    };
    use suppaftp::rustls::pki_types::{CertificateDer, ServerName, UnixTime};
    use suppaftp::rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};

    #[derive(Debug)]
    struct NoVerify;
    impl ServerCertVerifier for NoVerify {
        fn verify_server_cert(
            &self,
            _end_entity: &CertificateDer<'_>,
            _intermediates: &[CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp_response: &[u8],
            _now: UnixTime,
        ) -> Result<ServerCertVerified, suppaftp::rustls::Error> {
            Ok(ServerCertVerified::assertion())
        }
        fn verify_tls12_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, suppaftp::rustls::Error> {
            Ok(HandshakeSignatureValid::assertion())
        }
        fn verify_tls13_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, suppaftp::rustls::Error> {
            Ok(HandshakeSignatureValid::assertion())
        }
        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            vec![
                SignatureScheme::RSA_PKCS1_SHA256,
                SignatureScheme::RSA_PKCS1_SHA384,
                SignatureScheme::RSA_PKCS1_SHA512,
                SignatureScheme::ECDSA_NISTP256_SHA256,
                SignatureScheme::ECDSA_NISTP384_SHA384,
                SignatureScheme::ED25519,
            ]
        }
    }

    ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(std::sync::Arc::new(NoVerify))
        .with_no_client_auth()
}

/// rustls 0.22 `ClientConfig` for the rumqttc side that accepts any
/// server certificate. Bambu printers ship self-signed certs.
fn no_verify_rustls_config_mqtt() -> rumqttc::tokio_rustls::rustls::ClientConfig {
    use rumqttc::tokio_rustls::rustls::client::danger::{
        HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
    };
    use rumqttc::tokio_rustls::rustls::pki_types::{CertificateDer, ServerName, UnixTime};
    use rumqttc::tokio_rustls::rustls::{
        ClientConfig, DigitallySignedStruct, SignatureScheme,
    };

    #[derive(Debug)]
    struct NoVerify;
    impl ServerCertVerifier for NoVerify {
        fn verify_server_cert(
            &self,
            _end_entity: &CertificateDer<'_>,
            _intermediates: &[CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp_response: &[u8],
            _now: UnixTime,
        ) -> Result<ServerCertVerified, rumqttc::tokio_rustls::rustls::Error> {
            Ok(ServerCertVerified::assertion())
        }
        fn verify_tls12_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rumqttc::tokio_rustls::rustls::Error> {
            Ok(HandshakeSignatureValid::assertion())
        }
        fn verify_tls13_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rumqttc::tokio_rustls::rustls::Error> {
            Ok(HandshakeSignatureValid::assertion())
        }
        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            vec![
                SignatureScheme::RSA_PKCS1_SHA256,
                SignatureScheme::RSA_PKCS1_SHA384,
                SignatureScheme::RSA_PKCS1_SHA512,
                SignatureScheme::ECDSA_NISTP256_SHA256,
                SignatureScheme::ECDSA_NISTP384_SHA384,
                SignatureScheme::ED25519,
            ]
        }
    }

    ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(std::sync::Arc::new(NoVerify))
        .with_no_client_auth()
}

fn validate_upload_fields(req: &UploadGcodeRequest) -> IpcResult<()> {
    if req.printer_id.trim().is_empty() {
        return Err(IpcError::invalid_argument("printerId is required"));
    }
    if req.gcode_file.trim().is_empty() {
        return Err(IpcError::invalid_argument("gcodeFile is required"));
    }
    Ok(())
}

fn resolve_gcode_path(active_project: Option<&str>, rel_or_abs: &str) -> Result<PathBuf, IpcError> {
    let p = PathBuf::from(rel_or_abs.trim());
    if p.is_absolute() {
        return Ok(p);
    }
    // Relative refs are project-relative (bare catalog paths); resolve
    // them under the open project's dir.
    let id = active_project
        .ok_or_else(|| IpcError::new("NO_ACTIVE_PROJECT", "no project is open"))?;
    paths::resolve_in_project(id, rel_or_abs.trim()).map_err(IpcError::invalid_argument)
}

// ---------------------------------------------------------------------------
// MQTT — status + start
// ---------------------------------------------------------------------------

pub(crate) fn build_start_print_payload(remote_name: &str) -> serde_json::Value {
    // Plain-gcode handoff per `references/local-lan-protocol.md`:
    //
    //   {"print": {"command": "gcode_file", "param": "cache/job.gcode"}}
    //
    // The protocol doc flags this path as diagnostic on some A1 firmware;
    // the consumer flow's pre-flight modal already names the printer
    // model so the user can opt out before this command fires.
    let param = if remote_name.starts_with("cache/") || remote_name.starts_with('/') {
        remote_name.trim_start_matches('/').to_string()
    } else {
        format!("{REMOTE_DIR}/{remote_name}")
    };
    serde_json::json!({
        "print": {
            "sequence_id": sequence_id(),
            "command": "gcode_file",
            "param": param,
        }
    })
}

pub(crate) fn build_status_request_payload() -> serde_json::Value {
    serde_json::json!({
        "pushing": {
            "sequence_id": sequence_id(),
            "command": "pushall",
        }
    })
}

fn sequence_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

async fn poll_printer_status(
    record: &PrinterRecord,
    timeout: Duration,
) -> IpcResult<PrinterStatus> {
    let serial = match record.serial.as_deref() {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => fetch_printer_serial(&record.ip_address).await?,
    };
    let topic_report = format!("device/{serial}/report");
    let topic_request = format!("device/{serial}/request");
    let report = mqtt_request_status(record, &topic_request, &topic_report, timeout).await?;
    Ok(parse_status_report(&report))
}

async fn mqtt_request_status(
    record: &PrinterRecord,
    request_topic: &str,
    report_topic: &str,
    timeout: Duration,
) -> IpcResult<serde_json::Value> {
    use rumqttc::{AsyncClient, Event, MqttOptions, Packet, QoS, TlsConfiguration, Transport};
    let mut opts = MqttOptions::new("panda-desktop", record.ip_address.clone(), MQTT_PORT);
    opts.set_credentials(BAMBU_USERNAME, &record.access_code);
    opts.set_keep_alive(Duration::from_secs(30));
    opts.set_transport(Transport::Tls(TlsConfiguration::Rustls(Arc::new(
        no_verify_rustls_config_mqtt(),
    ))));

    let (client, mut eventloop) = AsyncClient::new(opts, 16);
    client
        .subscribe(report_topic, QoS::AtMostOnce)
        .await
        .map_err(|e| IpcError::new("MQTT_FAILED", e.to_string()))?;
    let push_all = serde_json::to_vec(&build_status_request_payload())?;
    client
        .publish(request_topic, QoS::AtMostOnce, false, push_all)
        .await
        .map_err(|e| IpcError::new("MQTT_FAILED", e.to_string()))?;

    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        let next = tokio::time::timeout(remaining, eventloop.poll()).await;
        match next {
            Ok(Ok(Event::Incoming(Packet::Publish(p)))) => {
                if let Ok(text) = std::str::from_utf8(&p.payload) {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(text) {
                        let _ = client.disconnect().await;
                        return Ok(json);
                    }
                }
            }
            Ok(Ok(_)) => continue,
            Ok(Err(e)) => return Err(IpcError::new("MQTT_FAILED", e.to_string())),
            Err(_) => break,
        }
    }
    Err(IpcError::new(
        "MQTT_TIMEOUT",
        "no status report within timeout",
    ))
}

async fn publish_start_command(
    record: &PrinterRecord,
    serial: &str,
    payload: &serde_json::Value,
    timeout: Duration,
) -> IpcResult<()> {
    use rumqttc::{AsyncClient, MqttOptions, QoS, TlsConfiguration, Transport};
    let topic = format!("device/{serial}/request");
    let mut opts = MqttOptions::new("panda-desktop-start", record.ip_address.clone(), MQTT_PORT);
    opts.set_credentials(BAMBU_USERNAME, &record.access_code);
    opts.set_keep_alive(Duration::from_secs(30));
    opts.set_transport(Transport::Tls(TlsConfiguration::Rustls(Arc::new(
        no_verify_rustls_config_mqtt(),
    ))));
    let (client, mut eventloop) = AsyncClient::new(opts, 16);
    let body = serde_json::to_vec(payload)?;
    client
        .publish(topic, QoS::AtLeastOnce, false, body)
        .await
        .map_err(|e| IpcError::new("MQTT_FAILED", e.to_string()))?;

    // Drive the event loop briefly so the publish actually goes out, but
    // return Ok once it's flushed or we hit the 5s timeout — the upstream
    // UI polls `printer_status` separately for acknowledgment.
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, eventloop.poll()).await {
            Ok(Ok(_)) => continue,
            Ok(Err(_)) => break,
            Err(_) => break,
        }
    }
    let _ = client.disconnect().await;
    Ok(())
}

pub(crate) fn parse_status_report(json: &serde_json::Value) -> PrinterStatus {
    // Bambu pushall reports have shape `{"print": { ... }}` with a
    // `gcode_state` enum (`IDLE`/`RUNNING`/`PAUSE`/`FAILED`/`FINISH`),
    // plus `mc_percent` (0..100) and `mc_remaining_time` (minutes).
    let print = json.get("print");
    let state_str = print
        .and_then(|p| p.get("gcode_state"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let state = match state_str.to_ascii_uppercase().as_str() {
        "RUNNING" | "PRINTING" => PrinterState::Printing,
        "PAUSE" | "PAUSED" => PrinterState::Paused,
        "FAILED" | "ERROR" => PrinterState::Error,
        "IDLE" | "FINISH" | "" => PrinterState::Idle,
        _ => PrinterState::Idle,
    };
    let progress = print
        .and_then(|p| p.get("mc_percent"))
        .and_then(|v| v.as_f64())
        .map(|p| (p / 100.0).clamp(0.0, 1.0))
        .unwrap_or(0.0);
    let eta_seconds = print
        .and_then(|p| p.get("mc_remaining_time"))
        .and_then(|v| v.as_f64())
        .map(|m| m * 60.0)
        .unwrap_or(0.0);
    let name = print
        .and_then(|p| p.get("subtask_name"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let job = if matches!(state, PrinterState::Printing | PrinterState::Paused) || !name.is_empty()
    {
        Some(PrinterJob {
            name,
            progress,
            eta_seconds,
        })
    } else {
        None
    };
    PrinterStatus {
        online: true,
        state,
        job,
    }
}

// ---------------------------------------------------------------------------
// TLS-cert serial fetch
// ---------------------------------------------------------------------------

async fn fetch_printer_serial(host: &str) -> IpcResult<String> {
    let host = host.to_string();
    tokio::task::spawn_blocking(move || fetch_printer_serial_blocking(&host))
        .await
        .map_err(|e| IpcError::internal(format!("serial-fetch join error: {e}")))?
}

fn fetch_printer_serial_blocking(host: &str) -> IpcResult<String> {
    use rumqttc::tokio_rustls::rustls::pki_types::ServerName;
    use rumqttc::tokio_rustls::rustls::ClientConnection;
    use std::io::{Read, Write};
    use std::net::TcpStream;

    let config = Arc::new(no_verify_rustls_config_mqtt());
    let owned_name = host.to_string();
    let server_name = ServerName::try_from(owned_name)
        .map_err(|e| IpcError::new("TLS_INVALID_HOST", e.to_string()))?;
    let mut conn = ClientConnection::new(config, server_name)
        .map_err(|e| IpcError::new("TLS_FAILED", e.to_string()))?;
    let addr = format!("{host}:{MQTT_PORT}");
    let socket_addr = addr
        .to_socket_addrs_first()
        .map_err(|e| IpcError::new("TLS_FAILED", e.to_string()))?;
    let mut sock = TcpStream::connect_timeout(&socket_addr, Duration::from_secs(5))
        .map_err(|e| IpcError::new("TLS_CONNECT_FAILED", e.to_string()))?;
    sock.set_read_timeout(Some(Duration::from_secs(5))).ok();
    sock.set_write_timeout(Some(Duration::from_secs(5))).ok();

    // Drive the handshake by stuffing reads/writes through the
    // rustls::Stream adapter until peer_certificates() is populated. We
    // only need the cert exchange — never actually MQTT-CONNECT.
    let mut stream = rumqttc::tokio_rustls::rustls::Stream::new(&mut conn, &mut sock);
    let _ = stream.flush();
    let mut buf = [0u8; 1];
    let _ = stream.read(&mut buf);

    let certs = conn
        .peer_certificates()
        .ok_or_else(|| IpcError::new("TLS_NO_CERT", "printer did not present a TLS certificate"))?;
    let leaf = certs
        .first()
        .ok_or_else(|| IpcError::new("TLS_NO_CERT", "empty peer cert chain"))?;
    let serial = common_name_from_der(leaf.as_ref())?;
    if serial.is_empty() {
        return Err(IpcError::new(
            "TLS_NO_CERT_CN",
            "printer cert has no CommonName",
        ));
    }
    Ok(serial)
}

fn common_name_from_der(der: &[u8]) -> IpcResult<String> {
    use x509_parser::prelude::*;
    let (_, cert) = X509Certificate::from_der(der)
        .map_err(|e| IpcError::new("TLS_CERT_PARSE_FAILED", e.to_string()))?;
    for attr in cert.subject().iter_common_name() {
        if let Ok(s) = attr.as_str() {
            return Ok(s.to_string());
        }
    }
    Ok(String::new())
}

// Tiny helper: turn "host:port" into the first resolved SocketAddr.
trait SocketAddrFirst {
    fn to_socket_addrs_first(&self) -> std::io::Result<std::net::SocketAddr>;
}

impl SocketAddrFirst for String {
    fn to_socket_addrs_first(&self) -> std::io::Result<std::net::SocketAddr> {
        use std::net::ToSocketAddrs;
        self.to_socket_addrs()?
            .next()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::AddrNotAvailable, "no addr"))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_print_payload_targets_cache_remote_path() {
        let payload = build_start_print_payload("job.gcode");
        assert_eq!(payload["print"]["command"], "gcode_file");
        assert_eq!(payload["print"]["param"], "cache/job.gcode");
        assert!(payload["print"]["sequence_id"].is_string());
    }

    #[test]
    fn start_print_payload_passes_through_full_path() {
        let payload = build_start_print_payload("cache/already.gcode");
        assert_eq!(payload["print"]["param"], "cache/already.gcode");
    }

    #[test]
    fn status_request_payload_uses_pushing_pushall() {
        let payload = build_status_request_payload();
        assert_eq!(payload["pushing"]["command"], "pushall");
        assert!(payload["pushing"]["sequence_id"].is_string());
    }

    #[test]
    fn parses_pushall_report_running_state() {
        let report = serde_json::json!({
            "print": {
                "gcode_state": "RUNNING",
                "mc_percent": 42.5,
                "mc_remaining_time": 30,
                "subtask_name": "lid",
            }
        });
        let status = parse_status_report(&report);
        assert!(status.online);
        assert_eq!(status.state, PrinterState::Printing);
        let job = status.job.expect("job present");
        assert_eq!(job.name, "lid");
        assert!((job.progress - 0.425).abs() < 1e-6);
        assert!((job.eta_seconds - 1800.0).abs() < 1e-6);
    }

    #[test]
    fn parses_pushall_report_idle_state() {
        let report = serde_json::json!({
            "print": { "gcode_state": "IDLE" }
        });
        let status = parse_status_report(&report);
        assert!(status.online);
        assert_eq!(status.state, PrinterState::Idle);
        assert!(status.job.is_none());
    }

    #[test]
    fn parses_pushall_report_failed_maps_to_error() {
        let report = serde_json::json!({
            "print": { "gcode_state": "FAILED" }
        });
        assert_eq!(parse_status_report(&report).state, PrinterState::Error);
    }

    #[test]
    fn add_printer_record_round_trips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bambu-printers.json");
        let record = PrinterRecord {
            id: "00M00A000000".into(),
            model: "A1 Mini".into(),
            ip_address: "192.168.1.34".into(),
            host_name: "Bambu-A1M.local".into(),
            access_code: "12345678".into(),
            serial: Some("00M00A000000".into()),
        };
        let mut file = PrintersFile::default();
        upsert_record(&mut file, record.clone());
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(save_printers_file_at(&file, &path)).unwrap();
        let loaded = rt.block_on(load_printers_file_at(&path)).unwrap();
        assert_eq!(loaded.printers, vec![record]);
    }

    #[test]
    fn upsert_replaces_record_with_same_id() {
        let mut file = PrintersFile::default();
        let mut rec = PrinterRecord {
            id: "x1".into(),
            model: "X1C".into(),
            ip_address: "10.0.0.10".into(),
            host_name: "x1".into(),
            access_code: "AAA".into(),
            serial: Some("x1".into()),
        };
        upsert_record(&mut file, rec.clone());
        rec.access_code = "BBB".into();
        upsert_record(&mut file, rec.clone());
        assert_eq!(file.printers.len(), 1);
        assert_eq!(file.printers[0].access_code, "BBB");
    }

    #[test]
    fn model_inferred_from_serial_prefix() {
        assert_eq!(infer_model_from_serial(Some("00M00A000000")), "A1 Mini");
        assert_eq!(infer_model_from_serial(Some("00W00X000000")), "X1C");
        assert_eq!(infer_model_from_serial(Some("01P00P000000")), "P1S");
        assert_eq!(infer_model_from_serial(None), "Bambu");
    }

    #[tokio::test]
    async fn start_print_requires_confirmation() {
        let err = printer_start_print(StartPrintRequest {
            printer_id: "x1c".into(),
            remote_name: "model.gcode".into(),
            confirmed: false,
        })
        .await
        .unwrap_err();
        assert_eq!(err.code, "CONFIRMATION_REQUIRED");
    }

    #[test]
    fn upload_validates_required_fields() {
        let err = validate_upload_fields(&UploadGcodeRequest {
            printer_id: "".into(),
            gcode_file: "model.gcode".into(),
            remote_name: None,
        })
        .unwrap_err();
        assert_eq!(err.code, "INVALID_ARGUMENT");
    }
}
