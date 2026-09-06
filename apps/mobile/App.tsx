import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, BackHandler, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View, type GestureResponderEvent } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import * as DocumentPicker from "expo-document-picker";
import * as Linking from "expo-linking";
import { useShareIntent } from "expo-share-intent";
import { Feather } from "@expo/vector-icons";
import { ActionCard, BottomNav, Chip, FileBadge, IconButton, ScreenHeader, SearchBar, sharedStyles, type TabKey } from "./src/ui/components";
import { colors, radius } from "./src/ui/theme";
import { SettingsScreen } from "./src/ui/settings-screen";
import { ScannerScreen } from "./src/scanner/scanner-screen";
import { createLocalFolder, filterLocalDocuments, importLocalFile, listLocalDocuments, listLocalFolders, moveLocalDocument, type DocumentFilter, type LocalDocument, type LocalFolder } from "./src/documents/store";
import { DocumentViewerScreen, PresentationScreen } from "./src/ui/document-viewer";
import { PdfToolsScreen } from "./src/ui/pdf-tools-screen";
import { OcrScreen } from "./src/ui/ocr-screen";
import { APP_RELAY_BASE_URL, claimPairing, getPairingKey, getStoredPairing, getStoredPairings, removePairing as removeStoredPairing, revokeStoredPairing, selectPairing as selectStoredPairing, type StoredMobilePairing } from "./src/pairing/client";
import { assignUnassignedTransfersTarget, enqueueTransfer, listPendingTransfers, releaseTransfersTarget, updateTransferStatus } from "./src/transfer/queue";
import { MobileRelayClient, type RelayState } from "./src/transfer/client";
import { groupTransfersByTarget } from "./src/transfer/targets";
import { pairingPayloadFromUrl } from "../../packages/protocol/src/index.ts";

type Route = TabKey | "viewer" | "presentation" | "ocr";
type RecentFile = { name: string; meta: string; type: string; uri?: string; mime?: string; localId?: string; folderId: string | null };
type MobilePairingForUi = StoredMobilePairing & { alias?: string; desktopName?: string };
type FolderFilter = string | null | undefined;

const EMPTY_RELAY_STATE: RelayState = { connected: false, desktopOnline: false };

function toRecentFile(document: LocalDocument): RecentFile {
  const extension = document.title.split(".").pop()?.toUpperCase() ?? "FILE";
  return { name: document.title, meta: `${document.pageCount > 0 ? `${document.pageCount} pages · ` : ""}${(document.size / 1024 / 1024).toFixed(1)} MB`, type: extension.slice(0, 4), uri: document.uri, mime: document.mimeType, localId: document.id, folderId: document.folderId };
}

function desktopName(pairing: MobilePairingForUi): string {
  return pairing.alias?.trim() || pairing.desktopAlias?.trim() || pairing.desktopName?.trim() || pairing.desktopId;
}

function errorMessage(error: unknown, fallback: string): string {
  const code = error instanceof Error ? error.message : String(error ?? "");
  if (code === "pairing_invalid") return "이 PC 연결은 만료되었거나 다른 기기에서 해제되었습니다. 연결을 삭제한 뒤 다시 연결해 주세요.";
  if (code === "relay_unavailable" || code.startsWith("relay_http_")) return "EasyDoc 연결 서버에 닿지 못했습니다. 네트워크를 확인하고 다시 시도해 주세요.";
  if (code === "invalid_folder_name") return "폴더 이름을 1~80자로 입력해 주세요.";
  if (code.toLocaleLowerCase().includes("unique")) return "같은 이름의 폴더가 이미 있습니다.";
  return code || fallback;
}

