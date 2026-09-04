import { useEffect, useRef, useState } from "react";
import { SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, View, Pressable } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as DocumentPicker from "expo-document-picker";
import { Feather } from "@expo/vector-icons";
import { ActionCard, BottomNav, Chip, FileBadge, IconButton, ScreenHeader, SearchBar, sharedStyles, type TabKey } from "./src/ui/components";
import { colors, radius } from "./src/ui/theme";
import { PairingScreen } from "./src/ui/pairing-screen";
import { SettingsScreen } from "./src/ui/settings-screen";
import { ScannerScreen } from "./src/scanner/scanner-screen";
import { listLocalDocuments, importLocalFile, type LocalDocument } from "./src/documents/store";
import { DocumentViewerScreen, PresentationScreen } from "./src/ui/document-viewer";
import { getStoredPairing } from "./src/pairing/client";
import { countPendingTransfers, enqueueTransfer, listPendingTransfers, updateTransferStatus } from "./src/transfer/queue";
import { MobileRelayClient, type RelayState } from "./src/transfer/client";

type Route = TabKey | "viewer" | "presentation" | "pairing";
const RELAY_BASE_URL = globalThis.process?.env?.EXPO_PUBLIC_RELAY_URL ?? "";
type Filter = "자동" | "컬러" | "회색조" | "흑백";
type RecentFile = { name: string; meta: string; type: string; uri?: string; mime?: string; localId?: string };

const recent: RecentFile[] = [
  { name: "학급교육과정.hwp", meta: "20:14", type: "HWP" },
  { name: "수업나눔 발표자료.pptx", meta: "17:42", type: "PPT" },
  { name: "영수증_0904.pdf", meta: "09:18", type: "PDF" },
];

const files: RecentFile[] = [
  { name: "학급교육과정.hwp", meta: "3.2 MB", type: "HWP" },
  { name: "수업나눔 발표자료.pptx", meta: "8.7 MB", type: "PPT" },
  { name: "가정통신문.pdf", meta: "2 pages", type: "PDF" },
  { name: "학생 설문 결과.xlsx", meta: "142 KB", type: "XLS" },
  { name: "수업 사진.zip", meta: "41.5 MB", type: "ZIP" },
];
function toRecentFile(document: LocalDocument): RecentFile { const extension = document.title.split(".").pop()?.toUpperCase() ?? "FILE"; return { name: document.title, meta: `${document.pageCount > 0 ? `${document.pageCount} pages · ` : ""}${(document.size / 1024 / 1024).toFixed(1)} MB`, type: extension.slice(0, 4), uri: document.uri, mime: document.mimeType, localId: document.id }; }

