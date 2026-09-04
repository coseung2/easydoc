use std::{path::{Path, PathBuf}, sync::{Arc, Mutex}, time::{SystemTime, UNIX_EPOCH}};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::{fs::{self, File, OpenOptions}, io::AsyncWriteExt};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettings { receive_dir: String, relay_base_url: String, paired: bool, connected: bool }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingState { device_id: String, room_id: String, desktop_secret: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingPayload { version: u8, desktop_id: String, room_id: String, public_key: String, pairing_token: String, expires_at: u64 }

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingIssue { pairing: PairingPayload, desktop_secret: String }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingView { qr_payload: String, expires_at: u64 }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InboxItem { filename: String, size: u64, arrived_at: u64, status: String, path: String }

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum Control {
  #[serde(rename = "transfer:start")]
  Start { #[serde(rename="transferId")] transfer_id: String, name: String, size: u64, sha256: String, #[serde(rename="chunkSize")] chunk_size: u64 },
  #[serde(other)] Other,
}

#[derive(Debug)]
struct ReceiveState { transfer_id: Uuid, name: String, expected_size: u64, expected_sha256: String, chunk_size: u64, next_chunk: u32, written: u64, part_path: PathBuf, file: File }

struct AppState { settings: Mutex<DesktopSettings>, pairing: Mutex<Option<PairingState>>, inbox: Mutex<Vec<InboxItem>>, receiver_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>> }

fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
fn app_dir() -> PathBuf { dirs::data_local_dir().unwrap_or_else(|| PathBuf::from(".")).join("EasyDoc") }
fn default_receive_dir() -> PathBuf { dirs::document_dir().unwrap_or_else(|| PathBuf::from(".")).join("EasyDoc") }
fn settings_path() -> PathBuf { app_dir().join("settings.json") }
fn pairing_path() -> PathBuf { app_dir().join("pairing.json") }
fn inbox_path() -> PathBuf { app_dir().join("inbox.json") }

async fn read_json<T: for<'a> Deserialize<'a>>(path: &Path) -> Option<T> { serde_json::from_slice(&fs::read(path).await.ok()?).ok() }
async fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> { if let Some(parent)=path.parent(){fs::create_dir_all(parent).await.map_err(|e|e.to_string())?;} fs::write(path, serde_json::to_vec_pretty(value).map_err(|e|e.to_string())?).await.map_err(|e|e.to_string()) }

fn load_initial() -> (DesktopSettings, Option<PairingState>, Vec<InboxItem>) {
  let rt = tokio::runtime::Runtime::new().expect("runtime");
  rt.block_on(async {
    let settings = read_json(&settings_path()).await.unwrap_or(DesktopSettings { receive_dir: default_receive_dir().to_string_lossy().into_owned(), relay_base_url: std::env::var("EASYDOC_RELAY_URL").unwrap_or_else(|_| "https://easydoc-relay.example.workers.dev".into()), paired: false, connected: false });
    let pairing = read_json(&pairing_path()).await;
    let inbox = read_json(&inbox_path()).await.unwrap_or_default();
    (DesktopSettings { paired: pairing.is_some(), ..settings }, pairing, inbox)
  })
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> DesktopSettings { state.settings.lock().unwrap().clone() }
#[tauri::command]
fn list_inbox(state: State<AppState>) -> Vec<InboxItem> { state.inbox.lock().unwrap().clone() }

#[tauri::command]
async fn choose_receive_dir(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Option<String>, String> {
  let picked = app.dialog().file().blocking_pick_folder();
  let Some(path) = picked.and_then(|value| value.as_path().map(Path::to_path_buf)) else { return Ok(None) };
  fs::create_dir_all(&path).await.map_err(|e| e.to_string())?;
  let snapshot = { let mut settings=state.settings.lock().unwrap(); settings.receive_dir=path.to_string_lossy().into_owned(); settings.clone() };
  write_json(&settings_path(), &snapshot).await?;
  Ok(Some(snapshot.receive_dir))
}

#[tauri::command]
async fn create_pairing(state: State<'_, AppState>) -> Result<PairingView, String> {
  let settings = state.settings.lock().unwrap().clone();
  let device_id = state.pairing.lock().unwrap().as_ref().map(|p|p.device_id.clone()).unwrap_or_else(|| format!("desktop_{}", Uuid::new_v4()));
  let public_key = format!("desktop-key-{}", Uuid::new_v4());
  let client = reqwest::Client::new();
  let issue: PairingIssue = client.post(format!("{}/pairing/issue", settings.relay_base_url.trim_end_matches('/'))).json(&serde_json::json!({"desktopId": device_id, "publicKey": public_key})).send().await.map_err(|e|e.to_string())?.error_for_status().map_err(|e|e.to_string())?.json().await.map_err(|e|e.to_string())?;
  let pairing_state = PairingState { device_id: issue.pairing.desktop_id.clone(), room_id: issue.pairing.room_id.clone(), desktop_secret: issue.desktop_secret };
  write_json(&pairing_path(), &pairing_state).await?;
  *state.pairing.lock().unwrap() = Some(pairing_state);
  { let mut current=state.settings.lock().unwrap(); current.paired=true; }
  Ok(PairingView { qr_payload: serde_json::to_string(&issue.pairing).map_err(|e|e.to_string())?, expires_at: issue.pairing.expires_at })
}

async fn session_token(settings: &DesktopSettings, pairing: &PairingState) -> Result<String, String> {
  #[derive(Deserialize)] struct TokenResponse { token: String }
  let response: TokenResponse = reqwest::Client::new().post(format!("{}/pairing/session", settings.relay_base_url.trim_end_matches('/'))).json(&serde_json::json!({"roomId":pairing.room_id,"role":"desktop","deviceId":pairing.device_id,"bootstrapSecret":pairing.desktop_secret})).send().await.map_err(|e|e.to_string())?.error_for_status().map_err(|e|e.to_string())?.json().await.map_err(|e|e.to_string())?;
  Ok(response.token)
}

fn ws_url(base: &str, token: &str) -> Result<String, String> { let mut url=url::Url::parse(base).map_err(|e|e.to_string())?; url.set_scheme(if url.scheme()=="https"{"wss"}else{"ws"}).map_err(|_|"invalid relay scheme".to_string())?; url.set_path("/connect"); url.set_query(Some(&format!("token={}", token))); Ok(url.to_string()) }

async fn unique_destination(root: &Path, name: &str) -> PathBuf { let candidate=root.join(name); if fs::metadata(&candidate).await.is_err(){return candidate;} let path=Path::new(name); let stem=path.file_stem().and_then(|v|v.to_str()).unwrap_or("scan"); let ext=path.extension().and_then(|v|v.to_str()); for n in 1..10000 { let filename=match ext{Some(ext)=>format!("{} ({}).{}",stem,n,ext),None=>format!("{} ({})",stem,n)}; let next=root.join(filename); if fs::metadata(&next).await.is_err(){return next;} } root.join(format!("{}_{}",Uuid::new_v4(),name)) }

async fn finalize(receive: ReceiveState, root: &Path) -> Result<InboxItem, String> {
  receive.file.sync_all().await.map_err(|e|e.to_string())?; drop(receive.file);
  let bytes=fs::read(&receive.part_path).await.map_err(|e|e.to_string())?;
  let digest=hex::encode(Sha256::digest(&bytes));
  if digest != receive.expected_sha256 { return Err("checksum_mismatch".into()); }
  let final_path=unique_destination(root,&receive.name).await;
  fs::rename(&receive.part_path,&final_path).await.map_err(|e|e.to_string())?;
  Ok(InboxItem { filename: final_path.file_name().unwrap_or_default().to_string_lossy().into_owned(), size: receive.expected_size, arrived_at: now_ms(), status: "completed".into(), path: final_path.to_string_lossy().into_owned() })
}

async fn receiver_loop(app: tauri::AppHandle, state: Arc<AppState>, settings: DesktopSettings, pairing: PairingState) -> Result<(), String> {
  let token=session_token(&settings,&pairing).await?; let (socket,_)=connect_async(ws_url(&settings.relay_base_url,&token)?).await.map_err(|e|e.to_string())?; let (mut write,mut read)=socket.split();
  { state.settings.lock().unwrap().connected=true; }
  let root=PathBuf::from(&settings.receive_dir); fs::create_dir_all(&root).await.map_err(|e|e.to_string())?; let mut current: Option<ReceiveState>=None;
  while let Some(message)=read.next().await { match message.map_err(|e|e.to_string())? {
    Message::Text(text) => if let Ok(Control::Start{transfer_id,name,size,sha256,chunk_size})=serde_json::from_str::<Control>(&text) { let id=Uuid::parse_str(&transfer_id).map_err(|_|"transfer_not_found".to_string())?; let part_path=root.join(format!("{}.part",name)); let file=OpenOptions::new().create(true).write(true).truncate(true).open(&part_path).await.map_err(|e|e.to_string())?; current=Some(ReceiveState{transfer_id:id,name,expected_size:size,expected_sha256:sha256,chunk_size,next_chunk:0,written:0,part_path,file}); write.send(Message::Text(serde_json::json!({"type":"transfer:accept","transferId":transfer_id,"resumeFromChunk":0}).to_string().into())).await.map_err(|e|e.to_string())?; },
    Message::Binary(frame) => if let Some(receive)=current.as_mut() { if frame.len()<26 || frame[0]!=1 || frame[1]!=1 {continue;} let id=Uuid::from_slice(&frame[2..18]).map_err(|_|"transfer_not_found".to_string())?; let index=u32::from_be_bytes(frame[18..22].try_into().unwrap()); let length=u32::from_be_bytes(frame[22..26].try_into().unwrap()) as usize; if id!=receive.transfer_id || frame.len()!=26+length {continue;} if index==receive.next_chunk { receive.file.write_all(&frame[26..]).await.map_err(|e|e.to_string())?; receive.written+=length as u64; receive.next_chunk+=1; } write.send(Message::Text(serde_json::json!({"type":"transfer:ack","transferId":receive.transfer_id,"receivedThroughChunk":receive.next_chunk as i64-1}).to_string().into())).await.map_err(|e|e.to_string())?; if receive.written==receive.expected_size { let done=current.take().unwrap(); let transfer_id=done.transfer_id; let item=finalize(done,&root).await?; { let mut inbox=state.inbox.lock().unwrap(); inbox.insert(0,item.clone()); let snapshot=inbox.clone(); drop(inbox); write_json(&inbox_path(),&snapshot).await?; } write.send(Message::Text(serde_json::json!({"type":"transfer:complete","transferId":transfer_id,"bytes":item.size,"sha256":"verified"}).to_string().into())).await.map_err(|e|e.to_string())?; let _=tauri_plugin_notification::NotificationExt::notification(&app).builder().title("EasyDoc").body(format!("{} 수신 완료",item.filename)).show(); } },
    Message::Close(_) => break,
    _ => {}
  }}
  state.settings.lock().unwrap().connected=false; Ok(())
}

#[tauri::command]
async fn connect_receiver(app: tauri::AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
  if state.receiver_task.lock().unwrap().as_ref().is_some_and(|task| !task.is_finished()) { return Ok(()); }
  let settings=state.settings.lock().unwrap().clone(); let pairing=state.pairing.lock().unwrap().clone().ok_or("pairing_invalid")?; let shared=state.inner().clone(); let handle=app.clone();
  let task=tauri::async_runtime::spawn(async move { let _=receiver_loop(handle,shared,settings,pairing).await; }); *state.receiver_task.lock().unwrap()=Some(task); Ok(())
}

#[tauri::command]
fn hide_window(app: tauri::AppHandle) -> Result<(), String> { app.get_webview_window("main").ok_or("window_not_found")?.hide().map_err(|e|e.to_string()) }
#[tauri::command]
fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> { tauri_plugin_opener::OpenerExt::opener(&app).open_path(path,None::<&str>).map_err(|e|e.to_string()) }
#[tauri::command]
fn reveal_path(app: tauri::AppHandle, path: String) -> Result<(), String> { let parent=Path::new(&path).parent().unwrap_or(Path::new(&path)).to_string_lossy().into_owned(); tauri_plugin_opener::OpenerExt::opener(&app).open_path(parent,None::<&str>).map_err(|e|e.to_string()) }

pub fn run() {
  let (settings,pairing,inbox)=load_initial(); let state=Arc::new(AppState { settings:Mutex::new(settings), pairing:Mutex::new(pairing), inbox:Mutex::new(inbox), receiver_task:Mutex::new(None) });
  tauri::Builder::default().plugin(tauri_plugin_autostart::Builder::new().build()).plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_notification::init()).plugin(tauri_plugin_opener::init()).manage(state).invoke_handler(tauri::generate_handler![get_settings,list_inbox,choose_receive_dir,create_pairing,connect_receiver,hide_window,open_path,reveal_path]).run(tauri::generate_context!()).expect("error while running EasyDoc");
}
