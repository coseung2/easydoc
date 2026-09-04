import { useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import DocumentScanner, { ResponseType, ScanDocumentResponseStatus } from "react-native-document-scanner-plugin";
import { Feather } from "@expo/vector-icons";
import { createScannedPdf, type LocalDocument } from "../documents/store.ts";
import { colors, radius } from "../ui/theme";

export function ScannerScreen({ onClose, onSaved }: { onClose: () => void; onSaved: (document: LocalDocument) => void | Promise<void> }) {
  const [pages, setPages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const scan = async (maxNumDocuments = 24) => {
    setBusy(true); setMessage("");
    try {
      const result = await DocumentScanner.scanDocument({ croppedImageQuality: 95, maxNumDocuments, responseType: ResponseType.ImageFilePath });
      if (result.status === ScanDocumentResponseStatus.Success && result.scannedImages?.length) setPages((current) => [...current, ...result.scannedImages!]);
    } catch (error) { setMessage(error instanceof Error ? error.message : "scan_failed"); }
    finally { setBusy(false); }
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction; if (target < 0 || target >= pages.length) return;
    setPages((current) => { const next = [...current]; [next[index], next[target]] = [next[target]!, next[index]!]; return next; });
  };

  const save = async () => {
    setBusy(true); setMessage("");
    try { const document = await createScannedPdf(pages); await onSaved(document); }
    catch (error) { setMessage(error instanceof Error ? error.message : "pdf_generation_failed"); }
    finally { setBusy(false); }
  };

  if (pages.length === 0) return <View style={styles.root}>
    <View style={styles.header}><Pressable style={styles.back} onPress={onClose}><Feather name="x" size={20} /><Text style={styles.headerTitle}>스캔</Text></Pressable></View>
    <Pressable style={styles.preview} onPress={() => scan()}><View style={styles.guide}><Feather name="maximize" size={30} color="#FFFFFF" /></View><Text style={styles.previewTitle}>자동 문서 감지</Text><Text style={styles.previewText}>눌러서 문서 경계 감지 · crop · 원근 보정을 시작합니다.</Text></Pressable>
    <View style={styles.actions}><Pressable style={styles.secondary} onPress={() => scan(1)} disabled={busy}><Feather name="camera" size={18} /><Text style={styles.secondaryText}>한 장 스캔</Text></Pressable><Pressable style={styles.primary} onPress={() => scan()} disabled={busy}><Text style={styles.primaryText}>{busy ? "스캔 중..." : "여러 장 스캔"}</Text></Pressable></View>
    {message && <Text style={styles.error}>{message}</Text>}
  </View>;

  return <View style={styles.root}>
    <View style={styles.header}><Pressable style={styles.back} onPress={onClose}><Feather name="arrow-left" size={20} /><Text style={styles.headerTitle}>페이지 확인</Text></Pressable><Text style={styles.count}>{pages.length}페이지</Text></View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pages}>{pages.map((uri, index) => <View key={`${uri}-${index}`} style={styles.pageCard}><Image source={{ uri }} style={styles.pageImage} resizeMode="contain" /><Text style={styles.pageNumber}>{index + 1}</Text><View style={styles.pageTools}><Pressable onPress={() => move(index, -1)}><Feather name="chevron-left" size={18} /></Pressable><Pressable onPress={() => setPages((current) => current.filter((_, item) => item !== index))}><Feather name="trash-2" size={16} color={colors.danger} /></Pressable><Pressable onPress={() => move(index, 1)}><Feather name="chevron-right" size={18} /></Pressable></View></View>)}</ScrollView>
    <View style={styles.reviewActions}><Pressable style={styles.secondary} onPress={() => scan(1)}><Feather name="plus" size={17} /><Text style={styles.secondaryText}>페이지 추가</Text></Pressable><Pressable style={styles.primary} onPress={save} disabled={busy}><Text style={styles.primaryText}>{busy ? "PDF 생성 중..." : "PDF 만들기"}</Text></Pressable></View>
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
  pages: { gap: 12, paddingVertical: 20, alignItems: "center" },
  pageCard: { width: 260, height: 470, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, padding: 10 },
  pageImage: { flex: 1, backgroundColor: colors.surfaceMuted, borderRadius: 8 },
  pageNumber: { marginTop: 7, textAlign: "center", fontSize: 11, color: colors.textMuted },
  pageTools: { marginTop: 8, height: 32, flexDirection: "row", justifyContent: "space-around", alignItems: "center" },
  reviewActions: { flexDirection: "row", gap: 10 },
  error: { marginTop: 12, color: colors.danger, fontSize: 11, textAlign: "center" },
});
