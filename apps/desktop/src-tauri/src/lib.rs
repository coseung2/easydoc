use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chacha20poly1305::{
    aead::{Aead, Payload},
    KeyInit, XChaCha20Poly1305, XNonce,
};
use futures_util::{SinkExt, StreamExt};
use hkdf::Hkdf;
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, State, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::DialogExt;
use tokio::{
    fs::{self, File, OpenOptions},
    io::{AsyncReadExt, AsyncWriteExt},
};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use uuid::Uuid;
use x25519_dalek::{PublicKey, StaticSecret};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettings {
    #[serde(default = "default_desktop_alias")]
    desktop_alias: String,
    #[serde(default)]
    paired_count: usize,
    receive_dir: String,
    relay_base_url: String,
    paired: bool,
    connected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingState {
    device_id: String,
    room_id: String,
    public_key: String,
    #[serde(default)]
    desktop_alias: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mobile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mobile_alias: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingPayload {
    version: u8,
    desktop_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    desktop_alias: Option<String>,
    room_id: String,
    public_key: String,
    pairing_token: String,
    expires_at: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingIssue {
    pairing: PairingPayload,
    desktop_secret: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingView {
    qr_payload: String,
    expires_at: u64,
    room_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingSummary {
    room_id: String,
    device_id: String,
    mobile_id: Option<String>,
    mobile_alias: Option<String>,
    authorized: bool,
    connected: bool,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InboxItem {
    filename: String,
    size: u64,
    arrived_at: u64,
    status: String,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum Control {
    #[serde(rename = "transfer:start")]
    Start {
        #[serde(rename = "transferId")]
        transfer_id: String,
        #[serde(rename = "destinationDeviceId")]
        destination_device_id: String,
        name: String,
        size: u64,
        sha256: String,
        #[serde(rename = "chunkSize")]
        chunk_size: u64,
    },
    #[serde(rename = "presence:update")]
    Presence {
        role: String,
        #[serde(rename = "deviceId")]
        device_id: String,
        online: bool,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug)]
struct ReceiveState {
    transfer_id: Uuid,
    name: String,
    expected_size: u64,
    expected_sha256: String,
    chunk_size: u64,
    next_chunk: u32,
    written: u64,
    part_path: PathBuf,
    resume_path: PathBuf,
    transfer_key: [u8; 32],
    file: File,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResumeMeta {
    transfer_id: Uuid,
    name: String,
    expected_size: u64,
    expected_sha256: String,
    chunk_size: u64,
    next_chunk: u32,
    written: u64,
}

struct AppState {
    settings: Mutex<DesktopSettings>,
    pairings: Mutex<Vec<PairingState>>,
    inbox: Mutex<Vec<InboxItem>>,
    receiver_tasks: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
    receiver_status: Mutex<HashMap<String, ReceiverStatus>>,
    pairing_write: tokio::sync::Mutex<()>,
    inbox_write: tokio::sync::Mutex<()>,
    receive_write: tokio::sync::Mutex<()>,
}

#[derive(Debug, Clone, Default)]
struct ReceiverStatus {
    authorized: bool,
    connected: bool,
    last_error: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn default_desktop_alias() -> String {
    "이 PC".into()
}
fn normalized_desktop_alias(alias: &str) -> String {
    let trimmed = alias.trim();
    if trimmed.is_empty() {
        default_desktop_alias()
    } else {
        trimmed.to_string()
    }
}
fn credential_account(kind: &str, id: &str) -> String {
    format!("{}:{}", kind, id)
}
fn store_credential(kind: &str, id: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new("EasyDoc", &credential_account(kind, id))
        .map_err(|e| e.to_string())?
        .set_password(value)
        .map_err(|e| e.to_string())
}
fn load_credential(kind: &str, id: &str) -> Result<String, String> {
    keyring::Entry::new("EasyDoc", &credential_account(kind, id))
        .map_err(|e| e.to_string())?
        .get_password()
        .map_err(|e| e.to_string())
}
fn delete_credential(kind: &str, id: &str) -> Result<(), String> {
    match keyring::Entry::new("EasyDoc", &credential_account(kind, id))
        .map_err(|e| e.to_string())?
        .delete_credential()
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}
fn generate_identity(device_id: &str) -> Result<String, String> {
    let secret = StaticSecret::random_from_rng(OsRng);
    let public = PublicKey::from(&secret);
    store_credential(
        "device-private",
        device_id,
        &URL_SAFE_NO_PAD.encode(secret.to_bytes()),
    )?;
    Ok(URL_SAFE_NO_PAD.encode(public.as_bytes()))
}
fn derive_transfer_key(
    device_id: &str,
    peer_public_key: &str,
    transfer_id: Uuid,
) -> Result<[u8; 32], String> {
    let secret_bytes = URL_SAFE_NO_PAD
        .decode(load_credential("device-private", device_id)?)
        .map_err(|_| "pairing_invalid".to_string())?;
    let secret_array: [u8; 32] = secret_bytes
        .try_into()
        .map_err(|_| "pairing_invalid".to_string())?;
    let peer_bytes = URL_SAFE_NO_PAD
        .decode(peer_public_key)
        .map_err(|_| "pairing_invalid".to_string())?;
    let peer_array: [u8; 32] = peer_bytes
        .try_into()
        .map_err(|_| "pairing_invalid".to_string())?;
    let shared = StaticSecret::from(secret_array).diffie_hellman(&PublicKey::from(peer_array));
    let salt = format!("easydoc-transfer:{}", transfer_id);
    let hk = Hkdf::<Sha256>::new(Some(salt.as_bytes()), shared.as_bytes());
    let mut key = [0u8; 32];
    hk.expand(b"easydoc/x25519+xchacha20poly1305/v1", &mut key)
        .map_err(|_| "pairing_invalid".to_string())?;
    Ok(key)
}
fn decrypt_chunk(
    key: &[u8; 32],
    transfer_id: Uuid,
    chunk_index: u32,
    ciphertext: &[u8],
) -> Result<Vec<u8>, String> {
    let cipher =
        XChaCha20Poly1305::new_from_slice(key).map_err(|_| "pairing_invalid".to_string())?;
    let mut nonce = [0u8; 24];
    nonce[20..].copy_from_slice(&chunk_index.to_be_bytes());
    let aad = format!("easydoc:v1:{}:{}", transfer_id, chunk_index);
    cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: ciphertext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| "chunk_authentication_failed".to_string())
}

fn app_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("EasyDoc")
}
fn default_receive_dir() -> PathBuf {
    dirs::document_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("EasyDoc")
}
fn settings_path() -> PathBuf {
    app_dir().join("settings.json")
}
fn safe_filename(input: &str) -> Result<String, String> {
    let name = input.trim().trim_end_matches([' ', '.']);
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
        || name
            .chars()
            .any(|ch| matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return Err("invalid_filename".into());
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        return Err("invalid_filename".into());
    }
    Ok(name.to_string())
}
fn pairings_path() -> PathBuf {
    app_dir().join("pairings.json")
}
fn legacy_pairing_path() -> PathBuf {
    app_dir().join("pairing.json")
}
fn inbox_path() -> PathBuf {
    app_dir().join("inbox.json")
}

async fn read_json<T: for<'a> Deserialize<'a>>(path: &Path) -> Option<T> {
    serde_json::from_slice(&fs::read(path).await.ok()?).ok()
}
async fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    fs::write(
        path,
        serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?,
    )
    .await
    .map_err(|e| e.to_string())
}

fn parse_pairings(bytes: &[u8]) -> Option<Vec<PairingState>> {
    serde_json::from_slice::<Vec<PairingState>>(bytes)
        .ok()
        .or_else(|| {
            serde_json::from_slice::<PairingState>(bytes)
                .ok()
                .map(|pairing| vec![pairing])
        })
}

fn normalize_pairing(mut pairing: PairingState) -> PairingState {
    pairing.desktop_alias = normalized_desktop_alias(&pairing.desktop_alias);
    pairing.mobile_alias = pairing.mobile_alias.and_then(|alias| {
        let trimmed = alias.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    });
    pairing
}

async fn read_pairings() -> Vec<PairingState> {
    if let Ok(bytes) = fs::read(pairings_path()).await {
        if let Some(pairings) = parse_pairings(&bytes) {
            return pairings.into_iter().map(normalize_pairing).collect();
        }
    }
    let Ok(bytes) = fs::read(legacy_pairing_path()).await else {
        return Vec::new();
    };
    let Some(pairings) = parse_pairings(&bytes) else {
        return Vec::new();
    };
    let pairings = pairings
        .into_iter()
        .map(normalize_pairing)
        .collect::<Vec<_>>();
    let _ = write_json(&pairings_path(), &pairings).await;
    pairings
}

async fn persist_pairings(state: &Arc<AppState>) -> Result<(), String> {
    let _guard = state.pairing_write.lock().await;
    let pairings = state.pairings.lock().unwrap().clone();
    write_json(&pairings_path(), &pairings).await
}

async fn persist_inbox(state: &Arc<AppState>) -> Result<(), String> {
    let _guard = state.inbox_write.lock().await;
    let inbox = state.inbox.lock().unwrap().clone();
    write_json(&inbox_path(), &inbox).await
}

fn load_initial() -> (DesktopSettings, Vec<PairingState>, Vec<InboxItem>) {
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    rt.block_on(async {
        let mut settings = read_json(&settings_path())
            .await
            .unwrap_or(DesktopSettings {
                desktop_alias: default_desktop_alias(),
                paired_count: 0,
                receive_dir: default_receive_dir().to_string_lossy().into_owned(),
                relay_base_url: std::env::var("EASYDOC_RELAY_URL")
                    .unwrap_or_else(|_| "https://easydoc-relay.mdownloader.workers.dev".into()),
                paired: false,
                connected: false,
            });
        settings.desktop_alias = normalized_desktop_alias(&settings.desktop_alias);
        settings.connected = false;
        let pairing = read_pairings().await;
        let inbox = read_json(&inbox_path()).await.unwrap_or_default();
        (
            DesktopSettings {
                paired: !pairing.is_empty(),
                paired_count: pairing.len(),
                ..settings
            },
            pairing,
            inbox,
        )
    })
}

fn refresh_settings_flags(state: &Arc<AppState>) {
    let paired_count = state.pairings.lock().unwrap().len();
    let connected = state
        .receiver_status
        .lock()
        .unwrap()
        .values()
        .any(|value| value.connected);
    let mut settings = state.settings.lock().unwrap();
    settings.paired = paired_count > 0;
    settings.paired_count = paired_count;
    settings.connected = connected;
}

fn update_receiver_status(
    state: &Arc<AppState>,
    room_id: &str,
    authorized: Option<bool>,
    connected: Option<bool>,
    error: Option<String>,
) {
    let mut statuses = state.receiver_status.lock().unwrap();
    let status = statuses.entry(room_id.to_string()).or_default();
    if let Some(value) = authorized {
        status.authorized = value;
    }
    if let Some(value) = connected {
        status.connected = value;
        if value {
            status.last_error = None;
        }
    }
    if error.is_some() {
        status.last_error = error;
    }
    drop(statuses);
    refresh_settings_flags(state);
}

fn remember_mobile_id(state: &Arc<AppState>, room_id: &str, mobile_id: &str) -> bool {
    let mut pairings = state.pairings.lock().unwrap();
    let Some(pairing) = pairings
        .iter_mut()
        .find(|pairing| pairing.room_id == room_id)
    else {
        return false;
    };
    if pairing.mobile_id.as_deref() == Some(mobile_id) {
        return false;
    }
    pairing.mobile_id = Some(mobile_id.to_string());
    true
}

fn pairing_summaries(state: &Arc<AppState>) -> Vec<PairingSummary> {
    let pairings = state.pairings.lock().unwrap().clone();
    let statuses = state.receiver_status.lock().unwrap();
    pairings
        .into_iter()
        .map(|pairing| {
            let status = statuses.get(&pairing.room_id).cloned().unwrap_or_default();
            PairingSummary {
                room_id: pairing.room_id.clone(),
                device_id: pairing.device_id,
                mobile_id: pairing.mobile_id.clone(),
                mobile_alias: pairing.mobile_alias,
                authorized: status.authorized || pairing.mobile_id.is_some(),
                connected: status.connected,
                error: status.last_error.clone(),
            }
        })
        .collect()
}

fn abort_receiver(state: &Arc<AppState>, room_id: &str) {
    if let Some(task) = state.receiver_tasks.lock().unwrap().remove(room_id) {
        task.abort();
    }
    state.receiver_status.lock().unwrap().remove(room_id);
    refresh_settings_flags(state);
}

#[tauri::command]
fn list_pairings(state: State<'_, Arc<AppState>>) -> Vec<PairingSummary> {
    pairing_summaries(state.inner())
}

fn abort_all_receivers(state: &Arc<AppState>) {
    let tasks = state
        .receiver_tasks
        .lock()
        .unwrap()
        .drain()
        .map(|(_, task)| task)
        .collect::<Vec<_>>();
    for task in tasks {
        task.abort();
    }
    state.receiver_status.lock().unwrap().clear();
    refresh_settings_flags(state);
}

#[tauri::command]
fn get_settings(state: State<'_, Arc<AppState>>) -> DesktopSettings {
    refresh_settings_flags(state.inner());
    state.settings.lock().unwrap().clone()
}
#[tauri::command]
fn list_inbox(state: State<'_, Arc<AppState>>) -> Vec<InboxItem> {
    state.inbox.lock().unwrap().clone()
}

#[tauri::command]
async fn set_desktop_alias(
    state: State<'_, Arc<AppState>>,
    desktop_alias: String,
) -> Result<DesktopSettings, String> {
    let alias = desktop_alias.trim();
    if alias.is_empty() || alias.chars().count() > 80 {
        return Err("invalid_desktop_alias".into());
    }
    let snapshot = {
        let mut settings = state.settings.lock().unwrap();
        settings.desktop_alias = alias.to_string();
        settings.clone()
    };
    write_json(&settings_path(), &snapshot).await?;
    let pairings = {
        let mut pairings = state.pairings.lock().unwrap().clone();
        for pairing in &mut pairings {
            pairing.desktop_alias = alias.to_string();
        }
        pairings
    };
    *state.pairings.lock().unwrap() = pairings;
    persist_pairings(state.inner()).await?;
    Ok(snapshot)
}

#[tauri::command]
async fn choose_receive_dir(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<Option<String>, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    let Some(path) = picked.and_then(|value| value.as_path().map(Path::to_path_buf)) else {
        return Ok(None);
    };
    fs::create_dir_all(&path).await.map_err(|e| e.to_string())?;
    let snapshot = {
        let mut settings = state.settings.lock().unwrap();
        settings.receive_dir = path.to_string_lossy().into_owned();
        settings.clone()
    };
    write_json(&settings_path(), &snapshot).await?;
    Ok(Some(snapshot.receive_dir))
}

#[tauri::command]
async fn create_pairing(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<PairingView, String> {
    let settings = state.settings.lock().unwrap().clone();
    let device_id = format!("desktop_{}", Uuid::new_v4());
    let public_key = generate_identity(&device_id)?;
    let client = reqwest::Client::new();
    let issue: PairingIssue = client
        .post(format!(
            "{}/pairing/issue",
            settings.relay_base_url.trim_end_matches('/')
        ))
        .json(&serde_json::json!({"desktopId": device_id, "publicKey": public_key}))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let mut pairing_payload = issue.pairing;
    pairing_payload.desktop_alias = Some(normalized_desktop_alias(&settings.desktop_alias));
    store_credential(
        "pairing-bootstrap",
        &pairing_payload.room_id,
        &issue.desktop_secret,
    )?;
    let pairing_state = PairingState {
        device_id: pairing_payload.desktop_id.clone(),
        room_id: pairing_payload.room_id.clone(),
        public_key: pairing_payload.public_key.clone(),
        desktop_alias: pairing_payload
            .desktop_alias
            .clone()
            .unwrap_or_else(default_desktop_alias),
        mobile_id: None,
        mobile_alias: None,
    };
    state.pairings.lock().unwrap().push(pairing_state);
    persist_pairings(state.inner()).await?;
    refresh_settings_flags(state.inner());
    start_receiver_supervisor(app, state.inner().clone());
    Ok(PairingView {
        qr_payload: serde_json::to_string(&pairing_payload).map_err(|e| e.to_string())?,
        expires_at: pairing_payload.expires_at,
        room_id: pairing_payload.room_id,
    })
}

#[tauri::command]
async fn set_pairing_label(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    mobile_alias: String,
) -> Result<Vec<PairingSummary>, String> {
    let label = mobile_alias.trim();
    if label.chars().count() > 80 {
        return Err("invalid_mobile_alias".into());
    }
    let label = (!label.is_empty()).then(|| label.to_string());
    {
        let mut pairings = state.pairings.lock().unwrap();
        let pairing = pairings
            .iter_mut()
            .find(|pairing| pairing.room_id == room_id)
            .ok_or("pairing_not_found")?;
        pairing.mobile_alias = label;
    }
    persist_pairings(state.inner()).await?;
    Ok(pairing_summaries(state.inner()))
}

async fn revoke_remote_pairing(
    settings: &DesktopSettings,
    pairing: &PairingState,
) -> Result<(), String> {
    let session = match session_token(settings, pairing).await {
        Ok(session) => session,
        Err(error) if error == "pairing_invalid" => return Ok(()),
        Err(error) => return Err(error),
    };
    let response = reqwest::Client::new()
        .post(format!(
            "{}/pairing/revoke",
            settings.relay_base_url.trim_end_matches('/')
        ))
        .bearer_auth(session.token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if response.status().is_success() {
        Ok(())
    } else {
        let status = response.status();
        let error = response
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| format!("relay_http_{}", status.as_u16()));
        Err(error)
    }
}

#[tauri::command]
async fn revoke_pairing(state: State<'_, Arc<AppState>>, room_id: String) -> Result<(), String> {
    let settings = state.settings.lock().unwrap().clone();
    let pairing = state
        .pairings
        .lock()
        .unwrap()
        .iter()
        .find(|pairing| pairing.room_id == room_id)
        .cloned()
        .ok_or("pairing_not_found")?;
    if let Err(error) = revoke_remote_pairing(&settings, &pairing).await {
        let missing_credential = error.to_lowercase().contains("no matching entry") || error.to_lowercase().contains("no entry");
        if !missing_credential && error != "pairing_invalid" { return Err(error); }
    }
    delete_credential("pairing-bootstrap", &pairing.room_id)?;
    let delete_identity = {
        let mut pairings = state.pairings.lock().unwrap();
        pairings.retain(|item| item.room_id != room_id);
        !pairings
            .iter()
            .any(|item| item.device_id == pairing.device_id)
    };
    abort_receiver(state.inner(), &room_id);
    persist_pairings(state.inner()).await?;
    if delete_identity {
        delete_credential("device-private", &pairing.device_id)?;
    }
    refresh_settings_flags(state.inner());
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionResponse {
    token: String,
    peer_public_key: String,
    #[serde(default)]
    peer_device_id: Option<String>,
}
async fn session_token(
    settings: &DesktopSettings,
    pairing: &PairingState,
) -> Result<SessionResponse, String> {
    let bootstrap = load_credential("pairing-bootstrap", &pairing.room_id)?;
    let response = reqwest::Client::new()
        .post(format!(
            "{}/pairing/session",
            settings.relay_base_url.trim_end_matches('/')
        ))
        .json(&serde_json::json!({
            "roomId": pairing.room_id,
            "role": "desktop",
            "deviceId": pairing.device_id,
            "bootstrapSecret": bootstrap
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    if !status.is_success() {
        let error = response
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| format!("relay_http_{}", status.as_u16()));
        return Err(error);
    }
    response.json().await.map_err(|e| e.to_string())
}

fn ws_url(base: &str, token: &str) -> Result<String, String> {
    let mut url = url::Url::parse(base).map_err(|e| e.to_string())?;
    url.set_scheme(if url.scheme() == "https" { "wss" } else { "ws" })
        .map_err(|_| "invalid relay scheme".to_string())?;
    url.set_path("/connect");
    url.set_query(Some(&format!("token={}", token)));
    Ok(url.to_string())
}

async fn unique_destination(root: &Path, name: &str) -> PathBuf {
    let candidate = root.join(name);
    if fs::metadata(&candidate).await.is_err() {
        return candidate;
    }
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("scan");
    let ext = path.extension().and_then(|v| v.to_str());
    for n in 1..10000 {
        let filename = match ext {
            Some(ext) => format!("{} ({}).{}", stem, n, ext),
            None => format!("{} ({})", stem, n),
        };
        let next = root.join(filename);
        if fs::metadata(&next).await.is_err() {
            return next;
        }
    }
    root.join(format!("{}_{}", Uuid::new_v4(), name))
}

async fn finalize(receive: ReceiveState, root: &Path) -> Result<(InboxItem, String), String> {
    receive.file.sync_all().await.map_err(|e| e.to_string())?;
    drop(receive.file);
    let mut source = File::open(&receive.part_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = source.read(&mut buffer).await.map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let digest = hex::encode(hasher.finalize());
    if digest != receive.expected_sha256 {
        return Err("checksum_mismatch".into());
    }
    let final_path = unique_destination(root, &receive.name).await;
    fs::rename(&receive.part_path, &final_path)
        .await
        .map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&receive.resume_path).await;
    Ok((
        InboxItem {
            filename: final_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            size: receive.expected_size,
            arrived_at: now_ms(),
            status: "completed".into(),
            path: final_path.to_string_lossy().into_owned(),
        },
        digest,
    ))
}

async fn receiver_loop(
    app: tauri::AppHandle,
    state: Arc<AppState>,
    settings: DesktopSettings,
    pairing: PairingState,
) -> Result<(), String> {
    let room_id = pairing.room_id.clone();
    let result = receiver_connection(app, state.clone(), settings, pairing).await;
    if matches!(result, Err(ref error) if error == "pairing_invalid") {
        update_receiver_status(&state, &room_id, Some(false), Some(false), Some(result.clone().unwrap_err()));
    } else {
        update_receiver_status(&state, &room_id, None, Some(false), result.as_ref().err().cloned());
    }
    result
}

async fn receiver_connection(
    app: tauri::AppHandle,
    state: Arc<AppState>,
    settings: DesktopSettings,
    pairing: PairingState,
) -> Result<(), String> {
    let session = session_token(&settings, &pairing).await?;
    update_receiver_status(&state, &pairing.room_id, Some(true), Some(false), None);
    let peer_public_key = session.peer_public_key.clone();
    if let Some(peer_device_id) = session.peer_device_id.as_deref() {
        if remember_mobile_id(&state, &pairing.room_id, peer_device_id) {
            persist_pairings(&state).await?;
        }
    }
    let (socket, _) = connect_async(ws_url(&settings.relay_base_url, &session.token)?)
        .await
        .map_err(|e| e.to_string())?;
    let (mut write, mut read) = socket.split();
    update_receiver_status(&state, &pairing.room_id, Some(true), Some(true), None);
    let root = PathBuf::from(&settings.receive_dir);
    fs::create_dir_all(&root).await.map_err(|e| e.to_string())?;
    let mut current: Option<ReceiveState> = None;
    while let Some(message) = read.next().await {
        match message.map_err(|e| e.to_string())? {
            Message::Text(text) => match serde_json::from_str::<Control>(&text) {
                Ok(Control::Presence {
                    role,
                    device_id,
                    online,
                }) => {
                    if role == "mobile"
                        && online
                        && remember_mobile_id(&state, &pairing.room_id, &device_id)
                    {
                        persist_pairings(&state).await?;
                    }
                }
                Ok(Control::Start {
                    transfer_id,
                    destination_device_id,
                    name,
                    size,
                    sha256,
                    chunk_size,
                }) => {
                    if destination_device_id != pairing.device_id {
                        write.send(Message::Text(serde_json::json!({"type":"transfer:reject","transferId":transfer_id,"reason":"destination_offline"}).to_string().into())).await.map_err(|e|e.to_string())?;
                        continue;
                    }
                    let safe_name = match safe_filename(&name) {
                        Ok(value) => value,
                        Err(_) => {
                            write.send(Message::Text(serde_json::json!({"type":"transfer:reject","transferId":transfer_id,"reason":"write_failed"}).to_string().into())).await.map_err(|e|e.to_string())?;
                            continue;
                        }
                    };
                    let id = Uuid::parse_str(&transfer_id)
                        .map_err(|_| "transfer_not_found".to_string())?;
                    let part_path = root.join(format!(".easydoc-{}.part", id));
                    let resume_path = root.join(format!(".easydoc-{}.json", id));
                    let previous: Option<ResumeMeta> = read_json(&resume_path).await;
                    let valid = previous.filter(|meta| {
                        meta.transfer_id == id
                            && meta.expected_size == size
                            && meta.expected_sha256 == sha256
                            && meta.chunk_size == chunk_size
                            && meta.name == safe_name
                    });
                    let (next_chunk, written) = valid
                        .as_ref()
                        .map(|meta| (meta.next_chunk, meta.written))
                        .unwrap_or((0, 0));
                    let available = fs2::available_space(&root).map_err(|e| e.to_string())?;
                    if available < size.saturating_sub(written) {
                        write.send(Message::Text(serde_json::json!({"type":"transfer:reject","transferId":transfer_id,"reason":"insufficient_space"}).to_string().into())).await.map_err(|e|e.to_string())?;
                        continue;
                    }
                    let file = OpenOptions::new()
                        .create(true)
                        .write(true)
                        .append(next_chunk > 0)
                        .truncate(next_chunk == 0)
                        .open(&part_path)
                        .await
                        .map_err(|e| e.to_string())?;
                    let transfer_key =
                        derive_transfer_key(&pairing.device_id, &peer_public_key, id)?;
                    current = Some(ReceiveState {
                        transfer_id: id,
                        name: safe_name.clone(),
                        expected_size: size,
                        expected_sha256: sha256.clone(),
                        chunk_size,
                        next_chunk,
                        written,
                        part_path,
                        resume_path: resume_path.clone(),
                        transfer_key,
                        file,
                    });
                    let meta = ResumeMeta {
                        transfer_id: id,
                        name: safe_name,
                        expected_size: size,
                        expected_sha256: sha256,
                        chunk_size,
                        next_chunk,
                        written,
                    };
                    write_json(&resume_path, &meta).await?;
                    write.send(Message::Text(serde_json::json!({"type":"transfer:accept","transferId":transfer_id,"resumeFromChunk":next_chunk}).to_string().into())).await.map_err(|e|e.to_string())?;
                }
                _ => {}
            },
            Message::Binary(frame) => {
                if let Some(receive) = current.as_mut() {
                    if frame.len() < 26 || frame[0] != 1 || frame[1] != 1 {
                        continue;
                    }
                    let id = Uuid::from_slice(&frame[2..18])
                        .map_err(|_| "transfer_not_found".to_string())?;
                    let index = u32::from_be_bytes(frame[18..22].try_into().unwrap());
                    let length = u32::from_be_bytes(frame[22..26].try_into().unwrap()) as usize;
                    if id != receive.transfer_id || frame.len() != 26 + length {
                        continue;
                    }
                    if index == receive.next_chunk {
                        let plaintext = decrypt_chunk(
                            &receive.transfer_key,
                            receive.transfer_id,
                            index,
                            &frame[26..],
                        )?;
                        if plaintext.len() as u64 > receive.chunk_size {
                            return Err("invalid_payload_length".into());
                        }
                        receive
                            .file
                            .write_all(&plaintext)
                            .await
                            .map_err(|e| e.to_string())?;
                        receive.written += plaintext.len() as u64;
                        receive.next_chunk += 1;
                        if receive.next_chunk % 8 == 0 {
                            receive.file.sync_data().await.map_err(|e| e.to_string())?;
                        }
                        let meta = ResumeMeta {
                            transfer_id: receive.transfer_id,
                            name: receive.name.clone(),
                            expected_size: receive.expected_size,
                            expected_sha256: receive.expected_sha256.clone(),
                            chunk_size: receive.chunk_size,
                            next_chunk: receive.next_chunk,
                            written: receive.written,
                        };
                        write_json(&receive.resume_path, &meta).await?;
                    }
                    write.send(Message::Text(serde_json::json!({"type":"transfer:ack","transferId":receive.transfer_id,"receivedThroughChunk":receive.next_chunk as i64-1}).to_string().into())).await.map_err(|e|e.to_string())?;
                    if receive.written == receive.expected_size {
                        let done = current.take().unwrap();
                        let _receive_guard = state.receive_write.lock().await;
                        let transfer_id = done.transfer_id;
                        let (item, digest) = finalize(done, &root).await?;
                        state.inbox.lock().unwrap().insert(0, item.clone());
                        persist_inbox(&state).await?;
                        write.send(Message::Text(serde_json::json!({"type":"transfer:complete","transferId":transfer_id,"bytes":item.size,"sha256":digest}).to_string().into())).await.map_err(|e|e.to_string())?;
                        let _ = tauri_plugin_notification::NotificationExt::notification(&app)
                            .builder()
                            .title("EasyDoc")
                            .body(format!("{} 수신 완료", item.filename))
                            .show();
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    Ok(())
}

fn start_receiver_supervisor(app: tauri::AppHandle, state: Arc<AppState>) {
    let pairings = state
        .pairings
        .lock()
        .unwrap()
        .iter()
        .map(|pairing| pairing.room_id.clone())
        .collect::<Vec<_>>();
    let mut tasks = state.receiver_tasks.lock().unwrap();
    for room_id in pairings {
        if tasks.contains_key(&room_id) {
            continue;
        }
        let task_state = state.clone();
        let task_app = app.clone();
        let task_room_id = room_id.clone();
        let task = tauri::async_runtime::spawn(async move {
            loop {
                let pairing = task_state
                    .pairings
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|pairing| pairing.room_id == task_room_id)
                    .cloned();
                let Some(pairing) = pairing else {
                    break;
                };
                let settings = task_state.settings.lock().unwrap().clone();
                let _receiver_result =
                    receiver_loop(task_app.clone(), task_state.clone(), settings, pairing).await;
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            }
            task_state
                .receiver_tasks
                .lock()
                .unwrap()
                .remove(&task_room_id);
        });
        tasks.insert(room_id, task);
    }
}

#[tauri::command]
async fn connect_receiver(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if state.pairings.lock().unwrap().is_empty() {
        return Err("pairing_invalid".into());
    }
    start_receiver_supervisor(app, state.inner().clone());
    Ok(())
}

#[tauri::command]
async fn rename_file(
    state: State<'_, Arc<AppState>>,
    path: String,
    new_name: String,
) -> Result<InboxItem, String> {
    let _receive_guard = state.receive_write.lock().await;
    let trimmed = safe_filename(&new_name)?;
    let current = PathBuf::from(&path);
    let parent = current.parent().ok_or("invalid_path")?;
    let target = parent.join(&trimmed);
    if fs::metadata(&target).await.is_ok() {
        return Err("filename_exists".into());
    }
    fs::rename(&current, &target)
        .await
        .map_err(|e| e.to_string())?;
    let updated = {
        let mut inbox = state.inbox.lock().unwrap();
        let item = inbox
            .iter_mut()
            .find(|item| item.path == path)
            .ok_or("transfer_not_found")?;
        item.filename = trimmed.to_string();
        item.path = target.to_string_lossy().into_owned();
        item.clone()
    };
    persist_inbox(state.inner()).await?;
    Ok(updated)
}

#[tauri::command]
async fn delete_file(state: State<'_, Arc<AppState>>, path: String) -> Result<(), String> {
    let _receive_guard = state.receive_write.lock().await;
    fs::remove_file(&path).await.map_err(|e| e.to_string())?;
    state.inbox.lock().unwrap().retain(|item| item.path != path);
    persist_inbox(state.inner()).await
}

#[tauri::command]
fn print_file(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let result = std::process::Command::new("powershell.exe")
            .env("EASYDOC_PRINT_PATH", &path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:EASYDOC_PRINT_PATH -Verb Print",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| e.to_string())?;
        if result.status.success() { Ok(()) } else { Err("print_failed".into()) }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("print_unsupported".into())
    }
}

#[tauri::command]
fn hide_window(app: tauri::AppHandle) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or("window_not_found")?
        .hide()
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn reveal_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let parent = Path::new(&path)
        .parent()
        .unwrap_or(Path::new(&path))
        .to_string_lossy()
        .into_owned();
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_path(parent, None::<&str>)
        .map_err(|e| e.to_string())
}

pub fn run() {
    let (settings, pairings, inbox) = load_initial();
    let receiver_status = pairings
        .iter()
        .map(|pairing| {
            (
                pairing.room_id.clone(),
                ReceiverStatus {
                    authorized: pairing.mobile_id.is_some(),
                    connected: false,
                    last_error: None,
                },
            )
        })
        .collect();
    let state = Arc::new(AppState {
        settings: Mutex::new(settings),
        pairings: Mutex::new(pairings),
        inbox: Mutex::new(inbox),
        receiver_tasks: Mutex::new(HashMap::new()),
        receiver_status: Mutex::new(receiver_status),
        pairing_write: tokio::sync::Mutex::new(()),
        inbox_write: tokio::sync::Mutex::new(()),
        receive_write: tokio::sync::Mutex::new(()),
    });
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .setup(|app| {
            let _ = app.autolaunch().enable();
            let show_i = MenuItem::with_id(app, "show", "EasyDoc 열기", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            let shared = app.state::<Arc<AppState>>().inner().clone();
            start_receiver_supervisor(app.handle().clone(), shared);
            let background = std::env::args().any(|arg| arg == "--background");
            if !background {
                if let Some(window) = app.get_webview_window("main") {
                    window.show()?;
                    window.set_focus()?;
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            list_inbox,
            list_pairings,
            set_desktop_alias,
            choose_receive_dir,
            create_pairing,
            set_pairing_label,
            revoke_pairing,
            connect_receiver,
            rename_file,
            delete_file,
            print_file,
            hide_window,
            open_path,
            reveal_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running EasyDoc");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_settings_default_to_a_local_alias() {
        let settings: DesktopSettings = serde_json::from_str(
            r#"{"receiveDir":"C:/EasyDoc","relayBaseUrl":"https://example.test","paired":false,"connected":false}"#,
        )
        .unwrap();
        assert_eq!(settings.desktop_alias, "이 PC");
    }

    #[test]
    fn legacy_pairing_state_gets_alias_when_normalized() {
        let mut pairing: PairingState = serde_json::from_str(
            r#"{"deviceId":"desktop_old","roomId":"room_old","publicKey":"public-key"}"#,
        )
        .unwrap();
        pairing.desktop_alias = normalized_desktop_alias(&pairing.desktop_alias);
        assert_eq!(pairing.desktop_alias, "이 PC");
        assert_eq!(
            serde_json::to_value(pairing).unwrap()["desktopAlias"],
            "이 PC"
        );
    }

    #[test]
    fn pairing_storage_migrates_one_legacy_object_and_preserves_multiple_pairings() {
        let legacy = r#"{"deviceId":"desktop_old","roomId":"room_old","publicKey":"public-key","mobileId":"phone_old","mobileAlias":"  교무실 휴대폰  "}"#;
        let pairings = parse_pairings(legacy.as_bytes())
            .unwrap()
            .into_iter()
            .map(normalize_pairing)
            .collect::<Vec<_>>();
        assert_eq!(pairings.len(), 1);
        assert_eq!(pairings[0].mobile_id.as_deref(), Some("phone_old"));
        assert_eq!(pairings[0].mobile_alias.as_deref(), Some("교무실 휴대폰"));

        let mut pairings = pairings;
        pairings.push(PairingState {
            device_id: "desktop_new".into(),
            room_id: "room_new".into(),
            public_key: "new-public-key".into(),
            desktop_alias: "이 PC".into(),
            mobile_id: Some("phone_new".into()),
            mobile_alias: None,
        });
        let stored = serde_json::to_value(&pairings).unwrap();
        assert!(stored.is_array());
        assert_eq!(stored.as_array().unwrap().len(), 2);
        assert_eq!(stored[1]["roomId"], "room_new");
    }

    #[test]
    fn transfer_start_keeps_destination_device_binding() {
        let control: Control = serde_json::from_str(
            r#"{"type":"transfer:start","transferId":"123e4567-e89b-42d3-a456-426614174000","destinationDeviceId":"desktop_room_b","name":"scan.pdf","size":4,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","chunkSize":4}"#,
        )
        .unwrap();
        match control {
            Control::Start {
                destination_device_id,
                ..
            } => assert_eq!(destination_device_id, "desktop_room_b"),
            _ => panic!("expected transfer start"),
        }
    }

    #[test]
    fn connection_status_stays_online_until_the_last_room_disconnects() {
        let pairings = vec![
            PairingState {
                device_id: "desktop_a".into(),
                room_id: "room_a".into(),
                public_key: "key_a".into(),
                desktop_alias: default_desktop_alias(),
                mobile_id: Some("mobile_a".into()),
                mobile_alias: None,
            },
            PairingState {
                device_id: "desktop_b".into(),
                room_id: "room_b".into(),
                public_key: "key_b".into(),
                desktop_alias: default_desktop_alias(),
                mobile_id: Some("mobile_b".into()),
                mobile_alias: None,
            },
        ];
        let state = Arc::new(AppState {
            settings: Mutex::new(DesktopSettings {
                desktop_alias: default_desktop_alias(),
                paired_count: pairings.len(),
                receive_dir: "C:/EasyDoc".into(),
                relay_base_url: "https://example.test".into(),
                paired: true,
                connected: false,
            }),
            pairings: Mutex::new(pairings),
            inbox: Mutex::new(Vec::new()),
            receiver_tasks: Mutex::new(HashMap::new()),
            receiver_status: Mutex::new(HashMap::new()),
            pairing_write: tokio::sync::Mutex::new(()),
            inbox_write: tokio::sync::Mutex::new(()),
            receive_write: tokio::sync::Mutex::new(()),
        });
        update_receiver_status(&state, "room_a", Some(true), Some(true), None);
        update_receiver_status(&state, "room_b", Some(true), Some(true), None);
        update_receiver_status(&state, "room_a", None, Some(false), Some("network_error".into()));
        assert!(state.settings.lock().unwrap().connected);
        update_receiver_status(&state, "room_b", None, Some(false), None);
        assert!(!state.settings.lock().unwrap().connected);
    }
}