export default function App() {
  const { hasShareIntent, shareIntent, resetShareIntent, error: shareIntentError } = useShareIntent({ resetOnBackground: false });
  const [route, setRoute] = useState<Route>("home");
  const [ocrReturnRoute, setOcrReturnRoute] = useState<Route>("home");
  const [presentationReturnRoute, setPresentationReturnRoute] = useState<"home" | "viewer">("home");
  const [importedFiles, setImportedFiles] = useState<RecentFile[]>([]);
  const [folders, setFolders] = useState<LocalFolder[]>([]);
  const [pairings, setPairings] = useState<MobilePairingForUi[]>([]);
  const [selectedPairing, setSelectedPairing] = useState<MobilePairingForUi | null>(null);
  const [relayStates, setRelayStates] = useState<Record<string, RelayState>>({});
  const [onlineByPairing, setOnlineByPairing] = useState<Record<string, boolean>>({});
  const [connectionErrors, setConnectionErrors] = useState<Record<string, string>>({});
  const [initializationError, setInitializationError] = useState("");
  const [pairingActionError, setPairingActionError] = useState("");
  const [documentError, setDocumentError] = useState("");
  const [transferError, setTransferError] = useState("");
  const [selectedFile, setSelectedFile] = useState<RecentFile | null>(null);
  const [query, setQuery] = useState("");
  const [documentFilter, setDocumentFilter] = useState<DocumentFilter>("all");
  const [folderFilter, setFolderFilter] = useState<FolderFilter>(undefined);
  const [documentGrid, setDocumentGrid] = useState(false);
  const [searchRequest, setSearchRequest] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [unassignedCount, setUnassignedCount] = useState(0);
  const [connectionRetry, setConnectionRetry] = useState(0);
  const relayClients = useRef<Map<string, MobileRelayClient>>(new Map());
  const connectionGeneration = useRef(0);
  const flushingTargets = useRef(new Set<string>());
  const pairingClaims = useRef(new Set<string>());
  const handledPairingPayloads = useRef(new Set<string>());
  const selectedPairingKey = selectedPairing ? getPairingKey(selectedPairing) : "";
  const relayState = relayStates[selectedPairingKey] ?? EMPTY_RELAY_STATE;
  const activeTab: TabKey = route === "viewer" || route === "presentation" ? "documents" : route === "ocr" ? (ocrReturnRoute === "tools" ? "tools" : "documents") : route;

  const addLocalDocument = useCallback((document: LocalDocument) => {
    setImportedFiles((current) => [toRecentFile(document), ...current.filter((item) => item.localId !== document.id)]);
  }, []);

  const loadPairings = useCallback(async () => {
    setInitializationError("");
    try {
      const [storedPairings, stored] = await Promise.all([getStoredPairings(), getStoredPairing()]);
      setPairings(storedPairings);
      setSelectedPairing(stored);
    } catch (error) { setInitializationError(errorMessage(error, "PC 연결 정보를 불러오지 못했습니다.")); }
  }, []);

  const loadDocuments = useCallback(async () => {
    setDocumentError("");
    try {
      const [documents, storedFolders] = await Promise.all([listLocalDocuments(), listLocalFolders()]);
      setImportedFiles(documents.map(toRecentFile));
      setFolders(storedFolders);
    } catch (error) { setDocumentError(errorMessage(error, "문서를 불러오지 못했습니다.")); }
  }, []);

  const refreshQueueState = useCallback(async () => {
    const pending = await listPendingTransfers();
    setPendingCount(pending.length);
    setUnassignedCount(pending.filter((item) => !item.target).length);
    return pending;
  }, []);

  const disconnectRelayClients = () => {
    for (const client of relayClients.current.values()) client.disconnect();
    relayClients.current.clear();
  };

  const flushQueue = async () => {
    let pending: Awaited<ReturnType<typeof listPendingTransfers>>;
    try { pending = await refreshQueueState(); }
    catch (error) { setTransferError(errorMessage(error, "전송 목록을 불러오지 못했습니다.")); return; }
    const { byTarget } = groupTransfersByTarget(pending);
    await Promise.all(Array.from(byTarget.entries()).map(async ([key, items]) => {
      const client = relayClients.current.get(key);
      if (!client || !client.snapshot().connected || !client.snapshot().desktopOnline || flushingTargets.current.has(key)) return;
      flushingTargets.current.add(key);
      try {
        for (const item of items) {
          if (!client.snapshot().connected || !client.snapshot().desktopOnline) break;
          try {
            await updateTransferStatus(item.id, "transferring");
            await client.sendFile({ uri: item.uri, name: item.name, mime: item.mime, transferId: item.id });
            await updateTransferStatus(item.id, "completed");
            setTransferError("");
          } catch (error) {
            await updateTransferStatus(item.id, "failed", error instanceof Error ? error.message : "transfer_failed");
            setTransferError(errorMessage(error, `${item.name} 전송에 실패했습니다.`));
            break;
          }
        }
      } finally { flushingTargets.current.delete(key); }
    }));
    try { await refreshQueueState(); } catch (error) { setTransferError(errorMessage(error, "전송 상태를 갱신하지 못했습니다.")); }
  };

  const enqueueForTarget = async (file: RecentFile, target: StoredMobilePairing) => {
    if (!file.uri) throw new Error("전송할 저장 파일이 없습니다.");
    await enqueueTransfer({ uri: file.uri, name: file.name, mime: file.mime ?? "application/octet-stream", target: { roomId: target.roomId, desktopId: target.desktopId } });
    try { await refreshQueueState(); await flushQueue(); }
    catch (error) { setTransferError(errorMessage(error, "파일은 전송 목록에 추가했지만 상태를 갱신하지 못했습니다.")); }
  };

  const queueFileStrict = async (file: RecentFile) => {
    if (!file.uri) throw new Error("전송할 저장 파일이 없습니다.");
    const target = selectedPairing;
    if (!target) throw new Error(pairings.length ? "설정에서 파일을 보낼 PC를 선택해 주세요." : "PC 앱의 QR 코드를 휴대폰 기본 카메라로 촬영해 연결해 주세요.");
    try { await enqueueForTarget(file, target); }
    catch (error) { throw new Error(errorMessage(error, "파일을 전송 목록에 추가하지 못했습니다.")); }
  };

  const queueFile = async (file: RecentFile) => {
    try { await queueFileStrict(file); }
    catch (error) {
      const message = errorMessage(error, "파일을 전송 목록에 추가하지 못했습니다.");
      setTransferError(message);
      if (!selectedPairing) {
        Alert.alert("보낼 PC 선택", message);
        setRoute("settings");
      }
    }
  };

  const openOcr = (returnRoute: Route, file: RecentFile | null = null) => {
    setSelectedFile(file);
    setOcrReturnRoute(returnRoute);
    setRoute("ocr");
  };

  useEffect(() => {
    void loadPairings();
    void loadDocuments();
    void refreshQueueState().catch((error) => setTransferError(errorMessage(error, "전송 목록을 불러오지 못했습니다.")));
  }, [loadDocuments, loadPairings, refreshQueueState]);

  useEffect(() => {
    const handleUrl = async (url: string) => {
      const payload = pairingPayloadFromUrl(url);
      if (!payload || pairingClaims.current.has(payload) || handledPairingPayloads.current.has(payload)) return;
      pairingClaims.current.add(payload);
      try {
        const nextPairing = await claimPairing(APP_RELAY_BASE_URL, payload);
        handledPairingPayloads.current.add(payload);
        setSelectedPairing(nextPairing);
        try { setPairings(await getStoredPairings()); }
        catch (error) { setInitializationError(errorMessage(error, "저장된 PC 연결 목록을 다시 불러오지 못했습니다.")); }
        setPairingActionError("");
        Alert.alert("PC 연결 완료", `${desktopName(nextPairing)}에 연결되었습니다.`);
      } catch (error) { Alert.alert("PC 연결 실패", errorMessage(error, "QR 연결을 완료하지 못했습니다.")); }
      finally { pairingClaims.current.delete(payload); }
    };
    void Linking.getInitialURL().then((url) => { if (url) void handleUrl(url); }).catch((error) => setInitializationError(errorMessage(error, "연결 링크를 확인하지 못했습니다.")));
    const subscription = Linking.addEventListener("url", ({ url }) => { void handleUrl(url); });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!hasShareIntent || !shareIntent.files?.length) return;
    let cancelled = false;
    void (async () => {
      try {
        setDocumentError("");
        const received: RecentFile[] = [];
        for (const file of shareIntent.files ?? []) received.push(toRecentFile(await importLocalFile({ uri: file.path, name: file.fileName, mimeType: file.mimeType })));
        if (cancelled) return;
        setImportedFiles((current) => [...received, ...current.filter((item) => !received.some((incoming) => incoming.localId === item.localId))]);
        setRoute("documents");
      } catch (error) { if (!cancelled) setDocumentError(errorMessage(error, "공유한 파일을 가져오지 못했습니다.")); }
      finally { if (!cancelled) resetShareIntent(); }
    })();
    return () => { cancelled = true; };
  }, [hasShareIntent, resetShareIntent, shareIntent.files]);

  useEffect(() => {
    const generation = connectionGeneration.current + 1;
    connectionGeneration.current = generation;
    let cancelled = false;
    disconnectRelayClients();
    setRelayStates({});
    setOnlineByPairing({});
    setConnectionErrors({});
    if (pairings.length === 0) return () => { cancelled = true; };
    const clients = new Map<string, MobileRelayClient>();
    const connecting = new Set<string>();
    for (const target of pairings) {
      const key = getPairingKey(target);
      clients.set(key, new MobileRelayClient(APP_RELAY_BASE_URL, target, (state) => {
        if (cancelled || connectionGeneration.current !== generation) return;
        setRelayStates((current) => ({ ...current, [key]: state }));
        setOnlineByPairing((current) => current[key] === state.desktopOnline ? current : { ...current, [key]: state.desktopOnline });
        if (state.connected) setConnectionErrors((current) => { if (!current[key]) return current; const next = { ...current }; delete next[key]; return next; });
      }));
    }
    relayClients.current = clients;
    const connectAll = async () => {
      await Promise.all(Array.from(clients.entries()).map(async ([key, client]) => {
        if (cancelled || connecting.has(key) || client.snapshot().connected) return;
        connecting.add(key);
        try { await client.connect(); }
        catch (error) {
          if (!cancelled && connectionGeneration.current === generation) {
            setConnectionErrors((current) => ({ ...current, [key]: errorMessage(error, "PC에 연결하지 못했습니다.") }));
            setOnlineByPairing((current) => ({ ...current, [key]: false }));
          }
        } finally { connecting.delete(key); }
      }));
    };
    void connectAll();
    const timer = setInterval(() => { void connectAll(); }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      for (const client of clients.values()) client.disconnect();
      if (relayClients.current === clients) relayClients.current.clear();
    };
  }, [connectionRetry, pairings]);

  useEffect(() => { void flushQueue(); }, [onlineByPairing]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (route === "home") return false;
      if (route === "viewer") setRoute("documents");
      else if (route === "presentation") setRoute(presentationReturnRoute);
      else if (route === "ocr") setRoute(ocrReturnRoute);
      else setRoute("home");
      return true;
    });
    return () => subscription.remove();
  }, [ocrReturnRoute, presentationReturnRoute, route]);

  const selectPc = async (target: StoredMobilePairing) => {
    try { const selected = await selectStoredPairing(target); if (selected) setSelectedPairing(selected); setPairingActionError(""); }
    catch (error) { setPairingActionError(errorMessage(error, "기본 PC를 변경하지 못했습니다.")); }
  };

  const removePc = async (target: StoredMobilePairing) => {
    let result: Awaited<ReturnType<typeof revokeStoredPairing>>;
    try {
      result = await revokeStoredPairing(APP_RELAY_BASE_URL, target);
    } catch (error) {
      const message = errorMessage(error, "PC 연결을 해제하지 못했습니다.");
      setPairingActionError(message);
      Alert.alert("연결 해제 실패", `${message}\n\n서버 권한을 확인하지 못해 로컬 연결을 유지했습니다.`, [{ text: "취소", style: "cancel" }, { text: "다시 시도", onPress: () => { void removePc(target); } }]);
      return;
    }
    try {
      relayClients.current.get(getPairingKey(target))?.disconnect();
      relayClients.current.delete(getPairingKey(target));
      await releaseTransfersTarget(target);
      const next = await removeStoredPairing(target);
      setPairings(next);
      await refreshQueueState();
      try { setSelectedPairing(await getStoredPairing()); }
      catch (error) { setSelectedPairing(next[0] ?? null); setInitializationError(errorMessage(error, "기본 PC 정보를 다시 불러오지 못했습니다.")); }
      setPairingActionError("");
      if (result === "already_revoked") Alert.alert("연결 정리 완료", "서버에서 이미 해제된 연결을 이 기기에서도 삭제했습니다.");
    } catch (error) {
      const message = errorMessage(error, "이 기기의 PC 연결 정보를 삭제하지 못했습니다.");
      setPairingActionError(message);
      Alert.alert("로컬 연결 정리 실패", `서버 연결은 해제했지만 ${message}`, [{ text: "확인" }, { text: "다시 시도", onPress: () => { void removePc(target); } }]);
    }
  };

  const openFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;
      const stored = await importLocalFile({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType });
      addLocalDocument(stored);
      setRoute("documents");
    } catch (error) { setDocumentError(errorMessage(error, "파일을 가져오지 못했습니다.")); setRoute("documents"); }
  };

  const openPresentation = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: "application/pdf", copyToCacheDirectory: true, multiple: false });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;
      const stored = await importLocalFile({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType ?? "application/pdf" });
      addLocalDocument(stored);
      setSelectedFile(toRecentFile(stored));
      setPresentationReturnRoute("home");
      setRoute("presentation");
    } catch (error) { setDocumentError(errorMessage(error, "발표할 PDF를 열지 못했습니다.")); }
  };

  const createFolder = async (name: string) => {
    try { const folder = await createLocalFolder(name); setFolders((current) => [...current, folder].sort((a, b) => a.name.localeCompare(b.name))); setDocumentError(""); }
    catch (error) { setDocumentError(errorMessage(error, "폴더를 만들지 못했습니다.")); throw error; }
  };

  const moveDocument = async (file: RecentFile, folderId: string | null) => {
    if (!file.localId) return;
    try { await moveLocalDocument(file.localId, folderId); setImportedFiles((current) => current.map((item) => item.localId === file.localId ? { ...item, folderId } : item)); setDocumentError(""); }
    catch (error) { setDocumentError(errorMessage(error, "문서를 폴더로 옮기지 못했습니다.")); throw error; }
  };

  const assignLegacyTransfers = () => {
    const target = selectedPairing;
    if (!target) { Alert.alert("보낼 PC 선택", "설정에서 파일을 보낼 PC를 먼저 선택해 주세요."); setRoute("settings"); return; }
    Alert.alert("대기 파일 대상 지정", `대상이 기록되지 않은 ${unassignedCount}개 파일을 '${desktopName(target)}'로 보낼까요?`, [{ text: "취소", style: "cancel" }, { text: "이 PC로 지정", onPress: () => { void (async () => { try { await assignUnassignedTransfersTarget(target); await flushQueue(); } catch (error) { setTransferError(errorMessage(error, "대기 파일의 PC를 지정하지 못했습니다.")); } })(); } }]);
  };

  const focusDocumentSearch = () => { setRoute("documents"); setSearchRequest((value) => value + 1); };

  return <SafeAreaProvider><SafeAreaView style={styles.safe} edges={["top", "right", "bottom", "left"]}>
    <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
    {route === "home" && <Home recent={importedFiles.slice(0, 3)} pairings={pairings} selectedPairing={selectedPairing} onlineByPairing={onlineByPairing} error={initializationError} onRetry={loadPairings} onSelectPc={selectPc} onScan={() => setRoute("scan")} onOpen={openFile} onOpenRecent={(file) => { setSelectedFile(file); setRoute("viewer"); }} onSearch={focusDocumentSearch} onDocuments={() => setRoute("documents")} onPresentation={openPresentation} onOcr={() => openOcr("home")} onTools={() => setRoute("tools")} onPair={() => Alert.alert("PC 연결", "PC 앱의 QR 코드를 휴대폰 기본 카메라로 촬영해 주세요.")} />}
    {route === "documents" && <Documents imported={importedFiles} folders={folders} folderFilter={folderFilter} query={query} filter={documentFilter} grid={documentGrid} error={documentError || shareIntentError || ""} transferError={transferError} pendingCount={pendingCount} unassignedCount={unassignedCount} transfer={relayState.transfer} searchRequest={searchRequest} onQueryChange={setQuery} onFilterChange={setDocumentFilter} onFolderFilterChange={setFolderFilter} onGridChange={setDocumentGrid} onSend={queueFile} onOpen={(file) => { setSelectedFile(file); setRoute("viewer"); }} onImport={openFile} onCreateFolder={createFolder} onMove={moveDocument} onRetry={loadDocuments} onRetryTransfer={() => { void flushQueue(); }} onAssignUnassigned={assignLegacyTransfers} />}
    {route === "scan" && <ScannerScreen onClose={() => setRoute("home")} onSaved={async (document) => { addLocalDocument(document); const target = selectedPairing; if (target) { try { await enqueueForTarget(toRecentFile(document), target); } catch (error) { setTransferError(errorMessage(error, "스캔은 저장했지만 PC 전송 목록에 추가하지 못했습니다.")); } } }} onFinished={() => setRoute("documents")} />}
    {route === "tools" && <PdfToolsScreen onSaved={addLocalDocument} onOcr={() => openOcr("tools")} />}
    {route === "settings" && <SettingsScreen pairings={pairings} selectedPairing={selectedPairing} onlineByPairing={onlineByPairing} connectionErrors={connectionErrors} actionError={initializationError || pairingActionError} onPair={() => Alert.alert("PC 연결", "PC 앱의 QR 코드를 휴대폰 기본 카메라로 촬영해 주세요.")} onSelectPairing={selectPc} onRemovePairing={removePc} onRetryConnections={() => { void loadPairings(); setConnectionRetry((value) => value + 1); }} />}
    {route === "viewer" && <DocumentViewerScreen file={selectedFile} onBack={() => setRoute("documents")} onPresent={() => { setPresentationReturnRoute("viewer"); setRoute("presentation"); }} onOcr={() => openOcr("viewer", selectedFile)} onSend={selectedFile?.uri ? () => queueFile(selectedFile) : undefined} />}
    {route === "presentation" && <PresentationScreen file={selectedFile} onBack={() => setRoute(presentationReturnRoute)} />}
    {route === "ocr" && <OcrScreen file={selectedFile} onBack={() => setRoute(ocrReturnRoute)} onSaved={addLocalDocument} onSend={(document) => queueFileStrict(toRecentFile(document))} />}
    {route !== "viewer" && route !== "presentation" && route !== "scan" && route !== "ocr" && <BottomNav active={activeTab} onChange={setRoute} />}
  </SafeAreaView></SafeAreaProvider>;
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void | Promise<void> }) {
  return <View style={styles.errorBanner}><Text style={styles.errorBannerText}>{message}</Text><Pressable style={styles.retryButton} onPress={() => void onRetry()} accessibilityRole="button"><Text style={styles.retryButtonText}>다시 시도</Text></Pressable></View>;
}

