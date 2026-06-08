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
    AddCloudPrinterRequest, AddPrinterRequest, PrintProgressEvent, PrinterCard, PrinterJob,
    PrinterState, PrinterStatus, PrinterTransport, StartPrintRequest, UploadGcodeRequest,
};
use crate::ipc::{IpcError, IpcResult};
use crate::paths;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

// ---------------------------------------------------------------------------
// Constants from `skills/bambu-labs/references/local-lan-protocol.md`
// ---------------------------------------------------------------------------

const BAMBU_USERNAME: &str = "bblp";
const FTPS_PORT: u16 = 990;
const MQTT_PORT: u16 = 8883;
const REMOTE_DIR: &str = "cache";

/// Tauri event the frontend subscribes to for live print progress (contract §2).
const PRINT_PROGRESS_EVENT: &str = "print_progress";

// SSDP discovery — this is what Bambu printers actually answer on. They
// periodically broadcast `NOTIFY` to the SSDP multicast group on ports 1990
// and 2021 (the ports Bambu Studio/OrcaSlicer listen on) and also reply to
// an `M-SEARCH`. We bind both ports, join the group, prompt with an
// M-SEARCH, and parse whatever lands during the scan window.
const SSDP_MULTICAST: std::net::Ipv4Addr = std::net::Ipv4Addr::new(239, 255, 255, 250);
const SSDP_PORTS: &[u16] = &[1990, 2021];
const SSDP_ST: &str = "urn:bambulab-com:device:3dprinter:1";

// mDNS service types Bambu printers have been observed advertising on some
// hobbyist setups. Most firmware does NOT advertise over Bonjour, so this is
// a best-effort secondary path behind SSDP. We scan both candidates and dedupe.
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
    /// LAN vs cloud. Defaults to `Lan` so records written before cloud
    /// support (no `transport` key) keep working.
    #[serde(default)]
    pub transport: PrinterTransport,
    /// LAN IP. `None` for cloud-only devices. Optional rather than `String`
    /// for the same back-compat reason — legacy records always carry it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ip_address: Option<String>,
    pub host_name: String,
    /// Bambu LAN access code (printer-screen value, ~8 digits). `None` for
    /// cloud devices, which authenticate via the account token instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_code: Option<String>,
    /// Serial number — TLS-cert Common Name (LAN) or `dev_id` (cloud). Used
    /// for the MQTT topic.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
    /// Last-known online flag from the cloud bind list. `None` for LAN.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub online: Option<bool>,
}

impl PrinterRecord {
    pub(crate) fn to_card(&self) -> PrinterCard {
        PrinterCard {
            id: self.id.clone(),
            model: self.model.clone(),
            transport: self.transport,
            ip_address: self.ip_address.clone(),
            host_name: self.host_name.clone(),
            online: self.online,
        }
    }

    /// LAN IP, or a typed error when missing (cloud-only record misrouted to
    /// a LAN code path).
    pub(crate) fn lan_ip(&self) -> IpcResult<&str> {
        self.ip_address
            .as_deref()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| IpcError::new("PRINTER_NO_IP", "printer has no LAN IP address"))
    }

    /// LAN access code, or a typed error when missing.
    pub(crate) fn lan_access_code(&self) -> IpcResult<&str> {
        self.access_code
            .as_deref()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                IpcError::new("PRINTER_NO_ACCESS_CODE", "printer has no LAN access code")
            })
    }

    /// The `dev_id`/serial, or a typed error when missing.
    pub(crate) fn serial_or_err(&self) -> IpcResult<&str> {
        self.serial
            .as_deref()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| IpcError::new("PRINTER_NO_SERIAL", "printer has no serial"))
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
    let timeout = Duration::from_secs(3);
    // SSDP is the path real Bambu printers answer on; mDNS is best-effort.
    // Run both on a blocking thread and merge, preferring SSDP (it carries
    // the serial, so its `id` is stable across scans).
    let scan = tokio::task::spawn_blocking(move || {
        let mut merged: HashMap<String, PrinterCard> = HashMap::new();
        for card in discover_ssdp_blocking(timeout).unwrap_or_default() {
            merged.entry(card.id.clone()).or_insert(card);
        }
        for card in discover_blocking(timeout).unwrap_or_default() {
            merged.entry(card.id.clone()).or_insert(card);
        }
        merged.into_values().collect::<Vec<_>>()
    })
    .await
    .map_err(|e| IpcError::internal(format!("printer scan join error: {e}")))?;
    Ok(scan)
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
        transport: PrinterTransport::Lan,
        ip_address: Some(ip.clone()),
        host_name: ip.clone(),
        access_code: Some(access_code),
        serial,
        online: None,
    };

    persist_add_record(&record).await?;
    let card = record.to_card();
    state.add_printer(card.clone());
    Ok(card)
}

