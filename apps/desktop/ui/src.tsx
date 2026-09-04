import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { QRCodeSVG } from "qrcode.react";
import "./style.css";

type InboxItem = { filename: string; size: number; arrivedAt: number; status: string; path: string };
type Settings = { receiveDir: string; relayBaseUrl: string; paired: boolean; connected: boolean };
type Pairing = { qrPayload: string; expiresAt: number };

function sizeLabel(bytes: number) { if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function timeLabel(value: number) { return new Date(value).toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }

function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [message, setMessage] = useState("");
  const [relayUrl, setRelayUrl] = useState("");

  const refresh = async () => {
    const [nextSettings, nextItems] = await Promise.all([invoke<Settings>("get_settings"), invoke<InboxItem[]>("list_inbox")]);
    setSettings(nextSettings); setItems(nextItems); setRelayUrl((current) => current || nextSettings.relayBaseUrl); return nextSettings;
  };

  useEffect(() => {
    refresh().then((initial) => { if (initial.paired) invoke("connect_receiver").catch(() => undefined); }).catch((error) => setMessage(String(error)));
    const id = setInterval(() => refresh().catch(() => undefined), 3000);
    return () => clearInterval(id);
  }, []);

  const createPairing = async () => { setMessage(""); try { setPairing(await invoke<Pairing>("create_pairing")); await refresh(); } catch (error) { setMessage(String(error)); } };
  const connect = async () => { setMessage(""); try { await invoke("connect_receiver"); await refresh(); } catch (error) { setMessage(String(error)); } };
  const chooseFolder = async () => { try { const path = await invoke<string | null>("choose_receive_dir"); if (path) await refresh(); } catch (error) { setMessage(String(error)); } };
  const renameItem = async (item: InboxItem) => { const next = window.prompt("새 파일명", item.filename); if (!next || next === item.filename) return; try { await invoke("rename_file", { path: item.path, newName: next }); await refresh(); } catch (error) { setMessage(String(error)); } };
  const deleteItem = async (item: InboxItem) => { if (!window.confirm(`${item.filename} 파일을 삭제할까요?`)) return; try { await invoke("delete_file", { path: item.path }); await refresh(); } catch (error) { setMessage(String(error)); } };
  const printItem = async (item: InboxItem) => { try { await invoke("print_file", { path: item.path }); } catch (error) { setMessage(String(error)); } };
  const saveRelayUrl = async () => { setMessage(""); try { const next = await invoke<Settings>("set_relay_url", { relayBaseUrl: relayUrl }); setSettings(next); setRelayUrl(next.relayBaseUrl); } catch (error) { setMessage(String(error)); } };

  return <main className="shell">
    <header><div><p className="eyebrow">WINDOWS COMPANION</p><h1>Scan Inbox</h1><p className="sub">휴대폰에서 보낸 문서가 여기에 자동으로 저장됩니다.</p></div><div className={`presence ${settings?.connected ? "online" : ""}`}><span/> {settings?.connected ? "연결됨" : "연결 대기"}</div></header>
    <section className="toolbar"><div><strong>저장 위치</strong><p>{settings?.receiveDir ?? "불러오는 중..."}</p></div><button className="secondary" onClick={chooseFolder}>폴더 변경</button><button onClick={settings?.paired ? connect : createPairing}>{settings?.paired ? "수신 연결" : "휴대폰 연결"}</button></section>
    <section className="relay-config"><div><strong>Relay URL</strong><p>Cloudflare Worker의 https:// 주소를 입력하세요.</p></div><input value={relayUrl} onChange={(event) => setRelayUrl(event.target.value)} spellCheck={false} placeholder="https://easydoc-relay.example.workers.dev" /><button className="secondary" onClick={saveRelayUrl}>적용</button></section>
    {message && <div className="error">{message}</div>}
    {pairing && <section className="pairing"><div className="qr"><QRCodeSVG value={pairing.qrPayload} size={180} level="M" /></div><div className="pairing-copy"><strong>휴대폰에서 QR 스캔</strong><p>5분 동안 한 번만 사용할 수 있습니다.</p><p className="expires">만료: {new Date(pairing.expiresAt).toLocaleTimeString("ko-KR")}</p></div><button className="secondary" onClick={() => setPairing(null)}>닫기</button></section>}
    <section className="inbox"><div className="section-title"><h2>받은 파일</h2><span>{items.length}개</span></div>{items.length === 0 ? <div className="empty"><div className="empty-icon">↓</div><strong>아직 받은 파일이 없습니다</strong><p>휴대폰에서 문서를 스캔하고 이 PC로 보내세요.</p></div> : items.map((item) => <article key={`${item.path}-${item.arrivedAt}`}><div className="file-icon">FILE</div><div className="file-info"><strong>{item.filename}</strong><p>{sizeLabel(item.size)} · {timeLabel(item.arrivedAt)}</p></div><span className={`status ${item.status}`}>{item.status}</span><div className="item-actions"><button className="ghost" onClick={() => invoke("open_path", { path: item.path })}>열기</button><button className="ghost" onClick={() => invoke("reveal_path", { path: item.path })}>폴더</button><button className="ghost" onClick={() => renameItem(item)}>이름</button><button className="ghost" onClick={() => printItem(item)}>인쇄</button><button className="ghost danger" onClick={() => deleteItem(item)}>삭제</button></div></article>)}</section>
    <footer><span>EasyDoc는 기본 전송 경로에서 릴레이 서버에 문서 본문을 저장하지 않습니다.</span><button className="ghost" onClick={() => invoke("hide_window")}>트레이로 숨기기</button></footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);