function Home({ recent, pairings, selectedPairing, onlineByPairing, error, onRetry, onSelectPc, onScan, onOpen, onOpenRecent, onSearch, onDocuments, onPresentation, onOcr, onTools, onPair }: { recent: RecentFile[]; pairings: MobilePairingForUi[]; selectedPairing: MobilePairingForUi | null; onlineByPairing: Readonly<Record<string, boolean>>; error: string; onRetry: () => void | Promise<void>; onSelectPc: (pairing: StoredMobilePairing) => void | Promise<void>; onScan: () => void; onOpen: () => void; onOpenRecent: (file: RecentFile) => void; onSearch: () => void; onDocuments: () => void; onPresentation: () => void; onOcr: () => void; onTools: () => void; onPair: () => void }) {
  const selectedKey = selectedPairing ? getPairingKey(selectedPairing) : "";
  return <ScrollView style={sharedStyles.content} contentContainerStyle={styles.homeContent} showsVerticalScrollIndicator={false}>
    <ScreenHeader title="문서" right={<IconButton icon="search" accessibilityLabel="문서 검색" onPress={onSearch} />} />
    <SearchBar label="문서 검색" onPress={onSearch} />
    {error && <ErrorBanner message={error} onRetry={onRetry} />}
    <View style={styles.actionGrid}><ActionCard icon="camera" label="촬영" onPress={onScan} /><ActionCard icon="file-text" label="파일 열기" onPress={onOpen} /><ActionCard icon="monitor" label="발표" onPress={onPresentation} /><ActionCard icon="type" label="문자 인식" onPress={onOcr} /><ActionCard icon="layers" label="PDF 도구" onPress={onTools} /></View>
    <View style={styles.sectionHeader}><Text style={sharedStyles.sectionTitle}>최근 문서</Text><Pressable style={styles.linkButton} onPress={onDocuments} accessibilityRole="button"><Text style={styles.link}>전체 보기</Text></Pressable></View>
    <View style={styles.listCard}>{recent.length > 0 ? recent.map((file) => <FileRow key={file.localId ?? file.name} file={file} onPress={() => onOpenRecent(file)} />) : <Text style={styles.emptyText}>아직 저장된 문서가 없습니다.</Text>}</View>
    <View style={styles.pcCard}><View style={styles.pcCardHeader}><View style={styles.pcCardTitleBlock}><Text style={styles.pcTitle}>PC로 바로 보내기</Text><Text style={styles.pcMeta}>선택한 PC로 새 스캔을 전송합니다.</Text></View><Feather name="monitor" size={22} color={colors.primary} /></View>
      {pairings.length > 0 ? <>{pairings.map((pairing) => { const key = getPairingKey(pairing); const selected = key === selectedKey; const online = onlineByPairing[key]; const status = online === undefined ? "연결 대기" : online ? "온라인" : "오프라인"; const statusColor = online === undefined ? colors.textMuted : online ? colors.success : colors.danger; return <Pressable key={key} onPress={() => onSelectPc(pairing)} style={[styles.connectedPc, selected && styles.connectedPcSelected]} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`${desktopName(pairing)}, ${status}${selected ? ", 선택됨" : ""}`}><View style={styles.pcIdentity}><View style={styles.pcStatusIcon}><Feather name="monitor" size={17} color={colors.primary} /></View><View style={styles.pcIdentityText}><Text style={styles.pcName} numberOfLines={1}>{desktopName(pairing)}</Text><Text style={styles.pcId} numberOfLines={1}>{pairing.desktopAlias ? pairing.desktopId : "페어링된 데스크톱"}</Text></View></View><View style={styles.status}><View style={[styles.statusDot, { backgroundColor: statusColor }]} /><Text style={[styles.statusText, { color: statusColor }]}>{status}</Text></View></Pressable>; })}<Pressable style={styles.addPcButton} onPress={onPair} accessibilityRole="button"><Feather name="plus" size={15} color={colors.primary} /><Text style={styles.pairButtonText}>PC 연결 추가</Text></Pressable></> : <View style={styles.unpairedPc}><Text style={styles.unpairedText}>연결된 PC가 없습니다.</Text><Pressable accessibilityRole="button" onPress={onPair} style={styles.pairButton}><Text style={styles.pairButtonText}>PC 연결</Text><Feather name="arrow-right" size={14} color={colors.primary} /></Pressable></View>}
    </View>
  </ScrollView>;
}

