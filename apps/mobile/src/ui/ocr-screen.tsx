import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { Feather } from "@expo/vector-icons";
import type { LocalDocument } from "../documents/store";
import { copyRecognizedText, recognizeDocument, saveRecognizedText } from "../ocr/client";
import { joinRecognizedPages } from "../ocr/text";
import type { ViewableDocument } from "./document-viewer";
import { colors, radius } from "./theme";

export function OcrScreen({ file, onBack, onSaved, onSend }: {
  file?: ViewableDocument | null;
  onBack: () => void;
  onSaved: (document: LocalDocument) => void | Promise<void>;
  onSend?: (document: LocalDocument) => void | Promise<void>;
}) {
  const [source, setSource] = useState<ViewableDocument | null>(file ?? null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [message, setMessage] = useState("");
  const mounted = useRef(true);
  const actionRunning = useRef(false);
  const recognitionAbort = useRef<AbortController | null>(null);
  const saved = useRef<{ text: string; source: string; document: LocalDocument } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; recognitionAbort.current?.abort(); }; }, []);

  const run = async (task: () => Promise<void>) => {
    if (actionRunning.current) return;
    actionRunning.current = true;
    setBusy(true); setMessage("");
    try { await task(); }
    catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : "처리하지 못했습니다. 다시 시도해 주세요."); }
    finally { actionRunning.current = false; recognitionAbort.current = null; if (mounted.current) { setBusy(false); setProgress(""); } }
  };
  const pick = () => run(async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: ["image/*", "application/pdf"], copyToCacheDirectory: true });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    setSource({ name: asset.name, uri: asset.uri, mime: asset.mimeType, type: asset.mimeType === "application/pdf" ? "PDF" : "IMAGE" });
    setText(""); saved.current = null;
  });
  const recognize = () => run(async () => {
    if (!source) return;
    const controller = new AbortController();
    recognitionAbort.current = controller;
    const pages = await recognizeDocument(source, (page, count) => { if (mounted.current) setProgress(`${page} / ${count}페이지 인식 중`); }, controller.signal);
    if (!mounted.current) return;
    const output = joinRecognizedPages(pages);
    setText(output); saved.current = null;
    setMessage(output ? "" : "문자를 찾지 못했습니다. 글자가 선명하게 보이는 사진으로 다시 시도해 주세요.");
  });
  const persist = async () => {
    const sourceName = source?.name ?? "문서";
    if (saved.current?.text === text && saved.current.source === sourceName) return saved.current.document;
    const document = await saveRecognizedText(text, sourceName);
    await onSaved(document);
    saved.current = { text, source: sourceName, document };
    return document;
  };
  return <View style={styles.root}>
    <View style={styles.header}><Pressable onPress={onBack} accessibilityLabel="뒤로" accessibilityRole="button" style={styles.icon}><Feather name="arrow-left" size={22} /></Pressable><Text style={styles.title}>문자 인식</Text></View>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text numberOfLines={2} style={styles.source}>{source?.name ?? "사진 또는 PDF를 선택하세요."}</Text>
      <View style={styles.row}>
        <Pressable disabled={busy} onPress={pick} style={styles.secondary}><Text style={styles.secondaryText}>파일 선택</Text></Pressable>
        <Pressable disabled={busy || !source} onPress={recognize} style={[styles.primary, (busy || !source) && styles.disabled]}><Text style={styles.primaryText}>문자 인식 시작</Text></Pressable>
      </View>
      {busy && <View style={styles.progress}><ActivityIndicator color={colors.primary} /><Text style={{ flex: 1 }}>{progress || "처리 중"}</Text>{recognitionAbort.current && <Pressable style={styles.icon} accessibilityLabel="문자 인식 취소" onPress={() => recognitionAbort.current?.abort()}><Text>취소</Text></Pressable>}</View>}
      <TextInput accessibilityLabel="인식 결과" multiline textAlignVertical="top" value={text} onChangeText={setText} editable={!busy} style={styles.result} placeholder="인식한 글자가 여기에 표시됩니다." placeholderTextColor={colors.textMuted} />
      <View style={styles.row}>
        <Pressable disabled={busy || !text.trim()} style={styles.secondary} onPress={() => run(async () => { await copyRecognizedText(text); setMessage("복사했습니다."); })}><Text style={styles.secondaryText}>복사</Text></Pressable>
        <Pressable disabled={busy || !text.trim()} style={styles.secondary} onPress={() => run(async () => { await persist(); setMessage("문서 목록에 텍스트 파일로 저장했습니다."); })}><Text style={styles.secondaryText}>텍스트 저장</Text></Pressable>
      </View>
      {onSend && <Pressable disabled={busy || !text.trim()} style={[styles.primary, (busy || !text.trim()) && styles.disabled]} onPress={() => run(async () => { await onSend(await persist()); setMessage("전송 목록에 추가했습니다."); })}><Text style={styles.primaryText}>PC로 보내기</Text></Pressable>}
      {!!message && <Text accessibilityRole="alert" style={styles.message}>{message}</Text>}
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 20, backgroundColor: colors.background }, header: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: 6 }, icon: { width: 44, height: 44, justifyContent: "center", alignItems: "center" }, title: { fontSize: 20, fontWeight: "800", color: colors.text },
  content: { gap: 14, paddingBottom: 28 }, source: { color: colors.text, fontSize: 14 }, row: { flexDirection: "row", gap: 10 }, primary: { minHeight: 46, paddingHorizontal: 16, justifyContent: "center", alignItems: "center", borderRadius: radius.md, backgroundColor: colors.primary, flexGrow: 1 }, primaryText: { color: "#FFFFFF", fontWeight: "700" }, secondary: { flex: 1, minHeight: 46, paddingHorizontal: 10, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }, secondaryText: { color: colors.text, fontWeight: "700" }, disabled: { opacity: 0.45 },
  result: { minHeight: 260, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, padding: 14, color: colors.text, fontSize: 15, lineHeight: 23 }, progress: { flexDirection: "row", alignItems: "center", gap: 8 }, message: { color: colors.textMuted, lineHeight: 20 },
});
