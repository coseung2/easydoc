import { useEffect, useRef, useState } from "react";
import { Feather } from "@expo/vector-icons";
import { Directory, File, Paths } from "expo-file-system";
import { useCameraPermissions } from "expo-camera";
import {
  ImageRef,
  SaveImageOptions,
  ScanbotDocumentScannerView,
  type ScanbotDocumentScannerViewHandle,
} from "react-native-scanbot-sdk";
import { Image, Pressable, ScrollView, StatusBar, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { createScannedPdf, importLocalFile, type LocalDocument } from "../documents/store.ts";
import { colors, radius } from "../ui/theme";
import { scannerCameraBehavior, type CaptureMode } from "./camera-mode";
import { initializeDocumentScannerSdk } from "./scanbot-sdk";
import { prepareScanPage, rotateScanPage, type EditableScanPage } from "./process-page";
import { removePageAt, reorderPages, replacePageAt } from "./scanner-flow";

type ScannerStage = "camera" | "review";

const FILTERS: Array<{ value: EditableScanPage["filter"]; label: string }> = [
  { value: "color", label: "컬러" },
  { value: "gray", label: "회색조" },
  { value: "bw", label: "흑백" },
];

function newPage(uri: string): EditableScanPage {
  return { id: crypto.randomUUID(), uri, rotation: 0, filter: "color" };
}

function removeTemporaryFile(uri: string) {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Cache cleanup is best-effort. The document has already been copied before this is called.
  }
}

async function saveImageRef(image: ImageRef, prefix: "photo" | "scan"): Promise<string> {
  const directory = new Directory(Paths.cache, "EasyDoc", "camera");
  directory.create({ intermediates: true, idempotent: true });
  const target = new File(directory, `${prefix}_${crypto.randomUUID()}.jpg`);
  const saved = await image.saveImage(target.uri, new SaveImageOptions({ quality: 95, optimize: true }));
  if (!saved) throw new Error("촬영 이미지를 저장하지 못했습니다.");
  return target.uri;
}