function Documents({ imported, folders, folderFilter, query, filter, grid, error, transferError, pendingCount, unassignedCount, transfer, searchRequest, onQueryChange, onFilterChange, onFolderFilterChange, onGridChange, onSend, onOpen, onImport, onCreateFolder, onMove, onRetry, onRetryTransfer, onAssignUnassigned }: { imported: RecentFile[]; folders: LocalFolder[]; folderFilter: FolderFilter; query: string; filter: DocumentFilter; grid: boolean; error: string; transferError: string; pendingCount: number; unassignedCount: number; transfer?: RelayState["transfer"]; searchRequest: number; onQueryChange: (value: string) => void; onFilterChange: (value: DocumentFilter) => void; onFolderFilterChange: (value: FolderFilter) => void; onGridChange: (value: boolean) => void; onSend: (file: RecentFile) => void | Promise<void>; onOpen: (file: RecentFile) => void; onImport: () => void; onCreateFolder: (name: string) => Promise<void>; onMove: (file: RecentFile, folderId: string | null) => Promise<void>; onRetry: () => void | Promise<void>; onRetryTransfer: () => void; onAssignUnassigned: () => void }) {
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [movingFile, setMovingFile] = useState<RecentFile | null>(null);
  const searchInput = useRef<TextInput>(null);
  useEffect(() => { if (searchRequest > 0) searchInput.current?.focus(); }, [searchRequest]);
  const documents = imported.filter((file): file is RecentFile & { localId: string } => Boolean(file.localId));
  const filteredIds = new Set(filterLocalDocuments(documents.map((file) => ({ id: file.localId, title: file.name, uri: file.uri ?? "", pageCount: 0, size: 0, mimeType: file.mime ?? "", createdAt: 0, folderId: file.folderId })), query, filter, folderFilter).map((document) => document.id));
  const filtered = documents.filter((file) => filteredIds.has(file.localId));
  const create = async () => { try { await onCreateFolder(folderName); setFolderName(""); setCreatingFolder(false); } catch { /* Keep the name so the user can correct it. */ } };
  const finishMove = async (folderId: string | null) => { if (!movingFile) return; try { await onMove(movingFile, folderId); setMovingFile(null); } catch { /* The error banner provides retry context. */ } };
  return <View style={sharedStyles.content}>
    <ScreenHeader title="문서" right={<View style={styles.headerActions}><IconButton icon="search" accessibilityLabel="문서 검색창으로 이동" onPress={() => searchInput.current?.focus()} /><IconButton icon={grid ? "list" : "grid"} accessibilityLabel={grid ? "목록 보기" : "격자 보기"} onPress={() => onGridChange(!grid)} /></View>} />
    <View style={styles.searchInputWrap}><Feather name="search" size={16} color={colors.textMuted} /><TextInput ref={searchInput} value={query} onChangeText={onQueryChange} placeholder="문서 검색" placeholderTextColor={colors.textMuted} style={styles.documentSearchInput} returnKeyType="search" /></View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips} contentContainerStyle={styles.chipContent}>{([{ value: "all", label: "전체" }, { value: "pdf", label: "PDF" }, { value: "hwp", label: "한글" }, { value: "office", label: "Office" }, { value: "image", label: "이미지" }] as Array<{ value: DocumentFilter; label: string }>).map((item) => <Chip key={item.value} label={item.label} active={filter === item.value} onPress={() => onFilterChange(item.value)} />)}</ScrollView>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.folderChips} contentContainerStyle={styles.chipContent}><Chip label="모든 폴더" active={folderFilter === undefined} onPress={() => onFolderFilterChange(undefined)} /><Chip label="미분류" active={folderFilter === null} onPress={() => onFolderFilterChange(null)} />{folders.map((folder) => <Chip key={folder.id} label={folder.name} active={folderFilter === folder.id} onPress={() => onFolderFilterChange(folder.id)} />)}</ScrollView>
    {creatingFolder && <View style={styles.folderComposer}><TextInput value={folderName} onChangeText={setFolderName} autoFocus placeholder="폴더 이름" placeholderTextColor={colors.textMuted} style={styles.folderInput} onSubmitEditing={() => void create()} /><Pressable style={styles.folderComposerButton} onPress={() => void create()} accessibilityRole="button"><Text style={styles.folderComposerSave}>만들기</Text></Pressable><Pressable style={styles.folderComposerButton} onPress={() => { setCreatingFolder(false); setFolderName(""); }} accessibilityRole="button"><Text style={styles.folderComposerCancel}>취소</Text></Pressable></View>}
    {movingFile && <View style={styles.movePanel}><View style={styles.moveHeader}><Text style={styles.moveTitle} numberOfLines={1}>'{movingFile.name}' 이동</Text><Pressable style={styles.compactIconButton} onPress={() => setMovingFile(null)} accessibilityRole="button" accessibilityLabel="폴더 이동 취소"><Feather name="x" size={18} color={colors.textMuted} /></Pressable></View><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipContent}><Chip label="미분류" active={movingFile.folderId === null} onPress={() => void finishMove(null)} />{folders.map((folder) => <Chip key={folder.id} label={folder.name} active={movingFile.folderId === folder.id} onPress={() => void finishMove(folder.id)} />)}</ScrollView></View>}
    {error && <ErrorBanner message={error} onRetry={onRetry} />}
    {transferError && <ErrorBanner message={transferError} onRetry={onRetryTransfer} />}
    {(pendingCount > 0 || transfer) && <View style={styles.transferBanner}><Feather name="upload-cloud" size={16} color={colors.primary} /><View style={styles.transferText}><Text style={styles.transferTitle}>{transfer ? `${transfer.filename} 전송 중` : `${pendingCount}개 전송 대기`}</Text><Text style={styles.transferMeta}>{transfer ? `${Math.round((transfer.acknowledgedBytes / Math.max(1, transfer.sentBytes)) * 100)}% 확인됨` : "지정된 PC가 온라인이 되면 자동으로 전송합니다."}</Text></View>{unassignedCount > 0 && <Pressable style={styles.assignButton} onPress={onAssignUnassigned} accessibilityRole="button"><Text style={styles.assignButtonText}>대상 선택</Text></Pressable>}</View>}
    <ScrollView style={styles.documentList} contentContainerStyle={grid ? styles.documentGrid : undefined} showsVerticalScrollIndicator={false}>{filtered.length > 0 ? filtered.map((file) => grid ? <FileTile key={file.localId} file={file} onPress={() => onOpen(file)} onSend={file.uri ? () => onSend(file) : undefined} onMove={() => setMovingFile(file)} /> : <FileRow key={file.localId} file={file} onPress={() => onOpen(file)} onSend={file.uri ? () => onSend(file) : undefined} onMove={() => setMovingFile(file)} large />) : <Text style={styles.emptyText}>{documents.length === 0 ? "가져오거나 스캔한 문서가 여기에 표시됩니다." : "조건에 맞는 문서가 없습니다."}</Text>}</ScrollView>
    <View style={styles.fileActions}><Pressable style={styles.smallButton} onPress={() => setCreatingFolder(true)} accessibilityRole="button"><Feather name="plus" size={16} /><Text style={styles.smallButtonText}>새 폴더</Text></Pressable><Pressable style={styles.smallButton} onPress={onImport} accessibilityRole="button"><Feather name="upload" size={16} /><Text style={styles.smallButtonText}>가져오기</Text></Pressable></View>
  </View>;
}