export default function App() {
  const [route, setRoute] = useState<Route>("home");
  const [importedFiles, setImportedFiles] = useState<RecentFile[]>([]);
  const [paired, setPaired] = useState(false);
  const [relayState, setRelayState] = useState<RelayState>({ connected: false, desktopOnline: false });
  const addLocalDocument = (document: LocalDocument) => setImportedFiles((current) => [toRecentFile(document), ...current.filter((item) => item.localId !== document.id)]);
  const [selectedFile, setSelectedFile] = useState<RecentFile | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const flushingQueue = useRef(false);
  const relayClient = useRef<MobileRelayClient | null>(null);
  const activeTab: TabKey = route === "viewer" || route === "presentation" ? "documents" : route === "pairing" ? "settings" : route;
  const connectRelay = async () => {
    if (!RELAY_BASE_URL) return;
    relayClient.current?.disconnect();
    const client = new MobileRelayClient(RELAY_BASE_URL, setRelayState);
    relayClient.current = client;
    await client.connect();
  };

  const refreshQueueCount = async () => setPendingCount(await countPendingTransfers());
  const flushQueue = async () => {
    if (flushingQueue.current || !relayClient.current || !relayState.connected || !relayState.desktopOnline) return;
    flushingQueue.current = true;
    try {
      const pending = await listPendingTransfers();
      for (const item of pending) {
        try {
          await updateTransferStatus(item.id, "transferring");
          await relayClient.current.sendFile({ uri: item.uri, name: item.name, mime: item.mime, transferId: item.id });
          await updateTransferStatus(item.id, "completed");
        } catch (error) {
          await updateTransferStatus(item.id, "failed", error instanceof Error ? error.message : "transfer_failed");
          break;
        }
      }
    } finally { flushingQueue.current = false; await refreshQueueCount(); }
  };
  const queueFile = async (file: RecentFile) => {
    if (!file.uri) return;
    if (!paired) { setRoute("pairing"); return; }
    await enqueueTransfer({ uri: file.uri, name: file.name, mime: file.mime ?? "application/octet-stream" });
    await refreshQueueCount();
    await flushQueue();
  };

  useEffect(() => {
    let mounted = true;
    getStoredPairing().then((stored) => {
      if (!mounted || !stored) return;
      setPaired(true);
      connectRelay().catch(() => undefined);
    }).catch(() => undefined);
    return () => { mounted = false; relayClient.current?.disconnect(); };
  }, []);

  useEffect(() => {
    listLocalDocuments().then((documents) => setImportedFiles(documents.map(toRecentFile))).catch(() => undefined);
  }, []);

  useEffect(() => { refreshQueueCount().catch(() => undefined); }, []);
  useEffect(() => {
    if (!paired || relayState.connected || !RELAY_BASE_URL) return;
    connectRelay().catch(() => undefined);
    const timer = setInterval(() => connectRelay().catch(() => undefined), 3000);
    return () => clearInterval(timer);
  }, [paired, relayState.connected]);
  useEffect(() => { if (relayState.connected && relayState.desktopOnline) flushQueue().catch(() => undefined); }, [relayState.connected, relayState.desktopOnline]);


  const openFile = async () => {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) return;
    const stored = await importLocalFile({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType });
    addLocalDocument(stored);
    setRoute("documents");
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
      {route === "documents" && <Documents imported={importedFiles} pendingCount={pendingCount} transfer={relayState.transfer} onSend={queueFile} onOpen={(file) => { setSelectedFile(file); setRoute("viewer"); }} onImport={openFile} />}
      {route === "documents" && <Documents imported={importedFiles} pendingCount={pendingCount} transfer={relayState.transfer} onSend={queueFile} onOpen={(file) => setRoute(file.type === "PPT" ? "presentation" : "viewer")} onImport={openFile} />}
      {route === "scan" && <ScannerScreen onClose={() => setRoute("home")} onSaved={(document) => { addLocalDocument(document); setRoute("documents"); }} />}
      {route === "viewer" && <DocumentViewerScreen file={selectedFile} onBack={() => setRoute("documents")} onPresent={() => setRoute("presentation")} />}
      {route === "viewer" && <Viewer onBack={() => setRoute("documents")} />}
      {route === "presentation" && <PresentationScreen file={selectedFile} onBack={() => setRoute(selectedFile ? "viewer" : "documents")} />}
      {route === "presentation" && <Presentation onBack={() => setRoute("documents")} />}
      {route === "pairing" && <PairingScreen relayBaseUrl={RELAY_BASE_URL} onBack={() => setRoute("settings")} onPaired={async () => { setPaired(true); await connectRelay(); setRoute("settings"); }} />}
      {route !== "viewer" && route !== "presentation" && route !== "pairing" && <BottomNav active={activeTab} onChange={setRoute} />}
    </SafeAreaView>
  );
}

function Home({ onScan, onOpen, onDocuments, onPresentation, onTools }: { onScan: () => void; onOpen: () => void; onDocuments: () => void; onPresentation: () => void; onTools: () => void }) {
  return <View style={sharedStyles.content}>
    <ScreenHeader title="문서" right={<IconButton icon="search" />} />
    <SearchBar />
    <View style={styles.actionGrid}>
      <ActionCard icon="maximize" label="스캔" onPress={onScan} />
      <ActionCard icon="file-text" label="파일 열기" onPress={onOpen} />
      <ActionCard icon="monitor" label="발표" onPress={onPresentation} />
      <ActionCard icon="layers" label="PDF 도구" onPress={onTools} />
    </View>
    <View style={styles.sectionHeader}><Text style={sharedStyles.sectionTitle}>최근 문서</Text><Pressable onPress={onDocuments}><Text style={styles.link}>전체 보기</Text></Pressable></View>
    <View style={styles.listCard}>{recent.map((file) => <FileRow key={file.name} file={file} />)}</View>
    <View style={styles.pcCard}><View><Text style={styles.pcTitle}>PC로 바로 보내기</Text><Text style={styles.pcMeta}>연결된 PC가 있으면 스캔 후 자동 전송합니다.</Text></View><Feather name="monitor" size={22} color={colors.primary} /></View>
  </View>;
}

