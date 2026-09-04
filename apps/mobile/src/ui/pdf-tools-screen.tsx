import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { convert as pdfToImages } from "react-native-pdf-to-image";
import { imagesToPdf, mergePdfs, optimizePdf, pageCount, reorderAndDeletePdf, rotatePdf, splitPdf } from "../../../../packages/pdf-tools/src/index.ts";
import { importLocalFile, saveGeneratedPdf, type LocalDocument } from "../documents/store.ts";
import { ScreenHeader } from "./components";
import { colors, radius } from "./theme";

type Picked = { uri: string; name: string; mimeType?: string | null };
type Editor = { name: string; bytes: Uint8Array; order: number[] };

async function pick(type: string, multiple = false): Promise<Picked[]> {
  const result = await DocumentPicker.getDocumentAsync({ type, multiple, copyToCacheDirectory: true });
  return result.canceled ? [] : result.assets.map((asset) => ({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType }));
}
async function bytes(uri: string) { return new File(uri).bytes(); }
function baseName(name: string) { return name.replace(/\.pdf$/iu, ""); }

export function PdfToolsScreen({ onSaved }: { onSaved: (document: LocalDocument) => void | Promise<void> }) {
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);

  const run = async (label: string, task: () => Promise<void>) => {
    setBusy(label); setMessage("");
    try { await task(); setMessage(`${label} 완료`); }
    catch (error) { setMessage(error instanceof Error ? error.message : `${label} 실패`); }
    finally { setBusy(""); }
  };

  const merge = () => run("PDF 병합", async () => {
    const files = await pick("application/pdf", true); if (files.length < 2) return;
    const output = await mergePdfs(await Promise.all(files.map((file) => bytes(file.uri))));
    await onSaved(await saveGeneratedPdf(output, `병합_${Date.now()}.pdf`, await pageCount(output)));
  });
  const split = () => run("PDF 분할", async () => {
    const [file] = await pick("application/pdf"); if (!file) return;
    const parts = await splitPdf(await bytes(file.uri));
    for (let index = 0; index < parts.length; index += 1) await onSaved(await saveGeneratedPdf(parts[index]!, `${baseName(file.name)}_${String(index + 1).padStart(3, "0")}.pdf`, 1));
  });
  const rotate = () => run("페이지 회전", async () => {
    const [file] = await pick("application/pdf"); if (!file) return;
    const output = await rotatePdf(await bytes(file.uri), 90);
    await onSaved(await saveGeneratedPdf(output, `${baseName(file.name)}_회전.pdf`, await pageCount(output)));
  });
  const editPages = () => run("페이지 편집", async () => {
    const [file] = await pick("application/pdf"); if (!file) return;
    const source = await bytes(file.uri); const count = await pageCount(source);
    setEditor({ name: file.name, bytes: source, order: Array.from({ length: count }, (_, index) => index) });
  });
  const imagePdf = () => run("이미지 PDF", async () => {
    const files = await pick("image/*", true); if (!files.length) return;
    const input = await Promise.all(files.map(async (file) => ({ bytes: await bytes(file.uri), mimeType: file.mimeType ?? (file.name.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg") })));
    const output = await imagesToPdf(input);
    await onSaved(await saveGeneratedPdf(output, `이미지_${Date.now()}.pdf`, files.length));
  });
  const extractImages = () => run("PDF 이미지 추출", async () => {
    const [file] = await pick("application/pdf"); if (!file) return;
    const result = await pdfToImages(file.uri); const outputs = result.outputFiles ?? [];
    for (let index = 0; index < outputs.length; index += 1) await onSaved(await importLocalFile({ uri: outputs[index]!, name: `${baseName(file.name)}_${String(index + 1).padStart(3, "0")}.png`, mimeType: "image/png" }));
  });
  const optimize = () => run("PDF 최적화", async () => {
    const [file] = await pick("application/pdf"); if (!file) return;
    const output = await optimizePdf(await bytes(file.uri));
    await onSaved(await saveGeneratedPdf(output, `${baseName(file.name)}_최적화.pdf`, await pageCount(output)));
  });

  const move = (position: number, direction: -1 | 1) => setEditor((current) => {
    if (!current) return current; const target = position + direction; if (target < 0 || target >= current.order.length) return current;
    const order = [...current.order]; [order[position], order[target]] = [order[target]!, order[position]!]; return { ...current, order };
  });
  const saveEdit = () => editor && run("페이지 저장", async () => {
    const output = await reorderAndDeletePdf(editor.bytes, editor.order);
    await onSaved(await saveGeneratedPdf(output, `${baseName(editor.name)}_편집.pdf`, editor.order.length)); setEditor(null);
  });

  if (editor) return <View style={styles.root}><View style={styles.editorHeader}><Pressable onPress={() => setEditor(null)}><Feather name="arrow-left" size={20} /></Pressable><Text style={styles.editorTitle}>페이지 재정렬 · 삭제</Text><Pressable style={styles.saveButton} onPress={saveEdit}><Text style={styles.saveText}>저장</Text></Pressable></View><Text style={styles.editorHelp}>번호는 원본 페이지입니다. 화살표로 순서를 바꾸고 휴지통으로 삭제합니다.</Text><ScrollView contentContainerStyle={styles.pageList}>{editor.order.map((pageIndex, position) => <View key={pageIndex} style={styles.pageRow}><View style={styles.pageNumber}><Text style={styles.pageNumberText}>{pageIndex + 1}</Text></View><Text style={styles.pageLabel}>원본 {pageIndex + 1}페이지</Text><Pressable onPress={() => move(position, -1)}><Feather name="arrow-up" size={18} /></Pressable><Pressable onPress={() => move(position, 1)}><Feather name="arrow-down" size={18} /></Pressable><Pressable onPress={() => setEditor((current) => current ? { ...current, order: current.order.filter((_, index) => index !== position) } : current)}><Feather name="trash-2" size={17} color={colors.danger} /></Pressable></View>)}</ScrollView>{message && <Text style={styles.message}>{message}</Text>}</View>;

  const actions: { title: string; icon: keyof typeof Feather.glyphMap; action: () => void; detail: string }[] = [
    { title: "병합", icon: "git-merge", action: merge, detail: "여러 PDF를 하나로" },
    { title: "분할", icon: "scissors", action: split, detail: "페이지별 PDF 생성" },
    { title: "회전", icon: "rotate-cw", action: rotate, detail: "전체 페이지 90°" },
    { title: "페이지 편집", icon: "layers", action: editPages, detail: "재정렬 · 삭제" },
    { title: "이미지→PDF", icon: "image", action: imagePdf, detail: "여러 이미지를 A4 PDF로" },
    { title: "PDF→이미지", icon: "download", action: extractImages, detail: "페이지별 PNG 추출" },
    { title: "최적화", icon: "minimize", action: optimize, detail: "객체 스트림 재작성" },
  ];

  return <ScrollView style={styles.root} showsVerticalScrollIndicator={false}><ScreenHeader title="도구" /><Text style={styles.section}>PDF</Text><View style={styles.grid}>{actions.map((item) => <Pressable key={item.title} style={styles.card} onPress={item.action} disabled={Boolean(busy)}><View style={styles.icon}><Feather name={item.icon} size={20} color={colors.primary} /></View><Text style={styles.cardTitle}>{item.title}</Text><Text style={styles.cardDetail}>{busy === item.title ? "처리 중..." : item.detail}</Text></Pressable>)}</View>{message && <Text style={styles.message}>{message}</Text>}<View style={styles.note}><Feather name="info" size={16} color={colors.primary} /><Text style={styles.noteText}>최적화는 PDF 객체 구조를 다시 쓰는 단계입니다. 이미지 재샘플링 기반 고압축은 후속 처리로 분리합니다.</Text></View></ScrollView>;
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 20, backgroundColor: colors.background }, section: { marginTop: 16, marginBottom: 10, fontSize: 14, fontWeight: "800", color: colors.text }, grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 12 },
  card: { width: "48.5%", minHeight: 112, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, padding: 14 }, icon: { width: 38, height: 38, borderRadius: 11, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" }, cardTitle: { marginTop: 10, fontSize: 13, fontWeight: "800", color: colors.text }, cardDetail: { marginTop: 4, fontSize: 10, lineHeight: 15, color: colors.textMuted },
  message: { marginTop: 14, textAlign: "center", fontSize: 11, color: colors.textMuted, fontWeight: "700" }, note: { marginTop: 18, padding: 12, borderRadius: 12, backgroundColor: colors.primarySoft, flexDirection: "row", gap: 8 }, noteText: { flex: 1, fontSize: 10, lineHeight: 16, color: colors.textMuted },
  editorHeader: { height: 58, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, editorTitle: { fontSize: 16, fontWeight: "800", color: colors.text }, saveButton: { paddingHorizontal: 14, height: 36, borderRadius: 10, justifyContent: "center", backgroundColor: colors.primary }, saveText: { color: "#FFFFFF", fontSize: 12, fontWeight: "800" }, editorHelp: { fontSize: 11, lineHeight: 17, color: colors.textMuted, marginBottom: 10 }, pageList: { gap: 8, paddingBottom: 30 }, pageRow: { height: 58, paddingHorizontal: 12, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, flexDirection: "row", alignItems: "center", gap: 12 }, pageNumber: { width: 32, height: 32, borderRadius: 9, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" }, pageNumberText: { color: colors.primary, fontWeight: "800" }, pageLabel: { flex: 1, fontSize: 12, fontWeight: "700", color: colors.text },
});