/// Register a cloud printer directly from its serial + access code (no bind-list
/// discovery). The cloud upload/print path authenticates with the signed-in
/// account token; the serial drives the MQTT topic (`device/<serial>/request`)
/// and the access code is stored for completeness / future LAN use.
#[tauri::command]
pub async fn printer_add_cloud(
    req: AddCloudPrinterRequest,
    state: State<'_, AppState>,
) -> IpcResult<PrinterCard> {
    let serial = req.serial.trim().to_string();
    let access_code = req.access_code.trim().to_string();
    if serial.is_empty() {
        return Err(IpcError::invalid_argument("serial is required"));
    }
    if access_code.is_empty() {
        return Err(IpcError::invalid_argument("accessCode is required"));
    }
    let name = req
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    // Namespaced id keeps a cloud record from colliding with a LAN record for
    // the same serial — matches `records_from_bind_response`.
    let record = PrinterRecord {
        id: format!("cloud:{serial}"),
        model: infer_model_from_serial(Some(&serial)).to_string(),
        transport: PrinterTransport::Cloud,
        ip_address: None,
        host_name: name.unwrap_or_else(|| serial.clone()),
        access_code: Some(access_code),
        serial: Some(serial),
        online: None,
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
    let polled = match record.transport {
        PrinterTransport::Lan => poll_printer_status(&record, Duration::from_secs(5)).await,
        PrinterTransport::Cloud => {
            crate::commands::cloud::cloud_printer_status(&record, Duration::from_secs(5)).await
        }
    };
    match polled {
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

    match record.transport {
        PrinterTransport::Lan => upload_via_ftps(&record, &local_path, &remote_name).await,
        PrinterTransport::Cloud => {
            crate::commands::cloud::cloud_upload_file(&record, &local_path, &remote_name).await
        }
    }
}

#[tauri::command]
pub async fn printer_start_print(req: StartPrintRequest, app: AppHandle) -> IpcResult<()> {
    // untested against real printer — verify in field test before v1 ship
    let record = run_start_print(&req).await?;
    // The print is now running. There is no push channel for progress, so spawn
    // a background poller that emits `print_progress` events until the job ends.
    spawn_print_monitor(app, record);
    Ok(())
}

/// Validate the request and issue the start command, returning the targeted
/// record (so the caller can monitor it). Split out from the command so it is
/// testable without an `AppHandle`.
async fn run_start_print(req: &StartPrintRequest) -> IpcResult<PrinterRecord> {
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
    match record.transport {
        PrinterTransport::Lan => {
            let serial = lan_serial(&record).await?;
            let target = lan_mqtt_target(&record, &serial)?;
            let payload = build_start_print_payload(&req.remote_name);
            publish_start_command(&target, &payload, Duration::from_secs(5)).await?;
        }
        PrinterTransport::Cloud => {
            crate::commands::cloud::cloud_start_print(&record, &req.remote_name).await?;
        }
    }
    Ok(record)
}

/// Map the typed `PrinterState` to the lowercase wire string carried by
/// `PrintProgressEvent` / `PrinterStatus` (matches the serde `rename_all`).
fn print_state_str(state: PrinterState) -> &'static str {
    match state {
        PrinterState::Idle => "idle",
        PrinterState::Printing => "printing",
        PrinterState::Paused => "paused",
        PrinterState::Error => "error",
    }
}

/// Poll `printer_status` in the background and emit `print_progress` events so
/// the frontend gets live progress without polling itself. Self-terminating:
/// stops on a terminal state (error, or idle after the job was seen active) or
/// after a cap of idle polls if the job never registers. Best-effort — a poll
/// failure is skipped, and the task is dropped when the app shuts down.
fn spawn_print_monitor(app: AppHandle, record: PrinterRecord) {
    const INTERVAL: Duration = Duration::from_secs(6);
    const POLL_TIMEOUT: Duration = Duration::from_secs(5);
    const MAX_IDLE_POLLS: u32 = 20; // ~2 min of "never started" before giving up
    tauri::async_runtime::spawn(async move {
        let mut saw_active = false;
        let mut polls: u32 = 0;
        // Brief delay so the printer can register the freshly-started job.
        tokio::time::sleep(Duration::from_secs(2)).await;
        loop {
            polls += 1;
            let polled = match record.transport {
                PrinterTransport::Lan => poll_printer_status(&record, POLL_TIMEOUT).await,
                PrinterTransport::Cloud => {
                    crate::commands::cloud::cloud_printer_status(&record, POLL_TIMEOUT).await
                }
            };
            if let Ok(status) = polled {
                let progress = status.job.as_ref().map(|j| j.progress).unwrap_or(0.0);
                let _ = app.emit(
                    PRINT_PROGRESS_EVENT,
                    PrintProgressEvent {
                        printer_id: record.id.clone(),
                        state: print_state_str(status.state).to_string(),
                        progress,
                    },
                );
                match status.state {
                    PrinterState::Printing | PrinterState::Paused => saw_active = true,
                    PrinterState::Error => break,
                    PrinterState::Idle => {
                        if saw_active || polls >= MAX_IDLE_POLLS {
                            break;
                        }
                    }
                }
            } else if !saw_active && polls >= MAX_IDLE_POLLS {
                break;
            }
            tokio::time::sleep(INTERVAL).await;
        }
    });
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

pub(crate) async fn load_printers_file() -> IpcResult<PrintersFile> {
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

pub(crate) async fn save_printers_file(file: &PrintersFile) -> IpcResult<()> {
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

pub(crate) async fn find_record(printer_id: &str) -> IpcResult<Option<PrinterRecord>> {
    let file = load_printers_file().await?;
    Ok(file.printers.into_iter().find(|p| p.id == printer_id))
}

pub(crate) fn upsert_record(file: &mut PrintersFile, record: PrinterRecord) {
    if let Some(existing) = file.printers.iter_mut().find(|p| p.id == record.id) {
        *existing = record;
    } else {
        file.printers.push(record);
    }
}

// ---------------------------------------------------------------------------
// SSDP discovery (primary)
// ---------------------------------------------------------------------------

fn discover_ssdp_blocking(timeout: Duration) -> Result<Vec<PrinterCard>, IpcError> {
    use std::net::{SocketAddr, SocketAddrV4};

    // Bind one socket per SSDP port. A failure on one port (e.g. already in
    // use, or no route) must not abort the whole scan, so we collect the live
    // ones and bail only if none came up.
    let mut sockets = Vec::new();
    for &port in SSDP_PORTS {
        match bind_ssdp_socket(port) {
            Ok(sock) => sockets.push(sock),
            Err(_e) => continue,
        }
    }
    if sockets.is_empty() {
        return Ok(Vec::new());
    }

    // Prompt any printers that answer M-SEARCH; passive NOTIFY broadcasts are
    // caught by the same read loop regardless of whether this elicits a reply.
    let msearch = ssdp_msearch_payload();
    for (sock, &port) in sockets.iter().zip(SSDP_PORTS.iter()) {
        let target = SocketAddr::V4(SocketAddrV4::new(SSDP_MULTICAST, port));
        let _ = sock.send_to(msearch.as_bytes(), target);
    }

    let mut seen: HashMap<String, PrinterCard> = HashMap::new();
    let deadline = std::time::Instant::now() + timeout;
    let mut buf = [0u8; 2048];
    while std::time::Instant::now() < deadline {
        for sock in &sockets {
            match sock.recv_from(&mut buf) {
                Ok((n, _src)) if n > 0 => {
                    let text = String::from_utf8_lossy(&buf[..n]);
                    if let Some(card) = card_from_ssdp_payload(&text) {
                        seen.entry(card.id.clone()).or_insert(card);
                    }
                }
                // WouldBlock/timeout is the common case; just move on.
                Ok(_) | Err(_) => {}
            }
        }
    }
    Ok(seen.into_values().collect())
}

fn bind_ssdp_socket(port: u16) -> std::io::Result<std::net::UdpSocket> {
    use socket2::{Domain, Protocol, Socket, Type};
    use std::net::{Ipv4Addr, SocketAddr};

    let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    // Several apps (and our two sockets) share these well-known ports, and a
    // printer's NOTIFY is a broadcast — so reuse is required to bind at all.
    sock.set_reuse_address(true)?;
    #[cfg(unix)]
    sock.set_reuse_port(true)?;
    let bind_addr = SocketAddr::new(Ipv4Addr::UNSPECIFIED.into(), port);
    sock.bind(&bind_addr.into())?;
    sock.join_multicast_v4(&SSDP_MULTICAST, &Ipv4Addr::UNSPECIFIED)?;
    // Short read timeout so the poll loop sips each socket in turn and honors
    // the overall scan deadline instead of blocking on a quiet port.
    sock.set_read_timeout(Some(Duration::from_millis(200)))?;
    Ok(sock.into())
}

fn ssdp_msearch_payload() -> String {
    format!(
        "M-SEARCH * HTTP/1.1\r\n\
         HOST: {SSDP_MULTICAST}:1990\r\n\
         MAN: \"ssdp:discover\"\r\n\
         MX: 1\r\n\
         ST: {SSDP_ST}\r\n\r\n"
    )
}

/// Parse a Bambu SSDP datagram (`NOTIFY` broadcast or `M-SEARCH` 200 OK).
/// Headers of interest: `Location` (IP), `USN` (serial), `DevModel.bambu.com`
/// (model code), `DevName.bambu.com` (user-given name).
fn card_from_ssdp_payload(text: &str) -> Option<PrinterCard> {
    let mut headers: HashMap<String, String> = HashMap::new();
    for line in text.lines() {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    // Only accept Bambu devices — skip generic UPnP/SSDP chatter on the LAN.
    let is_bambu = headers
        .get("nt")
        .or_else(|| headers.get("st"))
        .map(|v| v.contains("bambulab"))
        .unwrap_or(false)
        || headers.keys().any(|k| k.ends_with(".bambu.com"));
    if !is_bambu {
        return None;
    }

    let ip = headers
        .get("location")
        .map(|s| s.trim_start_matches("http://").trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())?;
    let serial = headers
        .get("usn")
        .cloned()
        .filter(|s| !s.is_empty());
    let name = headers.get("devname.bambu.com").cloned().filter(|s| !s.is_empty());
    let model = headers
        .get("devmodel.bambu.com")
        .map(|code| model_from_dev_model(code, serial.as_deref()))
        .unwrap_or_else(|| infer_model_from_serial(serial.as_deref()).to_string());
    let id = serial
        .clone()
        .unwrap_or_else(|| format!("bambu-{}", ip.replace('.', "-")));
    Some(PrinterCard {
        id,
        model,
        transport: PrinterTransport::Lan,
        ip_address: Some(ip.clone()),
        host_name: name.unwrap_or(ip),
        online: None,
    })
}

/// Map a `DevModel.bambu.com` code to a friendly name, falling back to the
/// serial-prefix heuristic. The label is cosmetic.
fn model_from_dev_model(code: &str, serial: Option<&str>) -> String {
    let upper = code.to_ascii_uppercase();
    let friendly = match upper.as_str() {
        "3DPRINTER-X1-CARBON" | "BL-P001" => Some("X1C"),
        "3DPRINTER-X1" | "BL-P002" => Some("X1"),
        "C11" => Some("P1P"),
        "C12" | "C13" => Some("P1S"),
        "N1" => Some("A1 Mini"),
        "N2S" => Some("A1"),
        _ => None,
    };
    friendly
        .map(str::to_string)
        .unwrap_or_else(|| infer_model_from_serial(serial).to_string())
}

// ---------------------------------------------------------------------------
// mDNS discovery (best-effort secondary)
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
        transport: PrinterTransport::Lan,
        ip_address: Some(ip),
        host_name: host,
        online: None,
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
    let host = record.lan_ip()?.to_string();
    let user = BAMBU_USERNAME.to_string();
    let pass = record.lan_access_code()?.to_string();
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

/// rustls `ClientConfig` for the **cloud** MQTT broker, which presents a
/// real CA-signed certificate. Unlike the LAN printer, this path verifies
/// the chain against the webpki root store — the cloud token is an
/// internet-facing bearer credential, so a no-verify config here would be a
/// MITM exposure.
fn verify_rustls_config_mqtt() -> rumqttc::tokio_rustls::rustls::ClientConfig {
    use rumqttc::tokio_rustls::rustls::{ClientConfig, RootCertStore};
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    ClientConfig::builder()
        .with_root_certificates(roots)
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

pub(crate) fn sequence_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

// ---------------------------------------------------------------------------
// MqttTarget — one descriptor, two transports
// ---------------------------------------------------------------------------

/// Which TLS posture an MQTT connection uses. LAN printers ship self-signed
/// certs (`NoVerify`); the cloud broker presents a real CA cert (`Verify`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MqttTls {
    NoVerify,
    Verify,
}

/// Everything needed to open an MQTT session, independent of LAN vs cloud.
/// Topics are derived from `serial` (`device/{serial}/{report,request}`),
/// identical on both transports.
pub(crate) struct MqttTarget {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub serial: String,
    pub tls: MqttTls,
    /// Broker client id — Bambu's broker drops duplicate ids, so callers make
    /// this unique per connection.
    pub client_id: String,
}

impl MqttTarget {
    fn report_topic(&self) -> String {
        format!("device/{}/report", self.serial)
    }
    fn request_topic(&self) -> String {
        format!("device/{}/request", self.serial)
    }
    fn tls_config(&self) -> rumqttc::tokio_rustls::rustls::ClientConfig {
        match self.tls {
            MqttTls::NoVerify => no_verify_rustls_config_mqtt(),
            MqttTls::Verify => verify_rustls_config_mqtt(),
        }
    }
}

/// LAN MQTT target for a printer record (host=IP, `bblp` + access code,
/// self-signed TLS).
fn lan_mqtt_target(record: &PrinterRecord, serial: &str) -> IpcResult<MqttTarget> {
    Ok(MqttTarget {
        host: record.lan_ip()?.to_string(),
        port: MQTT_PORT,
        username: BAMBU_USERNAME.to_string(),
        password: record.lan_access_code()?.to_string(),
        serial: serial.to_string(),
        tls: MqttTls::NoVerify,
        client_id: format!("panda-desktop-{}", sequence_id()),
    })
}

/// Resolve a LAN printer's serial: prefer the cached value, else scrape it
/// from the printer's TLS cert.
async fn lan_serial(record: &PrinterRecord) -> IpcResult<String> {
    match record.serial.as_deref() {
        Some(s) if !s.is_empty() => Ok(s.to_string()),
        _ => fetch_printer_serial(record.lan_ip()?).await,
    }
}

async fn poll_printer_status(
    record: &PrinterRecord,
    timeout: Duration,
) -> IpcResult<PrinterStatus> {
    let serial = lan_serial(record).await?;
    let target = lan_mqtt_target(record, &serial)?;
    let report = mqtt_request_status(&target, timeout).await?;
    Ok(parse_status_report(&report))
}

/// Connect, request a `pushall`, and return the first status report JSON.
/// Shared by the LAN and cloud status paths — they differ only in the
/// `MqttTarget` (host / credentials / TLS).
pub(crate) async fn mqtt_request_status(
    target: &MqttTarget,
    timeout: Duration,
) -> IpcResult<serde_json::Value> {
    use rumqttc::{AsyncClient, Event, MqttOptions, Packet, QoS, TlsConfiguration, Transport};
    let mut opts = MqttOptions::new(target.client_id.clone(), target.host.clone(), target.port);
    opts.set_credentials(target.username.clone(), target.password.clone());
    opts.set_keep_alive(Duration::from_secs(30));
    opts.set_transport(Transport::Tls(TlsConfiguration::Rustls(Arc::new(
        target.tls_config(),
    ))));

    let (client, mut eventloop) = AsyncClient::new(opts, 16);
    client
        .subscribe(target.report_topic(), QoS::AtMostOnce)
        .await
        .map_err(|e| IpcError::new("MQTT_FAILED", e.to_string()))?;
    let push_all = serde_json::to_vec(&build_status_request_payload())?;
    client
        .publish(target.request_topic(), QoS::AtMostOnce, false, push_all)
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

/// Publish a single command to the printer's request topic and flush it.
/// Shared by LAN and cloud start paths.
pub(crate) async fn publish_start_command(
    target: &MqttTarget,
    payload: &serde_json::Value,
    timeout: Duration,
) -> IpcResult<()> {
    use rumqttc::{AsyncClient, MqttOptions, QoS, TlsConfiguration, Transport};
    let mut opts = MqttOptions::new(
        format!("{}-start", target.client_id),
        target.host.clone(),
        target.port,
    );
    opts.set_credentials(target.username.clone(), target.password.clone());
    opts.set_keep_alive(Duration::from_secs(30));
    opts.set_transport(Transport::Tls(TlsConfiguration::Rustls(Arc::new(
        target.tls_config(),
    ))));
    let (client, mut eventloop) = AsyncClient::new(opts, 16);
    let body = serde_json::to_vec(payload)?;
    client
        .publish(target.request_topic(), QoS::AtLeastOnce, false, body)
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
    fn ssdp_notify_parses_into_card() {
        let notify = "NOTIFY * HTTP/1.1\r\n\
            HOST: 239.255.255.250:1990\r\n\
            Server: UPnP/1.0\r\n\
            Location: 192.168.1.42\r\n\
            NT: urn:bambulab-com:device:3dprinter:1\r\n\
            USN: 0309CA4C0901107\r\n\
            DevModel.bambu.com: N1\r\n\
            DevName.bambu.com: Kitchen A1 Mini\r\n\
            DevConnect.bambu.com: lan\r\n\r\n";
        let card = card_from_ssdp_payload(notify).expect("should parse a Bambu NOTIFY");
        assert_eq!(card.id, "0309CA4C0901107");
        assert_eq!(card.transport, PrinterTransport::Lan);
        assert_eq!(card.ip_address.as_deref(), Some("192.168.1.42"));
        assert_eq!(card.model, "A1 Mini");
        assert_eq!(card.host_name, "Kitchen A1 Mini");
    }

    #[test]
    fn ssdp_strips_http_scheme_and_falls_back_to_serial_model() {
        let notify = "NOTIFY * HTTP/1.1\r\n\
            Location: http://192.168.0.7/\r\n\
            NT: urn:bambulab-com:device:3dprinter:1\r\n\
            USN: 00M00A000000000\r\n\r\n";
        let card = card_from_ssdp_payload(notify).expect("should parse");
        assert_eq!(card.ip_address.as_deref(), Some("192.168.0.7"));
        // No DevModel header -> serial-prefix heuristic (00M = A1 Mini).
        assert_eq!(card.model, "A1 Mini");
        // No DevName -> host_name falls back to the IP.
        assert_eq!(card.host_name, "192.168.0.7");
    }

    #[test]
    fn ssdp_ignores_non_bambu_devices() {
        // A generic UPnP root device must not be treated as a printer.
        let other = "NOTIFY * HTTP/1.1\r\n\
            Location: http://192.168.1.5:80/desc.xml\r\n\
            NT: urn:schemas-upnp-org:device:MediaServer:1\r\n\
            USN: uuid:abcd::urn:schemas-upnp-org:device:MediaServer:1\r\n\r\n";
        assert!(card_from_ssdp_payload(other).is_none());
    }

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
    fn legacy_record_without_transport_defaults_to_lan() {
        // Records written before cloud support have no `transport` key (and
        // string `ipAddress`/`accessCode`). They must still deserialize.
        let legacy = r#"{
            "printers": [
                {
                    "id": "00M00A000000",
                    "model": "A1 Mini",
                    "ipAddress": "192.168.1.34",
                    "hostName": "Bambu-A1M.local",
                    "accessCode": "12345678",
                    "serial": "00M00A000000"
                }
            ]
        }"#;
        let file: PrintersFile = serde_json::from_str(legacy).expect("legacy parses");
        assert_eq!(file.printers.len(), 1);
        let rec = &file.printers[0];
        assert_eq!(rec.transport, PrinterTransport::Lan);
        assert_eq!(rec.ip_address.as_deref(), Some("192.168.1.34"));
        assert_eq!(rec.access_code.as_deref(), Some("12345678"));
        assert!(rec.online.is_none());
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
            transport: PrinterTransport::Lan,
            ip_address: Some("192.168.1.34".into()),
            host_name: "Bambu-A1M.local".into(),
            access_code: Some("12345678".into()),
            serial: Some("00M00A000000".into()),
            online: None,
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
            transport: PrinterTransport::Lan,
            ip_address: Some("10.0.0.10".into()),
            host_name: "x1".into(),
            access_code: Some("AAA".into()),
            serial: Some("x1".into()),
            online: None,
        };
        upsert_record(&mut file, rec.clone());
        rec.access_code = Some("BBB".into());
        upsert_record(&mut file, rec.clone());
        assert_eq!(file.printers.len(), 1);
        assert_eq!(file.printers[0].access_code.as_deref(), Some("BBB"));
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
        let err = run_start_print(&StartPrintRequest {
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