function stopAndRun(event: GestureResponderEvent, action?: () => void | Promise<void>) { event.stopPropagation(); if (action) void action(); }

function FileRow({ file, onPress, onSend, onMove, large = false }: { file: RecentFile; onPress?: () => void; onSend?: () => void | Promise<void>; onMove?: () => void; large?: boolean }) {
  return <Pressable style={[styles.fileRow, large && styles.fileRowLarge]} onPress={onPress} accessibilityRole="button" accessibilityLabel={`${file.name} 열기`}><View style={styles.fileLeft}><View style={[styles.fileIcon, large && styles.fileIconLarge]}><Feather name="file" size={18} color={colors.primary} /></View><View style={styles.fileText}><Text style={styles.fileName} numberOfLines={1}>{file.name}</Text><Text style={styles.fileMeta}>{file.meta}</Text></View></View><View style={styles.fileRight}>{onMove && <Pressable style={styles.fileIconButton} onPress={(event) => stopAndRun(event, onMove)} accessibilityRole="button" accessibilityLabel={`${file.name} 폴더 이동`}><Feather name="folder" size={16} color={colors.textMuted} /></Pressable>}{onSend && <Pressable style={styles.fileIconButton} onPress={(event) => stopAndRun(event, onSend)} accessibilityRole="button" accessibilityLabel={`${file.name} PC로 보내기`}><Feather name="send" size={16} color={colors.primary} /></Pressable>}<FileBadge label={file.type} /></View></Pressable>;
}

