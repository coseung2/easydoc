import { useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import DocumentScanner, { ResponseType, ScanDocumentResponseStatus } from "react-native-document-scanner-plugin";
import { Feather } from "@expo/vector-icons";
import type { ScanFilter } from "@easydoc/image-processing";
import { createScannedPdf, type LocalDocument } from "../documents/store.ts";
import { colors, radius } from "../ui/theme";
import { prepareScanPage, rotateScanPage, type EditableScanPage } from "./process-page";

const FILTERS: Array<{ value: ScanFilter; label: string }> = [
  { value: "color", label: "컬러" },
  { value: "gray", label: "회색조" },
  { value: "bw", label: "흑백" },
];

function newPage(uri: string): EditableScanPage {
  return { id: crypto.randomUUID(), uri, rotation: 0, filter: "color" };
}

export function ScannerScreen({ onClose, onSaved }: { onClose: () => void; onSaved: (document: LocalDocument) => void | Promise<void> }) {
  const [pages, setPages] = useState<EditableScanPage[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const scan = async (maxNumDocuments = 24, replaceIndex?: number) => {
    setBusy(true);
    setMessage("");
    try {
      const result = await DocumentScanner.scanDocument({
        croppedImageQuality: 95,
        maxNumDocuments,
        responseType: ResponseType.ImageFilePath,
      });
      if (result.status !== ScanDocumentResponseStatus.Success || !result.scannedImages?.length) return;
      if (replaceIndex !== undefined) {
        const replacement = newPage(result.scannedImages[0]!);
        setPages((current) => current.map((page, index) => index === replaceIndex ? replacement : page));
        setSelectedIndex(replaceIndex);
        return;
      }
      const added = result.scannedImages.map(newPage);
      setPages((current) => [...current, ...added]);
      setSelectedIndex((current) => pages.length === 0 ? 0 : current);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "scan_failed");
    } finally {
      setBusy(false);
    }
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= pages.length) return;
    setPages((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
    setSelectedIndex((current) => current === index ? target : current === target ? index : current);
  };

  const remove = (index: number) => {
    setPages((current) => current.filter((_, item) => item !== index));
    setSelectedIndex((current) => Math.max(0, Math.min(current > index ? current - 1 : current, pages.length - 2)));
  };

  const updateSelected = (update: (page: EditableScanPage) => EditableScanPage) => {
    setPages((current) => current.map((page, index) => index === selectedIndex ? update(page) : page));
  };

  const save = async () => {
    setBusy(true);
    setMessage("");
    try {
      const preparedUris: string[] = [];
      for (const page of pages) preparedUris.push(await prepareScanPage(page));
      const document = await createScannedPdf(preparedUris);
      await onSaved(document);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "pdf_generation_failed");
    } finally {
      setBusy(false);
    }
  };

  if (pages.length === 0) return <View style={styles.root}>
    <View style={styles.header}><Pressable style={styles.back} onPress={onClose}><Feather name="x" size={20} /><Text style={styles.headerTitle}>스캔</Text></Pressable></View>
    <Pressable style={styles.preview} onPress={() => scan()} disabled={busy}><View style={styles.guide}><Feather name="maximize" size={30} color="#FFFFFF" /></View><Text style={styles.previewTitle}>자동 문서 감지</Text><Text style={styles.previewText}>눌러서 문서 경계 감지 · crop · 원근 보정을 시작합니다.</Text></Pressable>
    <View style={styles.actions}><Pressable style={styles.secondary} onPress={() => scan(1)} disabled={busy}><Feather name="camera" size={18} /><Text style={styles.secondaryText}>한 장 스캔</Text></Pressable><Pressable style={styles.primary} onPress={() => scan()} disabled={busy}><Text style={styles.primaryText}>{busy ? "스캔 중..." : "여러 장 스캔"}</Text></Pressable></View>
    {message && <Text style={styles.error}>{message}</Text>}
  </View>;

  const selected = pages[selectedIndex]!;

  return <View style={styles.root}>
    <View style={styles.header}><Pressable style={styles.back} onPress={onClose}><Feather name="arrow-left" size={20} /><Text style={styles.headerTitle}>페이지 확인</Text></Pressable><Text style={styles.count}>{pages.length}페이지</Text></View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pages}>{pages.map((page, index) => <Pressable key={page.id} onPress={() => setSelectedIndex(index)} style={[styles.pageCard, index === selectedIndex && styles.pageCardSelected]}>
      <Image source={{ uri: page.uri }} style={[styles.pageImage, { transform: [{ rotate: `${page.rotation}deg` }] }]} resizeMode="contain" />
      <Text style={styles.pageNumber}>{index + 1} · {FILTERS.find((filter) => filter.value === page.filter)?.label}</Text>
      <View style={styles.pageTools}><Pressable onPress={() => move(index, -1)}><Feather name="chevron-left" size={18} /></Pressable><Pressable onPress={() => remove(index)}><Feather name="trash-2" size={16} color={colors.danger} /></Pressable><Pressable onPress={() => move(index, 1)}><Feather name="chevron-right" size={18} /></Pressable></View>
    </Pressable>)}</ScrollView>
    <View style={styles.editBar}>
      <Pressable style={styles.editAction} onPress={() => updateSelected(rotateScanPage)}><Feather name="rotate-cw" size={17} /><Text style={styles.editActionText}>회전</Text></Pressable>
      <Pressable style={styles.editAction} onPress={() => scan(1, selectedIndex)} disabled={busy}><Feather name="refresh-cw" size={17} /><Text style={styles.editActionText}>재촬영</Text></Pressable>
      <Text style={styles.editHint}>{selectedIndex + 1}페이지 편집</Text>
    </View>
    <View style={styles.filters}>{FILTERS.map((filter) => <Pressable key={filter.value} onPress={() => updateSelected((page) => ({ ...page, filter: filter.value }))} style={[styles.filterChip, selected.filter === filter.value && styles.filterChipActive]}><Text style={[styles.filterText, selected.filter === filter.value && styles.filterTextActive]}>{filter.label}</Text></Pressable>)}</View>
    <View style={styles.reviewActions}><Pressable style={styles.secondary} onPress={() => scan(1)} disabled={busy}><Feather name="plus" size={17} /><Text style={styles.secondaryText}>페이지 추가</Text></Pressable><Pressable style={styles.primary} onPress={save} disabled={busy}><Text style={styles.primaryText}>{busy ? "PDF 생성 중..." : "PDF 만들기"}</Text></Pressable></View>
    {message && <Text style={styles.error}>{message}</Text>}
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 20, backgroundColor: colors.background },
  header: { height: 54, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  back: { flexDirection: "row", alignItems: "center", gap: 12 },
  headerTitle: { fontSize: 22, fontWeight: "800", color: colors.text },
  count: { fontSize: 12, color: colors.textMuted, fontWeight: "700" },
  preview: { height: 520, borderRadius: radius.lg, backgroundColor: colors.camera, alignItems: "center", justifyContent: "center", padding: 30 },
  guide: { width: 250, height: 330, borderWidth: 3, borderColor: "#FFFFFF", borderRadius: 10, alignItems: "center", justifyContent: "center" },
  previewTitle: { marginTop: 22, color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
  previewText: { marginTop: 7, color: "#CBD5E1", textAlign: "center", fontSize: 11, lineHeight: 17 },
  actions: { flexDirection: "row", gap: 10, marginTop: 18 },
  primary: { flex: 1, minHeight: 44, borderRadius: 12, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", paddingHorizontal: 14 },
  primaryText: { color: "#FFFFFF", fontSize: 13, fontWeight: "800" },
  secondary: { minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, paddingHorizontal: 14 },
  secondaryText: { color: colors.text, fontSize: 12, fontWeight: "700" },
  pages: { gap: 12, paddingVertical: 14, alignItems: "center" },
  pageCard: { width: 240, height: 390, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, padding: 10 },
  pageCardSelected: { borderColor: colors.primary, borderWidth: 2 },
  pageImage: { flex: 1, backgroundColor: colors.surfaceMuted, borderRadius: 8 },
  pageNumber: { marginTop: 7, textAlign: "center", fontSize: 11, color: colors.textMuted },
  pageTools: { marginTop: 8, height: 32, flexDirection: "row", justifyContent: "space-around", alignItems: "center" },
  editBar: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: 8 },
  editAction: { height: 36, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, flexDirection: "row", alignItems: "center", gap: 6 },
  editActionText: { fontSize: 11, fontWeight: "700", color: colors.text },
  editHint: { marginLeft: "auto", fontSize: 11, color: colors.textMuted },
  filters: { flexDirection: "row", gap: 8, marginVertical: 10 },
  filterChip: { minWidth: 64, height: 32, paddingHorizontal: 12, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceMuted },
  filterChipActive: { backgroundColor: colors.primary },
  filterText: { fontSize: 11, fontWeight: "700", color: colors.textMuted },
  filterTextActive: { color: "#FFFFFF" },
  reviewActions: { flexDirection: "row", gap: 10 },
  error: { marginTop: 12, color: colors.danger, fontSize: 11, textAlign: "center" },
});