function Documents({ imported, pendingCount, transfer, onSend, onOpen, onImport }: { imported: RecentFile[]; pendingCount: number; transfer?: RelayState["transfer"]; onSend: (file: RecentFile) => void | Promise<void>; onOpen: (file: RecentFile) => void; onImport: () => void }) {
  const [filter, setFilter] = useState("전체");
  const all = [...imported, ...files];
  return <View style={sharedStyles.content}>
    <ScreenHeader title="문서" right={<View style={styles.headerActions}><IconButton icon="search" /><IconButton icon="grid" /></View>} />
    <SearchBar label="문서 검색" />
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips} contentContainerStyle={styles.chipContent}>{["전체", "PDF", "한글", "Office", "이미지"].map((item) => <Chip key={item} label={item} active={filter === item} onPress={() => setFilter(item)} />)}</ScrollView>
    {(pendingCount > 0 || transfer) && <View style={styles.transferBanner}><Feather name="upload-cloud" size={16} color={colors.primary} /><View style={{ flex: 1 }}><Text style={styles.transferTitle}>{transfer ? `${transfer.filename} 전송 중` : `${pendingCount}개 전송 대기`}</Text><Text style={styles.transferMeta}>{transfer ? `${Math.round((transfer.acknowledgedBytes / Math.max(1, transfer.sentBytes)) * 100)}% 확인됨` : "PC가 온라인이 되면 자동으로 전송합니다."}</Text></View></View>}
    <ScrollView style={styles.documentList} showsVerticalScrollIndicator={false}>
      <Text style={styles.groupLabel}>오늘</Text>
      {all.slice(0, 3).map((file) => <FileRow key={`today-${file.name}`} file={file} onPress={() => onOpen(file)} onSend={file.uri ? () => onSend(file) : undefined} large />)}
      <Text style={[styles.groupLabel, styles.groupGap]}>이번 주</Text>
      {all.slice(3).map((file) => <FileRow key={`week-${file.name}`} file={file} onPress={() => onOpen(file)} onSend={file.uri ? () => onSend(file) : undefined} large />)}
    </ScrollView>
    <View style={styles.fileActions}><Pressable style={styles.smallButton}><Feather name="plus" size={16} /><Text style={styles.smallButtonText}>새 폴더</Text></Pressable><Pressable style={styles.smallButton} onPress={onImport}><Feather name="upload" size={16} /><Text style={styles.smallButtonText}>가져오기</Text></Pressable></View>
  </View>;
}

