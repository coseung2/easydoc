import { useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { convert as pdfToImages } from "react-native-pdf-to-image";
import { imagesToPdf, mergePdfs, optimizePdf, pageCount, reorderAndDeletePdf, rotatePdf, splitPdf } from "@easydoc/pdf-tools";
import { importLocalFile, saveGeneratedPdf, type LocalDocument } from "../documents/store.ts";
import { discardRenderedPages } from "../documents/rendered-pages";
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

export function PdfToolsScreen({ onSaved, onOcr }: { onSaved: (document: LocalDocument) => void | Promise<void>; onOcr?: () => void }) {
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const running = useRef(false);

  const run = async (label: string, task: () => Promise<void | false>) => {
    if (running.current) return;
    running.current = true;
    setBusy(label); setMessage("");
    try { if (await task() !== false) setMessage(`${label} 완료`); }
    catch (error) { const detail = error instanceof Error ? error.message : String(error); setMessage(/encrypt|password|암호/iu.test(detail) ? "암호화된 PDF는 현재 도구에서 처리할 수 없습니다. 암호를 해제한 PDF로 다시 시도해 주세요." : detail || `${label} 처리에 실패했습니다.`); }
    finally { running.current = false; setBusy(""); }
  };

  const merge = () => run("PDF 병합", async () => {
    const files = await pick("application/pdf", true); if (!files.length) return false;
    if (files.length < 2) throw new Error("병합할 PDF를 두 개 이상 선택해 주세요.");
    const output = await mergePdfs(await Promise.all(files.map((file) => bytes(file.uri))));
    await onSaved(await saveGeneratedPdf(output, `병합_${Date.now()}.pdf`, await pageCount(output)));
  });
  const split = () => run("PDF 분할", async () => {
    const [file] = await pick("application/pdf"); if (!file) return false;
    const parts = await splitPdf(await bytes(file.uri));
    let savedCount = 0;
    try {
      for (let index = 0; index < parts.length; index += 1) {
        const document = await saveGeneratedPdf(parts[index]!, `${baseName(file.name)}_${String(index + 1).padStart(3, "0")}.pdf`, 1);
        savedCount += 1;
        await onSaved(document);
      }
    } catch (error) { throw new Error(`${parts.length}개 중 ${savedCount}개가 저장되었습니다. 나머지 저장에 실패했습니다. ${error instanceof Error ? error.message : ""}`); }
  });
  const rotate = () => run("페이지 회전", async () => {
    const [file] = await pick("application/pdf"); if (!file) return false;
    const output = await rotatePdf(await bytes(file.uri), 90);
    await onSaved(await saveGeneratedPdf(output, `${baseName(file.name)}_회전.pdf`, await pageCount(output)));
  });
  const editPages = () => run("페이지 편집", async () => {
    const [file] = await pick("application/pdf"); if (!file) return false;
    const source = await bytes(file.uri); const count = await pageCount(source);
    setEditor({ name: file.name, bytes: source, order: Array.from({ length: count }, (_, index) => index) });
    return false;
  });
  const imagePdf = () => run("이미지 PDF", async () => {
    const files = await pick("image/*", true); if (!files.length) return false;
    const input = [];
    for (const file of files) {
      const image = await manipulateAsync(file.uri, [], { format: SaveFormat.JPEG, compress: 0.95 });
      try { input.push({ bytes: await bytes(image.uri), mimeType: "image/jpeg" }); }
      finally { discardRenderedPages([image.uri]); }
    }
    const output = await imagesToPdf(input);
    await onSaved(await saveGeneratedPdf(output, `이미지_${Date.now()}.pdf`, files.length));
  });
  const extractImages = () => run("PDF 이미지 추출", async () => {
    const [file] = await pick("application/pdf"); if (!file) return false;
    const result = await pdfToImages(file.uri); const outputs = result.outputFiles ?? [];
    if (!outputs.length) throw new Error("추출할 페이지가 없습니다.");
    let savedCount = 0;
    try {
      for (let index = 0; index < outputs.length; index += 1) {
        const document = await importLocalFile({ uri: new File(outputs[index]!).uri, name: `${baseName(file.name)}_${String(index + 1).padStart(3, "0")}.png`, mimeType: "image/png" });
        savedCount += 1;
        await onSaved(document);
      }
    } catch (error) { throw new Error(`${outputs.length}개 중 ${savedCount}개가 저장되었습니다. 나머지 저장에 실패했습니다. ${error instanceof Error ? error.message : ""}`); }
    finally { discardRenderedPages(outputs.map((uri) => new File(uri).uri)); }
  });
  const optimize = () => run("PDF 최적화", async () => {
    const [file] = await pick("application/pdf"); if (!file) return false;
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

  if (editor) return <View style={styles.root}>
    <View style={styles.editorHeader}>
      <Pressable disabled={Boolean(busy)} style={styles.touch} accessibilityLabel="편집 닫기" onPress={() => setEditor(null)}><Feather name="arrow-left" size={20} /></Pressable>
      <Text style={styles.editorTitle}>페이지 편집</Text>
      <Pressable disabled={Boolean(busy) || editor.order.length === 0} style={styles.saveButton} onPress={saveEdit}><Text style={styles.saveText}>{busy ? "저장 중" : "저장"}</Text></Pressable>
    </View>
    <ScrollView contentContainerStyle={styles.pageList}>{editor.order.map((pageIndex, position) => <View key={pageIndex} style={styles.pageRow}>
      <Text style={styles.pageLabel}>원본 {pageIndex + 1}페이지</Text>
      <Pressable disabled={Boolean(busy) || position === 0} style={styles.touch} accessibilityLabel={`${pageIndex + 1}페이지 앞으로`} onPress={() => move(position, -1)}><Feather name="arrow-up" size={18} /></Pressable>
      <Pressable disabled={Boolean(busy) || position === editor.order.length - 1} style={styles.touch} accessibilityLabel={`${pageIndex + 1}페이지 뒤로`} onPress={() => move(position, 1)}><Feather name="arrow-down" size={18} /></Pressable>
      <Pressable disabled={Boolean(busy) || editor.order.length <= 1} style={styles.touch} accessibilityLabel={`${pageIndex + 1}페이지 삭제`} onPress={() => setEditor((current) => current ? { ...current, order: current.order.filter((_, index) => index !== position) } : current)}><Feather name="trash-2" size={17} color={colors.danger} /></Pressable>
    </View>)}</ScrollView>{!!message && <Text style={styles.message}>{message}</Text>}
  </View>;

  const actions: { title: string; icon: keyof typeof Feather.glyphMap; action: () => void; detail: string }[] = [
    { title: "병합", icon: "git-merge", action: merge, detail: "여러 PDF를 하나로" },
    { title: "분할", icon: "scissors", action: split, detail: "페이지별 PDF 생성" },
    { title: "회전", icon: "rotate-cw", action: rotate, detail: "전체 페이지 90°" },
    { title: "페이지 편집", icon: "layers", action: editPages, detail: "재정렬 · 삭제" },
    { title: "이미지→PDF", icon: "image", action: imagePdf, detail: "여러 이미지를 A4 PDF로" },
    { title: "PDF→이미지", icon: "download", action: extractImages, detail: "페이지별 PNG 추출" },
    { title: "최적화", icon: "minimize", action: optimize, detail: "파일 구조 정리" },
  ];

  return <ScrollView style={styles.root} contentContainerStyle={{ paddingBottom: 28 }} showsVerticalScrollIndicator={false}>
    <ScreenHeader title="도구" /><Text style={styles.section}>PDF</Text>
    <View style={styles.grid}>{actions.map((item) => <Pressable key={item.title} accessibilityRole="button" style={styles.card} onPress={item.action} disabled={Boolean(busy)}><View style={styles.icon}><Feather name={item.icon} size={20} color={colors.primary} /></View><Text style={styles.cardTitle}>{item.title}</Text><Text style={styles.cardDetail}>{item.detail}</Text></Pressable>)}</View>
    {onOcr && <Pressable disabled={Boolean(busy)} style={[styles.card, { width: "100%", marginTop: 14 }]} onPress={onOcr}><Text style={styles.cardTitle}>문자 인식 (OCR)</Text><Text style={styles.cardDetail}>사진·PDF에서 글자 추출</Text></Pressable>}
    {!!busy && <Text style={styles.message}>{busy} 처리 중…</Text>}
    {!!message && <Text accessibilityRole="alert" style={styles.message}>{message}</Text>}
    <View style={styles.note}><Feather name="info" size={16} color={colors.primary} /><Text style={styles.noteText}>최적화 결과의 용량은 원본보다 작아지지 않을 수 있습니다.</Text></View>
  </ScrollView>;
}

const styles = StyleSheet.create({
  touch: { width: 44, height: 44, justifyContent: "center", alignItems: "center" },
  root: { flex: 1, paddingHorizontal: 20, backgroundColor: colors.background }, section: { marginTop: 16, marginBottom: 10, fontSize: 14, fontWeight: "800", color: colors.text }, grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 12 },
  card: { width: "48.5%", minHeight: 112, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, padding: 14 }, icon: { width: 38, height: 38, borderRadius: 11, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" }, cardTitle: { marginTop: 10, fontSize: 13, fontWeight: "800", color: colors.text }, cardDetail: { marginTop: 4, fontSize: 10, lineHeight: 15, color: colors.textMuted },
  message: { marginTop: 14, textAlign: "center", fontSize: 11, color: colors.textMuted, fontWeight: "700" }, note: { marginTop: 18, padding: 12, borderRadius: 12, backgroundColor: colors.primarySoft, flexDirection: "row", gap: 8 }, noteText: { flex: 1, fontSize: 10, lineHeight: 16, color: colors.textMuted },
  editorHeader: { height: 58, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, editorTitle: { fontSize: 16, fontWeight: "800", color: colors.text }, saveButton: { paddingHorizontal: 14, height: 36, borderRadius: 10, justifyContent: "center", backgroundColor: colors.primary }, saveText: { color: "#FFFFFF", fontSize: 12, fontWeight: "800" }, editorHelp: { fontSize: 11, lineHeight: 17, color: colors.textMuted, marginBottom: 10 }, pageList: { gap: 8, paddingBottom: 30 }, pageRow: { height: 58, paddingHorizontal: 12, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, flexDirection: "row", alignItems: "center", gap: 12 }, pageNumber: { width: 32, height: 32, borderRadius: 9, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" }, pageNumberText: { color: colors.primary, fontWeight: "800" }, pageLabel: { flex: 1, fontSize: 12, fontWeight: "700", color: colors.text },
});
