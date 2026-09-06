import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { QRCodeSVG } from "qrcode.react";
import "./style.css";

type InboxItem = { filename: string; size: number; arrivedAt: number; status: string; path: string };
type Settings = { desktopAlias: string; receiveDir: string; paired: boolean; pairedCount: number; connected: boolean };
type Pairing = { qrPayload: string; roomId: string };
type PairedDevice = { roomId: string; deviceId: string; mobileId?: string; mobileAlias?: string; authorized: boolean; connected: boolean; error?: string };

type Dialog = { title: string; message?: string; value?: string; confirmLabel: string; destructive?: boolean; onConfirm: (value: string) => void };

function errorLabel(error: unknown) {
  const code = String(error).replace(/^Error:\s*/, "");
  const labels: Record<string, string> = {
    pairing_invalid: "연결 정보가 만료되었거나 유효하지 않습니다.",
    pairing_not_found: "연결 정보를 찾을 수 없습니다.",
    filename_exists: "같은 이름의 파일이 이미 있습니다.",
    invalid_filename: "사용할 수 없는 파일 이름입니다.",
    invalid_desktop_alias: "PC 이름을 입력해 주세요.",
    invalid_mobile_alias: "휴대폰 이름을 확인해 주세요.",
    print_unsupported: "이 환경에서는 인쇄를 지원하지 않습니다.",
    print_failed: "인쇄를 시작하지 못했습니다. 이 파일을 열 수 있는 앱과 프린터를 확인해 주세요.",
    checksum_mismatch: "파일 검증에 실패했습니다.",
    chunk_authentication_failed: "파일 보안 검증에 실패했습니다.",
    relay_unavailable: "릴레이 서버에 연결할 수 없습니다.",
  };
  return labels[code] ?? "작업을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

function statusLabel(status: string) {
  return ({ completed: "완료", failed: "실패", interrupted: "중단됨", transferring: "전송 중" } as Record<string, string>)[status] ?? status;
}

function sizeLabel(bytes: number) { if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function timeLabel(value: number) { return new Date(value).toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function deviceName(device: PairedDevice) { return device.mobileAlias ?? device.mobileId ?? "휴대폰"; }
function deviceState(device: PairedDevice) { if (device.connected) return "연결됨"; if (device.authorized) return "연결 대기"; return "QR 스캔 대기"; }

function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [message, setMessage] = useState("");
  const [desktopAlias, setDesktopAlias] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const refresh = async () => {
    const [nextSettings, nextItems, nextDevices] = await Promise.all([
      invoke<Settings>("get_settings"),
      invoke<InboxItem[]>("list_inbox"),
      invoke<PairedDevice[]>("list_pairings"),
    ]);
    setSettings(nextSettings);
    setItems(nextItems);
    setDevices(nextDevices);
    setDesktopAlias((current) => current || nextSettings.desktopAlias);
    return nextSettings;
  };

  useEffect(() => {
    refresh().then((initial) => { if (initial.paired) invoke("connect_receiver").catch((error) => setMessage(errorLabel(error))); }).catch((error) => setMessage(errorLabel(error)));
    const id = setInterval(() => refresh().catch((error) => setMessage(errorLabel(error))), 3000);
    return () => clearInterval(id);
  }, []);

  const createPairing = async () => { setMessage(""); try { const next = await invoke<Pairing>("create_pairing"); setPairing({ ...next, qrPayload: `easydoc://pair?payload=${encodeURIComponent(next.qrPayload)}` }); await refresh(); } catch (error) { setMessage(errorLabel(error)); } };
  const connect = async () => { setMessage(""); try { await invoke("connect_receiver"); await refresh(); } catch (error) { setMessage(errorLabel(error)); } };
  const chooseFolder = async () => { try { const path = await invoke<string | null>("choose_receive_dir"); if (path) await refresh(); } catch (error) { setMessage(errorLabel(error)); } };
  const renameItem = (item: InboxItem) => setDialog({ title: "파일 이름 변경", value: item.filename, confirmLabel: "저장", onConfirm: async (next) => { if (!next || next === item.filename) return; try { await invoke("rename_file", { path: item.path, newName: next }); await refresh(); } catch (error) { setMessage(errorLabel(error)); } } });
  const deleteItem = (item: InboxItem) => setDialog({ title: "파일을 삭제할까요?", message: item.filename, confirmLabel: "삭제", destructive: true, onConfirm: async () => { try { await invoke("delete_file", { path: item.path }); await refresh(); } catch (error) { setMessage(errorLabel(error)); } } });
  const printItem = async (item: InboxItem) => { try { await invoke("print_file", { path: item.path }); } catch (error) { setMessage(errorLabel(error)); } };
  const saveDesktopAlias = async () => { setMessage(""); try { const next = await invoke<Settings>("set_desktop_alias", { desktopAlias }); setSettings(next); setDesktopAlias(next.desktopAlias); } catch (error) { setMessage(errorLabel(error)); } };
  const renameDevice = async (device: PairedDevice) => {
    setDialog({ title: "휴대폰 이름 변경", value: device.mobileAlias ?? "", confirmLabel: "저장", onConfirm: async (next) => { setMessage(""); try { setDevices(await invoke<PairedDevice[]>("set_pairing_label", { roomId: device.roomId, mobileAlias: next })); } catch (error) { setMessage(errorLabel(error)); } } });
  };
  const revokeDevice = async (device: PairedDevice) => {
    setDialog({ title: "휴대폰 연결을 해제할까요?", message: deviceName(device), confirmLabel: "연결 해제", destructive: true, onConfirm: async () => { setMessage(""); try { await invoke("revoke_pairing", { roomId: device.roomId }); await refresh(); } catch (error) { setMessage(errorLabel(error)); } } });
  };

  return <main className="shell">
    <header><div><p className="eyebrow">WINDOWS COMPANION</p><h1>Scan Inbox</h1><p className="sub">휴대폰에서 보낸 문서가 여기에 자동으로 저장됩니다.</p></div><div className={`presence ${settings?.connected ? "online" : ""}`} aria-live="polite"><span aria-hidden="true"/> {settings?.connected ? "연결됨" : "연결 대기"}</div></header>
    <section className="toolbar"><div><strong>저장 위치</strong><p>{settings?.receiveDir ?? "불러오는 중..."}</p></div><button className="secondary" onClick={chooseFolder}>폴더 변경</button><button onClick={settings?.paired ? connect : createPairing}>{settings?.paired ? "수신 연결" : "휴대폰 연결"}</button>{settings?.paired && <button className="secondary" onClick={createPairing}>휴대폰 추가</button>}</section>
    <section className="alias-config"><label htmlFor="desktop-alias"><strong>이 PC 이름</strong><p>휴대폰에서 표시할 이름</p></label><input id="desktop-alias" value={desktopAlias} onChange={(event) => setDesktopAlias(event.target.value)} maxLength={80} onKeyDown={(event) => { if (event.key === "Enter") void saveDesktopAlias(); }} /><button className="secondary" onClick={saveDesktopAlias}>저장</button></section>
    {message && <div className="error" role="alert">{message}</div>}
    {pairing && <section className="pairing"><div className="qr"><QRCodeSVG value={pairing.qrPayload} size={260} level="L" marginSize={4} /></div><div className="pairing-copy"><strong>휴대폰 연결</strong><p>휴대폰 기본 카메라로 QR을 찍고 EasyDoc 열기를 선택하세요.</p></div><button className="secondary" onClick={() => setPairing(null)}>닫기</button></section>}
    <section className="devices" aria-labelledby="devices-title"><div className="section-title"><h2 id="devices-title">연결된 휴대폰</h2><span>{devices.length}개</span></div>{devices.length === 0 ? <div className="device-empty">휴대폰을 연결하면 여기에 표시됩니다.</div> : <ul className="device-list">{devices.map((device) => <li className="device-row" key={device.roomId}><div className="device-icon" aria-hidden="true">PHONE</div><div className="device-info"><strong title={deviceName(device)}>{deviceName(device)}</strong><p>{device.error ? errorLabel(device.error) : (device.mobileId ?? "QR 스캔 후 기기 정보가 표시됩니다.")}</p></div><span className={`device-state ${device.connected ? "online" : ""}`}><span aria-hidden="true"/>{deviceState(device)}</span><div className="item-actions"><button className="ghost" onClick={() => renameDevice(device)} aria-label={`${deviceName(device)} 이름 바꾸기`}>이름</button><button className="ghost danger" onClick={() => revokeDevice(device)} aria-label={`${deviceName(device)} 연결 해제`}>연결 해제</button></div></li>)}</ul>}</section>
    <section className="inbox"><div className="section-title"><h2>받은 파일</h2><span>{items.length}개</span></div>{items.length === 0 ? <div className="empty"><div className="empty-icon" aria-hidden="true">↓</div><strong>아직 받은 파일이 없습니다</strong><p>휴대폰에서 문서를 스캔하고 이 PC로 보내세요.</p></div> : items.map((item) => <article key={`${item.path}-${item.arrivedAt}`}><div className="file-icon" aria-hidden="true">FILE</div><div className="file-info"><strong title={item.filename}>{item.filename}</strong><p>{sizeLabel(item.size)} · {timeLabel(item.arrivedAt)}</p></div><span className={`status ${item.status}`}>{statusLabel(item.status)}</span><div className="item-actions"><button className="ghost" onClick={() => invoke("open_path", { path: item.path }).catch((error) => setMessage(errorLabel(error)))}>열기</button><button className="ghost" onClick={() => invoke("reveal_path", { path: item.path }).catch((error) => setMessage(errorLabel(error)))}>폴더</button><button className="ghost" onClick={() => renameItem(item)}>이름</button><button className="ghost" onClick={() => printItem(item)}>인쇄</button><button className="ghost danger" onClick={() => deleteItem(item)}>삭제</button></div></article>)}</section>
    {dialog && <div className="dialog-backdrop" role="presentation"><form className="dialog" onSubmit={(event) => { event.preventDefault(); const value = new FormData(event.currentTarget).get("value"); setDialog(null); void dialog.onConfirm(typeof value === "string" ? value : ""); }}><h2>{dialog.title}</h2>{dialog.message && <p>{dialog.message}</p>}{dialog.value !== undefined && <input name="value" defaultValue={dialog.value} autoFocus maxLength={80} /> }<div className="dialog-actions"><button type="button" className="secondary" onClick={() => setDialog(null)}>취소</button><button className={dialog.destructive ? "danger-button" : ""}>{dialog.confirmLabel}</button></div></form></div>}
    <footer><span>EasyDoc는 기본 전송 경로에서 릴레이 서버에 문서 본문을 저장하지 않습니다.</span><button className="ghost" onClick={() => invoke("hide_window")}>트레이로 숨기기</button></footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);