function Scanner({ onClose }: { onClose: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [filter, setFilter] = useState<Filter>("자동");
  const [flash, setFlash] = useState(false);
  const [pages, setPages] = useState<string[]>([]);
  const cameraRef = useRef<CameraView>(null);

  const capture = async () => {
    if (!permission?.granted) { await requestPermission(); return; }
    const photo = await cameraRef.current?.takePictureAsync({ quality: 0.9, skipProcessing: false });
    if (photo?.uri) setPages((current) => [...current, photo.uri]);
  };

  return <View style={sharedStyles.content}>
    <View style={styles.scanHeader}><Pressable onPress={onClose} style={styles.scanTitle}><Feather name="x" size={20} /><Text style={styles.scanTitleText}>스캔</Text></Pressable><IconButton icon="zap" /></View>
    <View style={styles.cameraFrame}>
      {permission?.granted ? <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" enableTorch={flash} /> : <Pressable style={styles.permission} onPress={requestPermission}><Feather name="camera" size={30} color="#CBD5E1" /><Text style={styles.permissionText}>카메라 권한 허용</Text></Pressable>}
      <View style={styles.scanDim} pointerEvents="none" />
      <View style={styles.documentGuide} pointerEvents="none"><Corner position="tl" /><Corner position="tr" /><Corner position="bl" /><Corner position="br" /></View>
      <View style={styles.autoPill}><Feather name="maximize" size={14} color="#FFFFFF" /><Text style={styles.autoText}>자동 감지</Text></View>
    </View>
    <View style={styles.filterRow}>{(["자동", "컬러", "회색조", "흑백"] as Filter[]).map((item) => <Chip key={item} label={item} active={filter === item} onPress={() => setFilter(item)} />)}</View>
    <View style={styles.captureRow}>
      <Pressable style={styles.captureSide}><View style={styles.captureSideIcon}><Feather name="image" size={20} /></View><Text style={styles.captureSideText}>갤러리</Text></Pressable>
      <Pressable style={styles.shutterWrap} onPress={capture}><View style={styles.shutter} />{pages.length > 0 && <View style={styles.pageCount}><Text style={styles.pageCountText}>{pages.length}</Text></View>}</Pressable>
      <Pressable style={styles.captureSide} onPress={() => setFlash((value) => !value)}><View style={[styles.captureSideIcon, flash && styles.captureSideActive]}><Feather name="zap" size={20} color={flash ? colors.primary : colors.text} /></View><Text style={styles.captureSideText}>플래시</Text></Pressable>
    </View>
    {pages.length > 0 && <View style={styles.scanFooter}><Text style={styles.pcMeta}>{pages.length}페이지 촬영됨</Text><Pressable style={styles.primaryButton}><Text style={styles.primaryButtonText}>PDF 만들기</Text></Pressable></View>}
  </View>;
}

function Corner({ position }: { position: "tl" | "tr" | "bl" | "br" }) { return <View style={[styles.corner, position.includes("t") ? styles.cornerTop : styles.cornerBottom, position.includes("l") ? styles.cornerLeft : styles.cornerRight]} />; }

function Viewer({ onBack }: { onBack: () => void }) {
  return <View style={sharedStyles.content}>
    <View style={styles.viewerHeader}><Pressable onPress={onBack} style={styles.viewerTitle}><Feather name="arrow-left" size={20} /><View><Text style={styles.viewerName}>학급교육과정.hwp</Text><Text style={styles.viewerMeta}>3 / 18</Text></View></Pressable><View style={styles.headerActions}><IconButton icon="search" /><IconButton icon="bookmark" /><IconButton icon="share-2" /></View></View>
    <View style={styles.viewerCanvas}><View style={styles.paper}><Text style={styles.paperTitle}>2026학년도 학급교육과정</Text><Text style={styles.paperSub}>5학년</Text>{Array.from({ length: 13 }, (_, index) => <View key={index} style={[styles.paperLine, { width: `${72 + (index % 3) * 8}%` }]} />)}</View></View>
    <View style={styles.toolBar}>{[["edit-3", "필기"], ["edit", "형광펜"], ["message-square", "메모"], ["bookmark", "북마크"], ["copy", "페이지"]].map(([icon, label]) => <View key={label} style={styles.toolItem}><Feather name={icon as never} size={18} /><Text style={styles.toolLabel}>{label}</Text></View>)}</View>
  </View>;
}

function Presentation({ onBack }: { onBack: () => void }) {
  return <View style={sharedStyles.content}>
    <View style={styles.viewerHeader}><Pressable onPress={onBack} style={styles.viewerTitle}><Feather name="arrow-left" size={20} /><View><Text style={styles.viewerName}>수업나눔 발표자료.pptx</Text><Text style={styles.viewerMeta}>2 / 12</Text></View></Pressable><View style={styles.headerActions}><IconButton icon="share-2" /><IconButton icon="maximize-2" /></View></View>
    <View style={styles.presentationCanvas}><View style={styles.slide}><View style={styles.slideMark}><View style={styles.slideCircle} /></View><View><Text style={styles.slideTitle}>수업나눔 발표</Text><Text style={styles.slideSub}>우리 반 프로젝트</Text></View>{Array.from({ length: 5 }, (_, index) => <View key={index} style={[styles.slideLine, { width: `${65 - (index % 3) * 8}%` }]} />)}</View><Text style={styles.slideCount}>2 / 12</Text></View>
    <View style={styles.toolBar}>{[["play", "슬라이드"], ["navigation", "포인터"], ["edit-3", "펜"], ["message-square", "노트"], ["share-2", "공유"]].map(([icon, label]) => <View key={label} style={styles.toolItem}><Feather name={icon as never} size={18} /><Text style={styles.toolLabel}>{label}</Text></View>)}</View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbRow}>{[1, 2, 3, 4].map((item) => <View key={item} style={[styles.thumb, item === 2 && styles.thumbActive]}><Text style={styles.thumbText}>{item}</Text></View>)}</ScrollView>
  </View>;
}

function Tools() {
  const groups = [
    { title: "PDF", items: [["git-merge", "병합"], ["scissors", "분할"], ["minimize", "압축"]] },
    { title: "문서", items: [["type", "OCR"], ["edit-3", "서명"], ["award", "워터마크"]] },
    { title: "기타", items: [["maximize", "QR 스캔"], ["image", "이미지 추출"], ["repeat", "변환"]] },
  ];
  return <View style={sharedStyles.content}><ScreenHeader title="도구" right={<IconButton icon="search" />} />{groups.map((group) => <View key={group.title} style={styles.toolGroup}><Text style={styles.toolGroupTitle}>{group.title}</Text><View style={styles.toolGrid}>{group.items.map(([icon, label]) => <Pressable key={label} style={styles.toolCard}><View style={styles.toolIcon}><Feather name={icon as never} size={19} color={colors.primary} /></View><Text style={styles.toolCardLabel}>{label}</Text></Pressable>)}</View></View>)}</View>;
}

function Settings() {
  return <ScrollView style={sharedStyles.content} showsVerticalScrollIndicator={false}><ScreenHeader title="설정" /><Text style={styles.settingsLabel}>연결</Text><View style={styles.settingsCard}><SettingRow icon="monitor" title="PC 연결" subtitle="QR 코드로 Windows PC와 연결" /><SettingRow icon="wifi" title="전송 상태" subtitle="PC가 온라인일 때 자동 재시도" /><SettingRow icon="folder" title="기본 저장" subtitle="스캔 문서를 기기에 유지" /></View><Text style={styles.settingsLabel}>스캔</Text><View style={styles.settingsCard}><SettingRow icon="maximize" title="자동 문서 감지" subtitle="문서 경계를 감지해 자르기" /><SettingRow icon="layers" title="기본 필터" subtitle="자동" /></View><Text style={styles.settingsLabel}>정보</Text><View style={styles.settingsCard}><SettingRow icon="shield" title="개인정보 및 보안" subtitle="파일은 기본 경로에서 서버에 저장되지 않음" /></View></ScrollView>;
}

function SettingRow({ icon, title, subtitle }: { icon: keyof typeof Feather.glyphMap; title: string; subtitle: string }) { return <Pressable style={styles.settingRow}><View style={styles.settingIcon}><Feather name={icon} size={18} color={colors.primary} /></View><View style={styles.settingText}><Text style={styles.settingTitle}>{title}</Text><Text style={styles.settingSub}>{subtitle}</Text></View><Feather name="chevron-right" size={17} color={colors.textMuted} /></Pressable>; }

function FileRow({ file, onPress, onSend, large = false }: { file: RecentFile; onPress?: () => void; onSend?: () => void | Promise<void>; large?: boolean }) {
  return <Pressable style={[styles.fileRow, large && styles.fileRowLarge]} onPress={onPress}><View style={styles.fileLeft}><View style={[styles.fileIcon, large && styles.fileIconLarge]}><Feather name="file" size={18} color={colors.primary} /></View><View><Text style={styles.fileName}>{file.name}</Text><Text style={styles.fileMeta}>{file.meta}</Text></View></View><View style={styles.fileRight}>{onSend && <Pressable style={styles.sendButton} onPress={onSend}><Feather name="send" size={15} color={colors.primary} /></Pressable>}<FileBadge label={file.type} /></View></Pressable>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  actionGrid: { marginTop: 18, flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 12 },
  sectionHeader: { marginTop: 18, marginBottom: 10, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  link: { fontSize: 12, color: colors.textMuted, fontWeight: "600" },
  listCard: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14 },
  fileRow: { height: 56, flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  fileRowLarge: { height: 60, paddingHorizontal: 4 },
  fileLeft: { flexDirection: "row", alignItems: "center", gap: 12, flexShrink: 1 },
  fileIcon: { width: 38, height: 38, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.primarySoft },
  fileIconLarge: { width: 40, height: 40 },
  fileName: { color: colors.text, fontSize: 13, fontWeight: "700", maxWidth: 220 },
  fileMeta: { color: colors.textMuted, fontSize: 11, marginTop: 3 },
  fileRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  sendButton: { width: 30, height: 30, borderRadius: 9, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" },
  pcCard: { marginTop: 18, borderRadius: radius.md, padding: 16, backgroundColor: colors.primarySoft, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  pcTitle: { fontWeight: "800", color: colors.text, fontSize: 14 },
  pcMeta: { marginTop: 4, fontSize: 11, color: colors.textMuted },
  headerActions: { flexDirection: "row", alignItems: "center" },
  chips: { marginTop: 16, flexGrow: 0 },
  transferBanner: { marginTop: 10, borderRadius: 12, backgroundColor: colors.primarySoft, paddingHorizontal: 12, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 10 },
  transferTitle: { fontSize: 12, fontWeight: "800", color: colors.text },
  transferMeta: { marginTop: 2, fontSize: 10, color: colors.textMuted },
  chipContent: { gap: 8 },
  documentList: { marginTop: 14, flex: 1, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14 },
  groupLabel: { marginTop: 12, color: colors.textMuted, fontSize: 12, fontWeight: "700" },
  groupGap: { marginTop: 18 },
  fileActions: { height: 54, flexDirection: "row", alignItems: "center", gap: 10 },
  smallButton: { height: 38, borderRadius: 11, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 8 },
  smallButtonText: { fontSize: 13, fontWeight: "700", color: colors.text },
  scanHeader: { height: 52, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  scanTitle: { flexDirection: "row", alignItems: "center", gap: 12 },
  scanTitleText: { fontSize: 22, fontWeight: "800", color: colors.text },
  cameraFrame: { height: 492, borderRadius: radius.lg, overflow: "hidden", backgroundColor: colors.camera, alignItems: "center", justifyContent: "center" },
  permission: { alignItems: "center", gap: 8 },
  permissionText: { color: "#CBD5E1", fontWeight: "700" },
  scanDim: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(15,23,42,0.18)" },
  documentGuide: { position: "absolute", top: 68, width: 264, height: 354 },
  corner: { position: "absolute", width: 38, height: 38, borderColor: "#FFFFFF" },
  cornerTop: { top: 0, borderTopWidth: 4 },
  cornerBottom: { bottom: 0, borderBottomWidth: 4 },
  cornerLeft: { left: 0, borderLeftWidth: 4 },
  cornerRight: { right: 0, borderRightWidth: 4 },
  autoPill: { position: "absolute", top: 20, height: 28, paddingHorizontal: 11, borderRadius: 14, backgroundColor: "rgba(15,23,42,0.72)", flexDirection: "row", alignItems: "center", gap: 7 },
  autoText: { color: "#FFFFFF", fontSize: 11, fontWeight: "700" },
  filterRow: { height: 59, flexDirection: "row", gap: 8, alignItems: "center" },
  captureRow: { height: 92, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  captureSide: { width: 70, alignItems: "center", gap: 5 },
  captureSideIcon: { width: 46, height: 46, borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  captureSideActive: { backgroundColor: colors.primarySoft, borderColor: "#BFDBFE" },
  captureSideText: { fontSize: 11, color: colors.textMuted },
  shutterWrap: { width: 78, height: 78, borderRadius: 39, borderWidth: 3, borderColor: colors.text, alignItems: "center", justifyContent: "center" },
  shutter: { width: 60, height: 60, borderRadius: 30, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  pageCount: { position: "absolute", right: -3, top: -3, width: 24, height: 24, borderRadius: 12, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  pageCountText: { color: "#FFFFFF", fontSize: 11, fontWeight: "800" },
  scanFooter: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 4 },
  primaryButton: { height: 38, paddingHorizontal: 16, borderRadius: 12, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  primaryButtonText: { color: "#FFFFFF", fontWeight: "800", fontSize: 13 },
  viewerHeader: { height: 60, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  viewerTitle: { flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 1 },
  viewerName: { fontSize: 14, fontWeight: "800", color: colors.text },
  viewerMeta: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  viewerCanvas: { height: 566, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, alignItems: "center", paddingTop: 8 },
  paper: { width: "90%", height: 514, backgroundColor: colors.surface, borderRadius: 3, paddingHorizontal: 24, paddingTop: 34, shadowColor: "#0F172A", shadowOpacity: 0.08, shadowRadius: 8, elevation: 2 },
  paperTitle: { fontSize: 20, fontWeight: "800", color: colors.text },
  paperSub: { marginTop: 8, fontSize: 13, color: colors.textMuted },
  paperLine: { height: 5, marginTop: 16, borderRadius: 3, backgroundColor: colors.border },
  toolBar: { marginTop: 14, height: 62, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, flexDirection: "row", justifyContent: "space-around", alignItems: "center" },
  toolItem: { width: 56, alignItems: "center", gap: 5 },
  toolLabel: { fontSize: 10, color: colors.textMuted, fontWeight: "600" },
  presentationCanvas: { height: 494, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, alignItems: "center", justifyContent: "center" },
  slide: { width: "88%", height: 388, borderRadius: 4, backgroundColor: colors.surface, padding: 24, flexDirection: "row", flexWrap: "wrap", alignContent: "flex-start", columnGap: 24, shadowColor: "#0F172A", shadowOpacity: 0.08, shadowRadius: 8, elevation: 2 },
  slideMark: { width: 112, height: 112, borderRadius: 18, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" },
  slideCircle: { width: 54, height: 54, borderRadius: 27, backgroundColor: colors.primary },
  slideTitle: { marginTop: 14, fontSize: 22, fontWeight: "900", color: colors.text },
  slideSub: { marginTop: 8, fontSize: 14, color: colors.textMuted },
  slideLine: { height: 7, borderRadius: 4, backgroundColor: colors.border, marginTop: 24 },
  slideCount: { position: "absolute", bottom: 18, fontSize: 11, color: colors.textMuted },
  thumbRow: { height: 66, alignItems: "center", gap: 10, paddingHorizontal: 8 },
  thumb: { width: 78, height: 50, borderRadius: 7, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  thumbActive: { borderWidth: 2, borderColor: colors.primary },
  thumbText: { fontSize: 11, color: colors.textMuted },
  toolGroup: { marginTop: 18 },
  toolGroupTitle: { fontSize: 14, fontWeight: "800", color: colors.text },
  toolGrid: { marginTop: 10, flexDirection: "row", justifyContent: "space-between" },
  toolCard: { width: "31%", height: 94, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center", gap: 10 },
  toolIcon: { width: 38, height: 38, borderRadius: 11, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" },
  toolCardLabel: { fontSize: 12, fontWeight: "700", color: colors.text },
  settingsLabel: { marginTop: 18, marginBottom: 8, color: colors.textMuted, fontSize: 12, fontWeight: "800" },
  settingsCard: { borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, overflow: "hidden" },
  settingRow: { minHeight: 64, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  settingIcon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.primarySoft },
  settingText: { flex: 1 },
  settingTitle: { fontSize: 13, fontWeight: "800", color: colors.text },
  settingSub: { marginTop: 3, fontSize: 11, color: colors.textMuted },
});
