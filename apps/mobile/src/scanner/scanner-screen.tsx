import { useRef, useState } from "react";
import { CameraView, useCameraPermissions } from "expo-camera";
import DocumentScanner, { ResponseType, ScanDocumentResponseStatus } from "react-native-document-scanner-plugin";
import { Feather } from "@expo/vector-icons";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { createScannedPdf, importLocalFile, type LocalDocument } from "../documents/store.ts";
import { colors, radius } from "../ui/theme";
import { prepareScanPage, rotateScanPage, type EditableScanPage } from "./process-page";
import { imageMimeType, removePageAt, reorderPages, replacePageAt, scanImageName } from "./scanner-flow";

type CaptureMode = "capture" | "scan";
type ScanSaveFormat = "images" | "pdf";

const FILTERS: Array<{ value: EditableScanPage["filter"]; label: string }> = [
  { value: "color", label: "컬러" },
  { value: "gray", label: "회색조" },
  { value: "bw", label: "흑백" },
];

function newPage(uri: string): EditableScanPage {
  return { id: crypto.randomUUID(), uri, rotation: 0, filter: "color" };
}

export function ScannerScreen({ onClose, onSaved, onFinished }: { onClose: () => void; onSaved: (document: LocalDocument) => void | Promise<void>; onFinished?: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [mode, setMode] = useState<CaptureMode>("capture");
  const [pages, setPages] = useState<EditableScanPage[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [format, setFormat] = useState<ScanSaveFormat>("pdf");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const cameraRef = useRef<CameraView>(null);
  const running = useRef(false);

  const capturePhoto = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage("");
    try {
      const photo = await cameraRef.current?.takePictureAsync({ quality: 0.95, exif: false });
      if (!photo?.uri) throw new Error("photo_not_captured");
      const document = await importLocalFile({
        uri: photo.uri,
        name: "photo_" + new Date().toISOString().replace(/[:.]/gu, "-") + ".jpg",
        mimeType: "image/jpeg",
      });
      await onSaved(document);
      onFinished?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "사진 촬영에 실패했습니다.");
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const openScanner = async (replaceIndex?: number) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage("");
    try {
      const result = await DocumentScanner.scanDocument({
        croppedImageQuality: 95,
        maxNumDocuments: replaceIndex === undefined ? 24 : 1,
        responseType: ResponseType.ImageFilePath,
      });
      if (result.status !== ScanDocumentResponseStatus.Success || !result.scannedImages?.length) return;
      if (replaceIndex !== undefined) {
        const replacement = newPage(result.scannedImages[0]!);
        setPages((current) => replacePageAt(current, replaceIndex, replacement));
        setSelectedIndex(replaceIndex);
        return;
      }
      const added = result.scannedImages.map(newPage);
      setPages((current) => [...current, ...added]);
      setSelectedIndex((current) => current === 0 && pages.length === 0 ? 0 : current);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "스캔에 실패했습니다.");
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const selectMode = (nextMode: CaptureMode) => {
    if (nextMode === mode || running.current) return;
    setMode(nextMode);
    setMessage("");
    if (nextMode === "scan") void openScanner();
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (running.current || target < 0 || target >= pages.length) return;
    setPages((current) => reorderPages(current, index, direction));
    setSelectedIndex((current) => current === index ? target : current === target ? index : current);
  };

  const remove = (index: number) => {
    if (running.current) return;
    setPages((current) => removePageAt(current, index));
    setSelectedIndex((current) => Math.max(0, Math.min(current > index ? current - 1 : current, pages.length - 2)));
  };

  const updateSelected = (update: (page: EditableScanPage) => EditableScanPage) => {
    if (running.current) return;
    setPages((current) => current.map((page, index) => index === selectedIndex ? update(page) : page));
  };

  const saveScan = async () => {
    if (!pages.length || running.current) return;
    running.current = true;
    setBusy(true);
    setMessage("");
    try {
      const preparedUris: string[] = [];
      for (const page of pages) preparedUris.push(await prepareScanPage(page));
      if (format === "pdf") {
        await onSaved(await createScannedPdf(preparedUris));
      } else {
        const documents: LocalDocument[] = [];
        for (let index = 0; index < preparedUris.length; index += 1) {
          const uri = preparedUris[index]!;
          const mimeType = imageMimeType(uri);
          documents.push(await importLocalFile({
            uri,
            name: scanImageName(index, uri),
            mimeType,
          }));
        }
        for (const document of documents) await onSaved(document);
      }
      onFinished?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "스캔 저장에 실패했습니다.");
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  if (mode === "capture") {
    if (!permission?.granted) {
      return <View style={styles.permissionRoot}>
        <View style={styles.lightHeader}><Pressable accessibilityLabel="닫기" style={styles.headerButton} onPress={onClose}><Feather name="x" size={22} color={colors.text} /></Pressable><Text style={styles.headerTitle}>촬영</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel="카메라 권한 허용" style={styles.permission} onPress={requestPermission}>
          <Feather name="camera" size={32} color={colors.textMuted} /><Text style={styles.permissionText}>카메라 권한을 허용해 주세요</Text>
        </Pressable>
      </View>;
    }
    return <View style={styles.cameraRoot}>
      <View style={styles.cameraHeader}><Pressable accessibilityLabel="닫기" style={styles.headerButton} onPress={onClose}><Feather name="x" size={22} color="#FFFFFF" /></Pressable><Text style={styles.cameraTitle}>촬영</Text><View style={styles.headerButton} /></View>
      <View style={styles.cameraFrame}><CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" /><View pointerEvents="none" style={styles.photoGuide} /></View>
      <ModeToggle mode={mode} onSelect={selectMode} />
      <View style={styles.captureControls}><Pressable accessibilityLabel="닫기" style={styles.controlButton} onPress={onClose}><Text style={styles.controlText}>닫기</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="사진 촬영" style={styles.shutter} onPress={() => void capturePhoto()} disabled={busy}><View style={styles.shutterInner} /></Pressable><View style={styles.controlButton} /></View>
      {message && <Text style={styles.error}>{message}</Text>}
    </View>;
  }

  const selected = pages[selectedIndex];
  return <View style={styles.scanRoot}>
    <View style={styles.lightHeader}><Pressable accessibilityLabel="닫기" style={styles.headerButton} onPress={onClose}><Feather name="x" size={22} color={colors.text} /></Pressable><Text style={styles.headerTitle}>문서 스캔</Text><Text style={styles.count}>{pages.length ? String(pages.length) + "페이지" : ""}</Text></View>
    {pages.length === 0 ? <View style={styles.scanStart}><View style={styles.scanIllustration}><Feather name="file-text" size={42} color="#FFFFFF" /></View><Text style={styles.scanTitle}>문서 경계 자동 감지</Text><Text style={styles.scanText}>문서의 테두리를 찾아 자르기와 원근을 보정합니다.</Text><Pressable accessibilityRole="button" accessibilityLabel="문서 스캔 시작" style={styles.primary} onPress={() => void openScanner()} disabled={busy}><Text style={styles.primaryText}>{busy ? "스캔 중…" : "문서 스캔 시작"}</Text></Pressable></View> : <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 12 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pages}>{pages.map((page, index) => <Pressable accessibilityRole="button" accessibilityLabel={String(index + 1) + "페이지 선택"} key={page.id} onPress={() => setSelectedIndex(index)} style={[styles.pageCard, index === selectedIndex && styles.pageCardSelected]}><Image source={{ uri: page.uri }} style={[styles.pageImage, { transform: [{ rotate: String(page.rotation) + "deg" }] }]} resizeMode="contain" /><Text style={styles.pageNumber}>{index + 1}</Text><View style={styles.pageTools}><Pressable accessibilityLabel={String(index + 1) + "페이지 앞으로 이동"} hitSlop={8} onPress={() => move(index, -1)}><Feather name="chevron-left" size={20} color={colors.text} /></Pressable><Pressable accessibilityLabel={String(index + 1) + "페이지 삭제"} hitSlop={8} onPress={() => remove(index)}><Feather name="trash-2" size={17} color={colors.danger} /></Pressable><Pressable accessibilityLabel={String(index + 1) + "페이지 뒤로 이동"} hitSlop={8} onPress={() => move(index, 1)}><Feather name="chevron-right" size={20} color={colors.text} /></Pressable></View></Pressable>)}</ScrollView>
      {selected && <><View style={styles.editBar}><Pressable accessibilityRole="button" accessibilityLabel="페이지 회전" style={styles.editAction} onPress={() => updateSelected(rotateScanPage)}><Feather name="rotate-cw" size={17} color={colors.text} /><Text style={styles.editActionText}>회전</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="페이지 재촬영" style={styles.editAction} onPress={() => void openScanner(selectedIndex)} disabled={busy}><Feather name="refresh-cw" size={17} color={colors.text} /><Text style={styles.editActionText}>재촬영</Text></Pressable><Text style={styles.editHint}>{selectedIndex + 1}페이지 편집</Text></View><View style={styles.filters}>{FILTERS.map((filter) => <Pressable accessibilityRole="button" accessibilityLabel={filter.label + " 필터"} key={filter.value} onPress={() => updateSelected((page) => ({ ...page, filter: filter.value }))} style={[styles.filterChip, selected.filter === filter.value && styles.filterChipActive]}><Text style={[styles.filterText, selected.filter === filter.value && styles.filterTextActive]}>{filter.label}</Text></Pressable>)}</View></>}
      <Pressable accessibilityRole="button" accessibilityLabel="페이지 추가" style={styles.secondary} onPress={() => void openScanner()} disabled={busy}><Feather name="plus" size={17} color={colors.text} /><Text style={styles.secondaryText}>페이지 추가</Text></Pressable>
      <Text style={styles.saveLabel}>저장 형식</Text><View style={styles.formatToggle}><FormatButton value="pdf" label="PDF" selected={format} onPress={setFormat} /><FormatButton value="images" label="이미지" selected={format} onPress={setFormat} /></View><Pressable accessibilityRole="button" accessibilityLabel={(format === "pdf" ? "PDF" : "이미지") + " 저장"} style={styles.primary} onPress={() => void saveScan()} disabled={busy}><Text style={styles.primaryText}>{busy ? "저장 중…" : (format === "pdf" ? "PDF 저장" : "이미지 저장")}</Text></Pressable>
    </ScrollView>}
    <ModeToggle mode={mode} onSelect={selectMode} />
    {message && <Text style={styles.error}>{message}</Text>}
  </View>;
}

function ModeToggle({ mode, onSelect }: { mode: CaptureMode; onSelect: (mode: CaptureMode) => void }) {
  return <View style={styles.modeToggle}><Pressable accessibilityRole="button" accessibilityState={{ selected: mode === "capture" }} accessibilityLabel="촬영 모드" onPress={() => onSelect("capture")} style={[styles.modeButton, mode === "capture" && styles.modeButtonActive]}><Feather name="camera" size={16} color={mode === "capture" ? colors.primary : colors.textMuted} /><Text style={[styles.modeText, mode === "capture" && styles.modeTextActive]}>촬영</Text></Pressable><Pressable accessibilityRole="button" accessibilityState={{ selected: mode === "scan" }} accessibilityLabel="스캔 모드" onPress={() => onSelect("scan")} style={[styles.modeButton, mode === "scan" && styles.modeButtonActive]}><Feather name="file-text" size={16} color={mode === "scan" ? colors.primary : colors.textMuted} /><Text style={[styles.modeText, mode === "scan" && styles.modeTextActive]}>스캔</Text></Pressable></View>;
}

function FormatButton({ value, label, selected, onPress }: { value: ScanSaveFormat; label: string; selected: ScanSaveFormat; onPress: (value: ScanSaveFormat) => void }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected: selected === value }} accessibilityLabel={label + " 형식"} onPress={() => onPress(value)} style={[styles.formatButton, selected === value && styles.formatButtonActive]}><Text style={[styles.formatText, selected === value && styles.formatTextActive]}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  permissionRoot: { flex: 1, backgroundColor: colors.background }, scanRoot: { flex: 1, paddingHorizontal: 20, backgroundColor: colors.background }, cameraRoot: { flex: 1, backgroundColor: colors.camera }, lightHeader: { height: 58, flexDirection: "row", alignItems: "center", gap: 12 }, headerButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" }, headerTitle: { flex: 1, fontSize: 21, fontWeight: "800", color: colors.text }, count: { fontSize: 12, color: colors.textMuted, fontWeight: "700" }, permission: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }, permissionText: { color: colors.textMuted, fontWeight: "700" }, cameraHeader: { height: 58, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, cameraTitle: { color: "#FFFFFF", fontSize: 20, fontWeight: "800" }, cameraFrame: { flex: 1, marginHorizontal: 12, borderRadius: radius.lg, overflow: "hidden", backgroundColor: "#111827" }, photoGuide: { position: "absolute", left: "12%", right: "12%", top: "16%", bottom: "16%", borderWidth: 2, borderColor: "rgba(255,255,255,0.8)", borderRadius: 18 }, captureControls: { height: 100, paddingHorizontal: 26, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, controlButton: { width: 70, minHeight: 44, alignItems: "center", justifyContent: "center" }, controlText: { color: "#CBD5E1", fontSize: 12 }, shutter: { width: 68, height: 68, borderRadius: 34, borderWidth: 4, borderColor: "#FFFFFF", alignItems: "center", justifyContent: "center" }, shutterInner: { width: 50, height: 50, borderRadius: 25, backgroundColor: "#FFFFFF" }, modeToggle: { height: 48, marginVertical: 12, padding: 4, borderRadius: 14, backgroundColor: "#1E293B", flexDirection: "row" }, modeButton: { flex: 1, minHeight: 40, borderRadius: 10, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 }, modeButtonActive: { backgroundColor: "#FFFFFF" }, modeText: { color: colors.textMuted, fontSize: 12, fontWeight: "800" }, modeTextActive: { color: colors.primary }, scanStart: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 22, gap: 12 }, scanIllustration: { width: 112, height: 148, borderRadius: 14, backgroundColor: colors.camera, alignItems: "center", justifyContent: "center" }, scanTitle: { color: colors.text, fontSize: 17, fontWeight: "800" }, scanText: { color: colors.textMuted, textAlign: "center", fontSize: 12, lineHeight: 18, marginBottom: 10 }, primary: { minHeight: 44, borderRadius: 12, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", paddingHorizontal: 18, width: "100%" }, primaryText: { color: "#FFFFFF", fontSize: 13, fontWeight: "800" }, pages: { gap: 12, paddingVertical: 14, alignItems: "center" }, pageCard: { width: 224, height: 350, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, padding: 10 }, pageCardSelected: { borderColor: colors.primary, borderWidth: 2 }, pageImage: { flex: 1, backgroundColor: colors.surfaceMuted, borderRadius: 8 }, pageNumber: { marginTop: 7, textAlign: "center", fontSize: 11, color: colors.textMuted, fontWeight: "700" }, pageTools: { marginTop: 5, height: 36, flexDirection: "row", justifyContent: "space-around", alignItems: "center" }, editBar: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 8 }, editAction: { minHeight: 44, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, flexDirection: "row", alignItems: "center", gap: 6 }, editActionText: { fontSize: 11, fontWeight: "700", color: colors.text }, editHint: { marginLeft: "auto", fontSize: 11, color: colors.textMuted }, filters: { flexDirection: "row", gap: 8, marginVertical: 8 }, filterChip: { minWidth: 74, minHeight: 44, paddingHorizontal: 12, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceMuted }, filterChipActive: { backgroundColor: colors.primary }, filterText: { fontSize: 11, fontWeight: "700", color: colors.textMuted }, filterTextActive: { color: "#FFFFFF" }, secondary: { minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, paddingHorizontal: 14 }, secondaryText: { color: colors.text, fontSize: 12, fontWeight: "700" }, saveLabel: { marginTop: 12, marginBottom: 6, color: colors.textMuted, fontSize: 11, fontWeight: "700" }, formatToggle: { height: 44, padding: 3, borderRadius: 12, backgroundColor: colors.surfaceMuted, flexDirection: "row", marginBottom: 10 }, formatButton: { flex: 1, borderRadius: 9, alignItems: "center", justifyContent: "center" }, formatButtonActive: { backgroundColor: colors.surface }, formatText: { color: colors.textMuted, fontSize: 12, fontWeight: "800" }, formatTextActive: { color: colors.primary }, error: { color: colors.danger, fontSize: 11, textAlign: "center", paddingVertical: 8 },
});
