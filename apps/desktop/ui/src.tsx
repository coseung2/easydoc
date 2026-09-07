import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { QRCodeSVG } from "qrcode.react";
import { createKeyedGate, sectionFromEventPayload, SECTIONS, shouldAdoptServerAlias, shouldApplySettingsSnapshot, type Section } from "./state";
import "./style.css";

type InboxItem = { filename: string; size: number; arrivedAt: number; status: string; path: string };
type Settings = { desktopAlias: string; receiveDir: string; paired: boolean; pairedCount: number; connected: boolean };
type Pairing = { qrPayload: string; roomId: string };
type PairedDevice = { roomId: string; deviceId: string; mobileId?: string; mobileAlias?: string; authorized: boolean; connected: boolean; error?: string };
type AliasStatus = "idle" | "saving" | "saved";

type DialogConfig = {
  title: string;
  message?: string;
  value?: string;
  confirmLabel: string;
  destructive?: boolean;
  requiresValue?: boolean;
  actionKey: string;
  onConfirm: (value: string) => Promise<void>;
};

type DialogState = DialogConfig & { busy: boolean; error: string | null };

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
  const [aliasDirty, setAliasDirty] = useState(false);
  const [aliasStatus, setAliasStatus] = useState<AliasStatus>("idle");
  const [aliasError, setAliasError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [busyActions, setBusyActions] = useState<Set<string>>(() => new Set());
  const [sectionErrors, setSectionErrors] = useState<Record<Section, string | null>>({ settings: null, inbox: null, pairings: null });

  const aliasDirtyRef = useRef(false);
  const aliasMutationGenerationRef = useRef(0);
  const settingsRefreshQueuedRef = useRef(false);
  const refreshGateRef = useRef(createKeyedGate());
  const actionGateRef = useRef(createKeyedGate());
  const dialogSubmitGateRef = useRef(false);

  const setBusy = (key: string, active: boolean) => {
    setBusyActions((current) => {
      const next = new Set(current);
      if (active) next.add(key); else next.delete(key);
      return next;
    });
  };

  const runBusy = async <T,>(key: string, task: () => Promise<T>): Promise<T | undefined> => {
    if (!actionGateRef.current.tryStart(key)) return undefined;
    setBusy(key, true);
    try {
      return await task();
    } finally {
      actionGateRef.current.finish(key);
      setBusy(key, false);
    }
  };

  const runWithFeedback = async (key: string, task: () => Promise<unknown>) => {
    setMessage("");
    try {
      await runBusy(key, task);
    } catch (error) {
      setMessage(errorLabel(error));
    }
  };

  const refreshSection = async (section: Section): Promise<Settings | InboxItem[] | PairedDevice[] | undefined> => {
    if (!refreshGateRef.current.tryStart(section)) return undefined;
    setSectionErrors((current) => ({ ...current, [section]: null }));
    const aliasGenerationAtStart = section === "settings" ? aliasMutationGenerationRef.current : 0;
    try {
      if (section === "settings") {
        const nextSettings = await invoke<Settings>("get_settings");
        if (!shouldApplySettingsSnapshot(aliasGenerationAtStart, aliasMutationGenerationRef.current)) {
          settingsRefreshQueuedRef.current = true;
          return nextSettings;
        }
        setSettings(nextSettings);
        if (shouldAdoptServerAlias(aliasDirtyRef.current)) {
          setDesktopAlias(nextSettings.desktopAlias);
          setAliasDirty(false);
        }
        return nextSettings;
      }
      if (section === "inbox") {
        const nextItems = await invoke<InboxItem[]>("list_inbox");
        setItems(nextItems);
        return nextItems;
      }
      const nextDevices = await invoke<PairedDevice[]>("list_pairings");
      setDevices(nextDevices);
      return nextDevices;
    } catch (error) {
      setSectionErrors((current) => ({ ...current, [section]: errorLabel(error) }));
      return undefined;
    } finally {
      refreshGateRef.current.finish(section);
      if (section === "settings" && settingsRefreshQueuedRef.current) {
        settingsRefreshQueuedRef.current = false;
        void refreshSection("settings");
      }
    }
  };

  const connect = async () => {
    await runWithFeedback("connect", async () => {
      await invoke("connect_receiver");
      await Promise.all([refreshSection("settings"), refreshSection("pairings")]);
    });
  };

  useEffect(() => {
    let disposed = false;
    const initialize = async () => {
      const initialSettings = await refreshSection("settings");
      await Promise.all([refreshSection("inbox"), refreshSection("pairings")]);
      if (!disposed && initialSettings && !Array.isArray(initialSettings) && initialSettings.paired) void connect();
    };
    void initialize();

    const refreshVisibleSections = () => {
      for (const section of SECTIONS) void refreshSection(section);
    };
    const interval = setInterval(refreshVisibleSections, 15000);
    const refreshOnFocus = () => { if (document.visibilityState === "visible") refreshVisibleSections(); };
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnFocus);

    let unlisten: (() => void) | undefined;
    void listen<unknown>("easydoc:changed", (event) => {
      const section = sectionFromEventPayload(event.payload);
      if (section) void refreshSection(section);
    }).then((stop) => {
      if (disposed) stop(); else unlisten = stop;
    }).catch(() => {
      // Polling remains active when event support is unavailable (e.g. older builds).
    });

    return () => {
      disposed = true;
      clearInterval(interval);
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnFocus);
      unlisten?.();
    };
  }, []);

  const createPairing = () => void runWithFeedback("create-pairing", async () => {
    const next = await invoke<Pairing>("create_pairing");
    setPairing({ ...next, qrPayload: `easydoc://pair?payload=${encodeURIComponent(next.qrPayload)}` });
    await Promise.all([refreshSection("settings"), refreshSection("pairings")]);
  });

  const chooseFolder = () => void runWithFeedback("choose-folder", async () => {
    const path = await invoke<string | null>("choose_receive_dir");
    if (path) await refreshSection("settings");
  });

  const saveDesktopAlias = async () => {
    const persistedAlias = settings?.desktopAlias ?? "";
    const unchanged = desktopAlias.trim() === persistedAlias.trim();
    if (!aliasDirty || unchanged || actionGateRef.current.isActive("save-alias")) return;
    aliasMutationGenerationRef.current += 1;
    setMessage("");
    setAliasError(null);
    setAliasStatus("saving");
    try {
      const next = await runBusy("save-alias", () => invoke<Settings>("set_desktop_alias", { desktopAlias }));
      if (!next) return;
      setSettings(next);
      aliasDirtyRef.current = false;
      setAliasDirty(false);
      setDesktopAlias(next.desktopAlias);
      setAliasStatus("saved");
      void refreshSection("settings");
    } catch (error) {
      setAliasStatus("idle");
      setAliasError(errorLabel(error));
    }
  };

  const openDialog = (config: DialogConfig) => {
    setMessage("");
    dialogSubmitGateRef.current = false;
    setDialog({ ...config, busy: false, error: null });
  };

  const renameItem = (item: InboxItem) => openDialog({
    title: "파일 이름 변경",
    value: item.filename,
    requiresValue: true,
    confirmLabel: "저장",
    actionKey: `rename:${item.path}`,
    onConfirm: async (next) => {
      if (next === item.filename) return;
      await runBusy(`rename:${item.path}`, async () => {
        await invoke("rename_file", { path: item.path, newName: next });
        await refreshSection("inbox");
      });
    },
  });

  const deleteItem = (item: InboxItem) => openDialog({
    title: "파일을 삭제할까요?",
    message: item.filename,
    confirmLabel: "삭제",
    destructive: true,
    actionKey: `delete:${item.path}`,
    onConfirm: async () => {
      await runBusy(`delete:${item.path}`, async () => {
        await invoke("delete_file", { path: item.path });
        await refreshSection("inbox");
      });
    },
  });

  const printItem = (item: InboxItem) => void runWithFeedback(`print:${item.path}`, () => invoke("print_file", { path: item.path }));
  const openPath = (item: InboxItem) => void runWithFeedback(`open:${item.path}`, () => invoke("open_path", { path: item.path }));
  const revealPath = (item: InboxItem) => void runWithFeedback(`reveal:${item.path}`, () => invoke("reveal_path", { path: item.path }));

  const renameDevice = (device: PairedDevice) => openDialog({
    title: "휴대폰 이름 변경",
    value: device.mobileAlias ?? "",
    confirmLabel: "저장",
    actionKey: `rename-device:${device.roomId}`,
    onConfirm: async (next) => {
      const nextDevices = await runBusy(`rename-device:${device.roomId}`, () => invoke<PairedDevice[]>("set_pairing_label", { roomId: device.roomId, mobileAlias: next }));
      if (nextDevices) setDevices(nextDevices);
    },
  });

  const revokeDevice = (device: PairedDevice) => openDialog({
    title: "휴대폰 연결을 해제할까요?",
    message: deviceName(device),
    confirmLabel: "연결 해제",
    destructive: true,
    actionKey: `revoke:${device.roomId}`,
    onConfirm: async () => {
      await runBusy(`revoke:${device.roomId}`, async () => {
        await invoke("revoke_pairing", { roomId: device.roomId });
        await Promise.all([refreshSection("settings"), refreshSection("pairings")]);
      });
    },
  });

  const handleDialogSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const active = dialog;
    if (!active || active.busy || dialogSubmitGateRef.current) return;
    if (active.requiresValue && !(active.value ?? "").trim()) {
      setDialog({ ...active, error: errorLabel("invalid_filename") });
      return;
    }
    dialogSubmitGateRef.current = true;
    setDialog({ ...active, busy: true, error: null });
    try {
      await active.onConfirm(active.value ?? "");
      setDialog(null);
    } catch (error) {
      setDialog((current) => current ? { ...current, busy: false, error: errorLabel(error) } : current);
    } finally {
      dialogSubmitGateRef.current = false;
    }
  };

  const aliasUnchanged = desktopAlias.trim() === (settings?.desktopAlias ?? "").trim();
  const aliasSaveDisabled = !aliasDirty || aliasUnchanged || aliasStatus === "saving" || busyActions.has("save-alias");
  const settingsError = sectionErrors.settings;
  const inboxError = sectionErrors.inbox;
  const pairingsError = sectionErrors.pairings;

  return <main className="shell">
    <header><div><p className="eyebrow">WINDOWS COMPANION</p><h1>Scan Inbox</h1><p className="sub">휴대폰에서 보낸 문서가 여기에 자동으로 저장됩니다.</p></div><div className={`presence ${settings?.connected ? "online" : ""}`} aria-live="polite"><span aria-hidden="true"/> {settings?.connected ? "연결됨" : "연결 대기"}</div></header>
    <section className="toolbar"><div><strong>저장 위치</strong><p>{settings?.receiveDir ?? "불러오는 중..."}</p></div><button className="secondary" onClick={chooseFolder} disabled={busyActions.has("choose-folder")}>{busyActions.has("choose-folder") ? "변경 중…" : "폴더 변경"}</button><button onClick={() => void (settings?.paired ? connect() : createPairing())} disabled={busyActions.has(settings?.paired ? "connect" : "create-pairing")}>{busyActions.has(settings?.paired ? "connect" : "create-pairing") ? "처리 중…" : (settings?.paired ? "수신 연결" : "휴대폰 연결")}</button>{settings?.paired && <button className="secondary" onClick={createPairing} disabled={busyActions.has("create-pairing")}>{busyActions.has("create-pairing") ? "추가 중…" : "휴대폰 추가"}</button>}</section>
    {settingsError && <div className="section-error" role="alert">설정 정보를 새로 고치지 못했습니다. {settingsError}</div>}
    <section className="alias-config"><label htmlFor="desktop-alias"><strong>이 PC 이름</strong><p>휴대폰에서 표시할 이름</p></label><input id="desktop-alias" value={desktopAlias} disabled={aliasStatus === "saving"} onChange={(event) => { aliasDirtyRef.current = true; setAliasDirty(true); setAliasError(null); setAliasStatus("idle"); setDesktopAlias(event.target.value); }} maxLength={80} aria-invalid={Boolean(aliasError)} aria-describedby={aliasError ? "desktop-alias-error" : undefined} onKeyDown={(event) => { if (event.key === "Enter") void saveDesktopAlias(); }} /><button className="secondary" onClick={() => void saveDesktopAlias()} disabled={aliasSaveDisabled}>{aliasStatus === "saving" ? "저장 중…" : "저장"}</button>{aliasStatus === "saved" && <span className="save-status" role="status">저장됨</span>}</section>
    {aliasError && <div id="desktop-alias-error" className="field-error" role="alert">{aliasError}</div>}
    {message && <div className="error" role="alert">{message}</div>}
    {pairing && <section className="pairing"><div className="qr"><QRCodeSVG value={pairing.qrPayload} size={260} level="L" marginSize={4} /></div><div className="pairing-copy"><strong>휴대폰 연결</strong><p>휴대폰 기본 카메라로 QR을 찍고 EasyDoc 열기를 선택하세요.</p></div><button className="secondary" onClick={() => setPairing(null)}>닫기</button></section>}
    <section className="devices" aria-labelledby="devices-title"><div className="section-title"><h2 id="devices-title">연결된 휴대폰</h2><span>{devices.length}개</span></div>{pairingsError && <div className="section-error" role="alert">휴대폰 연결 정보를 새로 고치지 못했습니다. {pairingsError}</div>}{devices.length === 0 ? <div className="device-empty">휴대폰을 연결하면 여기에 표시됩니다.</div> : <ul className="device-list">{devices.map((device) => { const renameKey = `rename-device:${device.roomId}`; const revokeKey = `revoke:${device.roomId}`; return <li className="device-row" key={device.roomId}><div className="device-icon" aria-hidden="true">PHONE</div><div className="device-info"><strong title={deviceName(device)}>{deviceName(device)}</strong><p>{device.error ? errorLabel(device.error) : (device.mobileId ?? "QR 스캔 후 기기 정보가 표시됩니다.")}</p></div><span className={`device-state ${device.connected ? "online" : ""}`}><span aria-hidden="true"/>{deviceState(device)}</span><div className="item-actions"><button className="ghost" onClick={() => renameDevice(device)} disabled={busyActions.has(renameKey)} aria-label={`${deviceName(device)} 이름 바꾸기`}>{busyActions.has(renameKey) ? "저장 중…" : "이름"}</button><button className="ghost danger" onClick={() => revokeDevice(device)} disabled={busyActions.has(revokeKey)} aria-label={`${deviceName(device)} 연결 해제`}>{busyActions.has(revokeKey) ? "해제 중…" : "연결 해제"}</button></div></li>; })}</ul>}</section>
    <section className="inbox"><div className="section-title"><h2>받은 파일</h2><span>{items.length}개</span></div>{inboxError && <div className="section-error" role="alert">받은 파일을 새로 고치지 못했습니다. {inboxError}</div>}{items.length === 0 ? <div className="empty"><div className="empty-icon" aria-hidden="true">↓</div><strong>아직 받은 파일이 없습니다</strong><p>휴대폰에서 문서를 스캔하고 이 PC로 보내세요.</p></div> : items.map((item) => { const renameKey = `rename:${item.path}`; const deleteKey = `delete:${item.path}`; return <article key={`${item.path}-${item.arrivedAt}`}><div className="file-icon" aria-hidden="true">FILE</div><div className="file-info"><strong title={item.filename}>{item.filename}</strong><p>{sizeLabel(item.size)} · {timeLabel(item.arrivedAt)}</p></div><span className={`status ${item.status}`}>{statusLabel(item.status)}</span><div className="item-actions"><button className="ghost" onClick={() => openPath(item)}>열기</button><button className="ghost" onClick={() => revealPath(item)}>폴더</button><button className="ghost" onClick={() => renameItem(item)} disabled={busyActions.has(renameKey)}>{busyActions.has(renameKey) ? "저장 중…" : "이름"}</button><button className="ghost" onClick={() => printItem(item)} disabled={busyActions.has(`print:${item.path}`)}>{busyActions.has(`print:${item.path}`) ? "인쇄 중…" : "인쇄"}</button><button className="ghost danger" onClick={() => deleteItem(item)} disabled={busyActions.has(deleteKey)}>{busyActions.has(deleteKey) ? "삭제 중…" : "삭제"}</button></div></article>; })}</section>
    {dialog && <div className="dialog-backdrop" role="presentation"><form className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onSubmit={(event) => void handleDialogSubmit(event)}><h2 id="dialog-title">{dialog.title}</h2>{dialog.message && <p>{dialog.message}</p>}{dialog.value !== undefined && <input name="value" value={dialog.value} disabled={dialog.busy} onChange={(event) => setDialog((current) => current ? { ...current, value: event.target.value, error: null } : current)} autoFocus maxLength={80} aria-invalid={Boolean(dialog.error)} aria-describedby={dialog.error ? "dialog-error" : undefined} />}{dialog.error && <div id="dialog-error" className="dialog-error" role="alert">{dialog.error}</div>}<div className="dialog-actions"><button type="button" className="secondary" onClick={() => setDialog(null)} disabled={dialog.busy}>취소</button><button type="submit" className={dialog.destructive ? "danger-button" : ""} disabled={dialog.busy}>{dialog.busy ? "처리 중…" : dialog.confirmLabel}</button></div></form></div>}
    <footer><span>EasyDoc는 기본 전송 경로에서 릴레이 서버에 문서 본문을 저장하지 않습니다.</span><button className="ghost" onClick={() => invoke("hide_window")}>트레이로 숨기기</button></footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