function FileTile({ file, onPress, onSend, onMove }: { file: RecentFile; onPress: () => void; onSend?: () => void | Promise<void>; onMove: () => void }) {
  return <Pressable style={styles.fileTile} onPress={onPress} accessibilityRole="button" accessibilityLabel={`${file.name} 열기`}><View style={styles.tileIcon}><Feather name="file" size={25} color={colors.primary} /></View><Text style={styles.tileName} numberOfLines={2}>{file.name}</Text><Text style={styles.fileMeta}>{file.meta}</Text><View style={styles.tileActions}><Pressable style={styles.fileIconButton} onPress={(event) => stopAndRun(event, onMove)} accessibilityRole="button" accessibilityLabel={`${file.name} 폴더 이동`}><Feather name="folder" size={16} color={colors.textMuted} /></Pressable>{onSend && <Pressable style={styles.fileIconButton} onPress={(event) => stopAndRun(event, onSend)} accessibilityRole="button" accessibilityLabel={`${file.name} PC로 보내기`}><Feather name="send" size={16} color={colors.primary} /></Pressable>}</View></Pressable>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background }, homeContent: { paddingBottom: 18 }, actionGrid: { marginTop: 18, flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 12 }, sectionHeader: { marginTop: 18, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, linkButton: { minWidth: 64, minHeight: 44, alignItems: "flex-end", justifyContent: "center" }, link: { fontSize: 12, color: colors.textMuted, fontWeight: "600" }, listCard: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14 }, emptyText: { paddingVertical: 28, paddingHorizontal: 12, textAlign: "center", color: colors.textMuted, fontSize: 12 },
  errorBanner: { minHeight: 56, marginTop: 10, paddingLeft: 12, borderRadius: 11, borderWidth: 1, borderColor: "#FECACA", backgroundColor: "#FEF2F2", flexDirection: "row", alignItems: "center" }, errorBannerText: { flex: 1, color: colors.danger, fontSize: 11, lineHeight: 17 }, retryButton: { minWidth: 82, minHeight: 44, alignItems: "center", justifyContent: "center" }, retryButtonText: { color: colors.danger, fontSize: 12, fontWeight: "800" },
  searchInputWrap: { height: 46, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14 }, documentSearchInput: { flex: 1, color: colors.text, fontSize: 13, paddingVertical: 0 }, headerActions: { flexDirection: "row", alignItems: "center" }, chips: { marginTop: 10, flexGrow: 0 }, folderChips: { marginTop: 6, flexGrow: 0 }, chipContent: { gap: 8, alignItems: "center" },
  folderComposer: { minHeight: 54, marginTop: 8, paddingLeft: 12, borderRadius: 11, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, flexDirection: "row", alignItems: "center" }, folderInput: { flex: 1, color: colors.text, fontSize: 13 }, folderComposerButton: { minWidth: 60, minHeight: 44, alignItems: "center", justifyContent: "center" }, folderComposerSave: { color: colors.primary, fontSize: 12, fontWeight: "800" }, folderComposerCancel: { color: colors.textMuted, fontSize: 12, fontWeight: "700" },
  movePanel: { marginTop: 8, padding: 10, borderRadius: 11, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }, moveHeader: { minHeight: 44, flexDirection: "row", alignItems: "center" }, moveTitle: { flex: 1, color: colors.text, fontSize: 12, fontWeight: "800" }, compactIconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  transferBanner: { marginTop: 8, minHeight: 58, borderRadius: 12, backgroundColor: colors.primarySoft, paddingLeft: 12, flexDirection: "row", alignItems: "center", gap: 10 }, transferText: { flex: 1, paddingVertical: 8 }, transferTitle: { fontSize: 12, fontWeight: "800", color: colors.text }, transferMeta: { marginTop: 2, fontSize: 10, color: colors.textMuted }, assignButton: { minWidth: 78, minHeight: 44, paddingHorizontal: 8, alignItems: "center", justifyContent: "center" }, assignButtonText: { color: colors.primary, fontSize: 11, fontWeight: "800" },
  documentList: { marginTop: 8, flex: 1, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 10 }, documentGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, paddingVertical: 10 }, fileActions: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: 10 }, smallButton: { minHeight: 44, borderRadius: 11, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 8 }, smallButtonText: { fontSize: 13, fontWeight: "700", color: colors.text },
  fileRow: { minHeight: 64, flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }, fileRowLarge: { minHeight: 68, paddingHorizontal: 4 }, fileLeft: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10 }, fileText: { flex: 1 }, fileIcon: { width: 38, height: 38, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.primarySoft }, fileIconLarge: { width: 40, height: 40 }, fileName: { color: colors.text, fontSize: 13, fontWeight: "700" }, fileMeta: { color: colors.textMuted, fontSize: 11, marginTop: 3 }, fileRight: { flexDirection: "row", alignItems: "center" }, fileIconButton: { width: 44, height: 44, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  fileTile: { width: "48%", minHeight: 160, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background }, tileIcon: { width: 48, height: 48, borderRadius: 12, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" }, tileName: { minHeight: 36, marginTop: 10, color: colors.text, fontSize: 12, lineHeight: 17, fontWeight: "800" }, tileActions: { marginTop: 4, flexDirection: "row", justifyContent: "flex-end" },
  pcCard: { marginTop: 18, borderRadius: radius.md, padding: 16, backgroundColor: colors.primarySoft }, pcCardHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, pcCardTitleBlock: { flex: 1, paddingRight: 12 }, pcTitle: { fontWeight: "800", color: colors.text, fontSize: 14 }, pcMeta: { marginTop: 4, fontSize: 11, color: colors.textMuted }, connectedPc: { minHeight: 56, marginTop: 8, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#BFDBFE", flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }, connectedPcSelected: { backgroundColor: colors.surface, borderRadius: 10, paddingHorizontal: 8, borderTopWidth: 0 }, addPcButton: { minHeight: 44, marginTop: 8, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 }, pcIdentity: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10 }, pcStatusIcon: { width: 32, height: 32, borderRadius: 9, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" }, pcIdentityText: { flex: 1 }, pcName: { color: colors.text, fontSize: 12, fontWeight: "800" }, pcId: { marginTop: 3, color: colors.textMuted, fontSize: 10 }, status: { flexDirection: "row", alignItems: "center", gap: 5 }, statusDot: { width: 7, height: 7, borderRadius: 4 }, statusText: { fontSize: 11, fontWeight: "800" }, unpairedPc: { minHeight: 56, marginTop: 8, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#BFDBFE", flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }, unpairedText: { flex: 1, color: colors.textMuted, fontSize: 11 }, pairButton: { minHeight: 44, paddingHorizontal: 8, flexDirection: "row", alignItems: "center", gap: 5 }, pairButtonText: { color: colors.primary, fontSize: 12, fontWeight: "800" },
});