export function ScannerScreen({ onClose, onSaved, onFinished }: { onClose: () => void; onSaved: (document: LocalDocument) => void | Promise<void>; onFinished?: () => void }) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [sdkReady, setSdkReady] = useState(false);
  const [stage, setStage] = useState<ScannerStage>("camera");
  const [mode, setMode] = useState<CaptureMode>("capture");
  const [pages, setPages] = useState<EditableScanPage[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [replaceIndex, setReplaceIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const scannerRef = useRef<ScanbotDocumentScannerViewHandle>(null);
  const processing = useRef(false);
  const temporaryUris = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    void initializeDocumentScannerSdk()
      .then(() => { if (!cancelled) setSdkReady(true); })
      .catch((error) => { if (!cancelled) setMessage(error instanceof Error ? error.message : "문서 스캐너를 시작하지 못했습니다."); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => () => {
    for (const uri of temporaryUris.current) removeTemporaryFile(uri);
    temporaryUris.current.clear();
  }, []);

  const rememberTemporary = (uri: string) => {
    temporaryUris.current.add(uri);
    return uri;
  };

  const forgetTemporary = (uri: string) => {
    temporaryUris.current.delete(uri);
    removeTemporaryFile(uri);
  };

  const handleSnappedDocument = async (originalImage: ImageRef, documentImage?: ImageRef) => {
    if (processing.current) return;
    processing.current = true;
    setBusy(true);
    setMessage("");
    try {
      if (mode === "capture") {
        const uri = rememberTemporary(await saveImageRef(originalImage, "photo"));
        try {
          const document = await importLocalFile({
            uri,
            name: "photo_" + new Date().toISOString().replace(/[:.]/gu, "-") + ".jpg",
            mimeType: "image/jpeg",
          });
          await onSaved(document);
          onFinished?.();
        } finally {
          forgetTemporary(uri);
        }
        return;
      }

      const uri = rememberTemporary(await saveImageRef(documentImage ?? originalImage, "scan"));
      const page = newPage(uri);
      if (replaceIndex !== null) {
        const replaced = pages[replaceIndex];
        setPages((current) => replacePageAt(current, replaceIndex, page));
        if (replaced) forgetTemporary(replaced.uri);
        setSelectedIndex(replaceIndex);
        setReplaceIndex(null);
        setStage("review");
      } else {
        setPages((current) => [...current, page]);
        setSelectedIndex((current) => pages.length === 0 ? 0 : current);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : (mode === "capture" ? "사진 촬영에 실패했습니다." : "문서 스캔에 실패했습니다."));
    } finally {
      processing.current = false;
      setBusy(false);
    }
  };

  const selectMode = (nextMode: CaptureMode) => {
    if (nextMode === mode || processing.current || replaceIndex !== null) return;
    setMode(nextMode);
    setMessage("");
  };

  const snap = () => {
    if (!sdkReady || !permission?.granted || busy || processing.current) return;
    scannerRef.current?.snapDocument(true);
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (processing.current || target < 0 || target >= pages.length) return;
    setPages((current) => reorderPages(current, index, direction));
    setSelectedIndex((current) => current === index ? target : current === target ? index : current);
  };

  const remove = (index: number) => {
    if (processing.current) return;
    const removed = pages[index];
    if (removed) forgetTemporary(removed.uri);
    setPages((current) => removePageAt(current, index));
    setSelectedIndex((current) => Math.max(0, Math.min(current > index ? current - 1 : current, pages.length - 2)));
    if (pages.length === 1) setStage("camera");
  };

  const updateSelected = (update: (page: EditableScanPage) => EditableScanPage) => {
    if (processing.current) return;
    setPages((current) => current.map((page, index) => index === selectedIndex ? update(page) : page));
  };

  const retakeSelected = () => {
    if (!pages[selectedIndex] || processing.current) return;
    setMode("scan");
    setReplaceIndex(selectedIndex);
    setMessage("");
    setStage("camera");
  };

  const saveScan = async () => {
    if (!pages.length || processing.current) return;
    processing.current = true;
    setBusy(true);
    setMessage("");
    try {
      const preparedUris: string[] = [];
      for (const page of pages) preparedUris.push(await prepareScanPage(page));
      await onSaved(await createScannedPdf(preparedUris));
      for (const page of pages) forgetTemporary(page.uri);
      setPages([]);
      onFinished?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "PDF 저장에 실패했습니다.");
    } finally {
      processing.current = false;
      setBusy(false);
    }
  };

  if (stage === "review" && pages.length > 0) {
    const selected = pages[selectedIndex];
    return <><StatusBar barStyle="dark-content" backgroundColor={colors.background} translucent /><View style={[styles.reviewRoot, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.lightHeader}>
        <Pressable accessibilityLabel="카메라로 돌아가기" style={styles.headerButton} onPress={() => setStage("camera")}><Feather name="chevron-left" size={22} color={colors.text} /></Pressable>
        <Text style={styles.headerTitle}>스캔 확인</Text>
        <Text style={styles.count}>{pages.length}페이지</Text>
      </View>
      <ScrollView style={styles.reviewScroll} contentContainerStyle={styles.reviewContent} showsVerticalScrollIndicator={false}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pages}>
          {pages.map((page, index) => <Pressable accessibilityRole="button" accessibilityLabel={String(index + 1) + "페이지 선택"} key={page.id} onPress={() => setSelectedIndex(index)} style={[styles.pageCard, index === selectedIndex && styles.pageCardSelected]}>
            <Image source={{ uri: page.uri }} style={[styles.pageImage, { transform: [{ rotate: String(page.rotation) + "deg" }] }]} resizeMode="contain" />
            <Text style={styles.pageNumber}>{index + 1}</Text>
            <View style={styles.pageTools}>
              <Pressable accessibilityLabel={String(index + 1) + "페이지 앞으로 이동"} hitSlop={8} onPress={() => move(index, -1)}><Feather name="chevron-left" size={20} color={colors.text} /></Pressable>
              <Pressable accessibilityLabel={String(index + 1) + "페이지 삭제"} hitSlop={8} onPress={() => remove(index)}><Feather name="trash-2" size={17} color={colors.danger} /></Pressable>
              <Pressable accessibilityLabel={String(index + 1) + "페이지 뒤로 이동"} hitSlop={8} onPress={() => move(index, 1)}><Feather name="chevron-right" size={20} color={colors.text} /></Pressable>
            </View>
          </Pressable>)}
        </ScrollView>
        {selected && <>
          <View style={styles.editBar}>
            <Pressable accessibilityRole="button" accessibilityLabel="페이지 회전" style={styles.editAction} onPress={() => updateSelected(rotateScanPage)}><Feather name="rotate-cw" size={17} color={colors.text} /><Text style={styles.editActionText}>회전</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="페이지 재촬영" style={styles.editAction} onPress={retakeSelected} disabled={busy}><Feather name="refresh-cw" size={17} color={colors.text} /><Text style={styles.editActionText}>재촬영</Text></Pressable>
            <Text style={styles.editHint}>{selectedIndex + 1}페이지 편집</Text>
          </View>
          <View style={styles.filters}>{FILTERS.map((filter) => <Pressable accessibilityRole="button" accessibilityLabel={filter.label + " 필터"} key={filter.value} onPress={() => updateSelected((page) => ({ ...page, filter: filter.value }))} style={[styles.filterChip, selected.filter === filter.value && styles.filterChipActive]}><Text style={[styles.filterText, selected.filter === filter.value && styles.filterTextActive]}>{filter.label}</Text></Pressable>)}</View>
        </>}
        <Pressable accessibilityRole="button" accessibilityLabel="페이지 추가 촬영" style={styles.secondary} onPress={() => { setMode("scan"); setStage("camera"); }} disabled={busy}><Feather name="plus" size={17} color={colors.text} /><Text style={styles.secondaryText}>페이지 추가 촬영</Text></Pressable>
        <Text style={styles.ocrHint}>PDF로 저장한 뒤 EasyDoc 문자 인식(OCR)을 사용할 수 있습니다.</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="PDF 저장" style={styles.primary} onPress={() => void saveScan()} disabled={busy}><Text style={styles.primaryText}>{busy ? "저장 중…" : "PDF 저장"}</Text></Pressable>
        {message ? <Text style={styles.reviewError}>{message}</Text> : null}
      </ScrollView>
    </View></>;
  }

  const behavior = scannerCameraBehavior(mode);
  const cameraAvailable = sdkReady && permission?.granted;

  return <><StatusBar barStyle="light-content" backgroundColor="transparent" translucent /><View style={styles.cameraRoot}>
    {cameraAvailable ? <ScanbotDocumentScannerView
      ref={scannerRef}
      style={StyleSheet.absoluteFill}
      autoSnappingEnabled={behavior.autoSnappingEnabled && !busy}
      autoSnappingSensitivity={0.62}
      detectDocumentAfterSnap={behavior.detectDocumentAfterSnap}
      polygonEnabled={behavior.polygonEnabled}
      polygonColor="rgba(255,255,255,0.72)"
      polygonColorOK="#22C55E"
      polygonLineWidth={3}
      polygonCornerRadius={10}
      polygonAutoSnapProgressEnabled={mode === "scan"}
      polygonAutoSnapProgressColor="#FFFFFF"
      cameraPreviewMode="FILL_IN"
      photoQualityPrioritization="QUALITY"
      touchToFocusEnabled
      onSnappedDocumentResult={handleSnappedDocument}
      onError={(error) => setMessage(error.message || "카메라 처리 중 오류가 발생했습니다.")}
    /> : <View style={styles.cameraFallback}>
      <Feather name="camera" size={34} color="#CBD5E1" />
      <Text style={styles.cameraFallbackTitle}>{message ? "카메라를 시작하지 못했습니다" : permission === null || !sdkReady ? "카메라 준비 중…" : "카메라 권한이 필요합니다"}</Text>
      {!permission?.granted && permission !== null ? <Pressable accessibilityRole="button" accessibilityLabel="카메라 권한 허용" style={styles.permissionButton} onPress={() => void requestPermission()}><Text style={styles.permissionButtonText}>카메라 권한 허용</Text></Pressable> : null}
      {message ? <Text style={styles.cameraFallbackText}>{message}</Text> : null}
    </View>}

    <View pointerEvents="box-none" style={[styles.topOverlay, { paddingTop: insets.top + 10 }]}>
      <Pressable accessibilityLabel="촬영 닫기" style={styles.cameraIconButton} onPress={onClose}><Feather name="x" size={24} color="#FFFFFF" /></Pressable>
      <View style={styles.cameraTitlePill}><Text style={styles.cameraTitle}>{replaceIndex !== null ? `${replaceIndex + 1}페이지 재촬영` : mode === "scan" ? "문서 스캔" : "촬영"}</Text></View>
      {mode === "scan" && pages.length > 0 ? <Pressable accessibilityRole="button" accessibilityLabel="스캔 확인" style={styles.doneButton} onPress={() => setStage("review")}><Text style={styles.doneButtonText}>완료</Text></Pressable> : <View style={styles.cameraIconButton} />}
    </View>

    {mode === "scan" && cameraAvailable ? <View pointerEvents="none" style={[styles.scanHint, { top: insets.top + 76 }]}><Text style={styles.scanHintText}>{replaceIndex !== null ? "교체할 문서를 맞춰 주세요" : "문서를 맞추면 자동으로 촬영됩니다"}</Text></View> : null}

    {mode === "scan" && pages.length > 0 ? <Pressable accessibilityRole="button" accessibilityLabel={`${pages.length}페이지 스캔 확인`} style={[styles.pageBadge, { bottom: insets.bottom + 28 }]} onPress={() => setStage("review")}>
      <Feather name="file-text" size={18} color="#FFFFFF" /><Text style={styles.pageBadgeText}>{pages.length}</Text>
    </Pressable> : null}

    <View pointerEvents="box-none" style={[styles.shutterDock, { bottom: insets.bottom + 20 }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={mode === "scan" ? "문서 수동 촬영" : "사진 촬영"} style={[styles.shutter, busy && styles.shutterDisabled]} onPress={snap} disabled={!cameraAvailable || busy}><View style={styles.shutterInner} /></Pressable>
    </View>

    <ModeToggle mode={mode} onSelect={selectMode} disabled={replaceIndex !== null || busy} bottom={insets.bottom + 22} />

    {busy ? <View pointerEvents="none" style={[styles.busyPill, { bottom: insets.bottom + 112 }]}><Text style={styles.busyText}>{mode === "scan" ? "페이지 처리 중…" : "저장 중…"}</Text></View> : message && cameraAvailable ? <View pointerEvents="none" style={[styles.errorPill, { bottom: insets.bottom + 112 }]}><Text style={styles.errorPillText}>{message}</Text></View> : null}
  </View></>;
}

function ModeToggle({ mode, onSelect, disabled, bottom }: { mode: CaptureMode; onSelect: (mode: CaptureMode) => void; disabled: boolean; bottom: number }) {
  return <View style={[styles.modeToggle, { bottom }]}>
    <Pressable accessibilityRole="button" accessibilityState={{ selected: mode === "capture", disabled }} accessibilityLabel="촬영 모드" disabled={disabled} onPress={() => onSelect("capture")} style={[styles.modeButton, mode === "capture" && styles.modeButtonActive]}><Feather name="camera" size={14} color={mode === "capture" ? colors.text : "#CBD5E1"} /><Text style={[styles.modeText, mode === "capture" && styles.modeTextActive]}>촬영</Text></Pressable>
    <Pressable accessibilityRole="button" accessibilityState={{ selected: mode === "scan", disabled }} accessibilityLabel="스캔 모드" disabled={disabled} onPress={() => onSelect("scan")} style={[styles.modeButton, mode === "scan" && styles.modeButtonActive]}><Feather name="maximize" size={14} color={mode === "scan" ? colors.text : "#CBD5E1"} /><Text style={[styles.modeText, mode === "scan" && styles.modeTextActive]}>스캔</Text></Pressable>
  </View>;
}

const styles = StyleSheet.create({
  cameraRoot: { flex: 1, backgroundColor: "#020617" },
  cameraFallback: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14, paddingHorizontal: 32, backgroundColor: "#020617" },
  cameraFallbackTitle: { color: "#FFFFFF", fontSize: 16, fontWeight: "800", textAlign: "center" },
  cameraFallbackText: { color: "#CBD5E1", fontSize: 12, lineHeight: 18, textAlign: "center" },
  permissionButton: { minHeight: 44, paddingHorizontal: 18, borderRadius: 12, backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center" },
  permissionButtonText: { color: colors.text, fontSize: 13, fontWeight: "800" },
  topOverlay: { position: "absolute", left: 12, right: 12, top: 0, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cameraIconButton: { width: 46, height: 46, borderRadius: 23, backgroundColor: "rgba(15,23,42,0.48)", alignItems: "center", justifyContent: "center" },
  cameraTitlePill: { minHeight: 34, paddingHorizontal: 14, borderRadius: 17, backgroundColor: "rgba(15,23,42,0.48)", alignItems: "center", justifyContent: "center" },
  cameraTitle: { color: "#FFFFFF", fontSize: 13, fontWeight: "800" },
  doneButton: { minWidth: 54, height: 42, paddingHorizontal: 12, borderRadius: 21, backgroundColor: "rgba(255,255,255,0.94)", alignItems: "center", justifyContent: "center" },
  doneButtonText: { color: colors.text, fontSize: 12, fontWeight: "800" },
  scanHint: { position: "absolute", alignSelf: "center", paddingHorizontal: 13, minHeight: 32, borderRadius: 16, backgroundColor: "rgba(15,23,42,0.56)", alignItems: "center", justifyContent: "center" },
  scanHintText: { color: "#FFFFFF", fontSize: 11, fontWeight: "700" },
  shutterDock: { position: "absolute", left: 0, right: 0, alignItems: "center", justifyContent: "center" },
  shutter: { width: 76, height: 76, borderRadius: 38, borderWidth: 4, borderColor: "#FFFFFF", backgroundColor: "rgba(15,23,42,0.16)", alignItems: "center", justifyContent: "center" },
  shutterDisabled: { opacity: 0.55 },
  shutterInner: { width: 58, height: 58, borderRadius: 29, backgroundColor: "#FFFFFF" },
  modeToggle: { position: "absolute", right: 16, width: 66, padding: 4, borderRadius: 16, backgroundColor: "rgba(15,23,42,0.62)", gap: 3 },
  modeButton: { minHeight: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", gap: 2 },
  modeButtonActive: { backgroundColor: "rgba(255,255,255,0.96)" },
  modeText: { color: "#CBD5E1", fontSize: 10, fontWeight: "800" },
  modeTextActive: { color: colors.text },
  pageBadge: { position: "absolute", left: 18, width: 58, height: 58, borderRadius: 16, backgroundColor: "rgba(15,23,42,0.68)", flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.24)" },
  pageBadgeText: { color: "#FFFFFF", fontSize: 14, fontWeight: "900" },
  busyPill: { position: "absolute", alignSelf: "center", paddingHorizontal: 13, minHeight: 32, borderRadius: 16, backgroundColor: "rgba(15,23,42,0.72)", alignItems: "center", justifyContent: "center" },
  busyText: { color: "#FFFFFF", fontSize: 11, fontWeight: "700" },
  errorPill: { position: "absolute", left: 32, right: 32, paddingHorizontal: 13, paddingVertical: 9, borderRadius: 14, backgroundColor: "rgba(127,29,29,0.88)", alignItems: "center", justifyContent: "center" },
  errorPillText: { color: "#FFFFFF", fontSize: 11, fontWeight: "700", textAlign: "center" },
  reviewRoot: { flex: 1, paddingHorizontal: 20, backgroundColor: colors.background },
  reviewScroll: { flex: 1 },
  reviewContent: { paddingBottom: 18 },
  lightHeader: { height: 58, flexDirection: "row", alignItems: "center", gap: 12 },
  headerButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, fontSize: 21, fontWeight: "800", color: colors.text },
  count: { fontSize: 12, color: colors.textMuted, fontWeight: "700" },
  pages: { gap: 12, paddingVertical: 14, alignItems: "center" },
  pageCard: { width: 224, height: 350, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, padding: 10 },
  pageCardSelected: { borderColor: colors.primary, borderWidth: 2 },
  pageImage: { flex: 1, backgroundColor: colors.surfaceMuted, borderRadius: 8 },
  pageNumber: { marginTop: 7, textAlign: "center", fontSize: 11, color: colors.textMuted, fontWeight: "700" },
  pageTools: { marginTop: 5, height: 36, flexDirection: "row", justifyContent: "space-around", alignItems: "center" },
  editBar: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 8 },
  editAction: { minHeight: 44, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, flexDirection: "row", alignItems: "center", gap: 6 },
  editActionText: { fontSize: 11, fontWeight: "700", color: colors.text },
  editHint: { marginLeft: "auto", fontSize: 11, color: colors.textMuted },
  filters: { flexDirection: "row", gap: 8, marginVertical: 8 },
  filterChip: { minWidth: 74, minHeight: 44, paddingHorizontal: 12, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceMuted },
  filterChipActive: { backgroundColor: colors.primary },
  filterText: { fontSize: 11, fontWeight: "700", color: colors.textMuted },
  filterTextActive: { color: "#FFFFFF" },
  secondary: { minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, paddingHorizontal: 14, marginTop: 6 },
  secondaryText: { color: colors.text, fontSize: 12, fontWeight: "700" },
  ocrHint: { marginTop: 14, marginBottom: 8, color: colors.textMuted, fontSize: 11, lineHeight: 17, textAlign: "center" },
  primary: { minHeight: 48, borderRadius: 12, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", paddingHorizontal: 18, width: "100%" },
  primaryText: { color: "#FFFFFF", fontSize: 13, fontWeight: "800" },
  reviewError: { color: colors.danger, fontSize: 11, textAlign: "center", paddingVertical: 8 },
});
