import { useEffect, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { PdfView } from "@kishannareshpal/expo-pdf";
import { File } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { colors, radius } from "./theme";

export type ViewableDocument = { name: string; uri?: string; mime?: string; type: string };

function isPdf(file: ViewableDocument) { return file.mime === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"); }
function isImage(file: ViewableDocument) { return file.mime?.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/iu.test(file.name); }
function isText(file: ViewableDocument) { return file.mime === "text/plain" || /\.txt$/iu.test(file.name); }

export function DocumentViewerScreen({ file, onBack, onPresent }: { file: ViewableDocument | null; onBack: () => void; onPresent: () => void }) {
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setPage(1); setPageCount(0); setText(""); setError("");
    if (file?.uri && isText(file)) new File(file.uri).text().then(setText).catch((cause) => setError(String(cause)));
  }, [file?.uri]);

  if (!file) return <Unsupported title="선택된 문서가 없습니다" onBack={onBack} />;

  const share = async () => { if (file.uri && await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType: file.mime, dialogTitle: file.name }); };

  return <View style={styles.root}>
    <View style={styles.header}>
      <Pressable onPress={onBack} style={styles.titleRow}><Feather name="arrow-left" size={20} color={colors.text} /><View style={styles.titleBlock}><Text style={styles.title} numberOfLines={1}>{file.name}</Text><Text style={styles.meta}>{pageCount > 0 ? `${page} / ${pageCount}` : file.type}</Text></View></Pressable>
      <View style={styles.headerActions}>{isPdf(file) && <Pressable style={styles.iconButton} onPress={onPresent}><Feather name="maximize-2" size={19} /></Pressable>}<Pressable style={styles.iconButton} onPress={share}><Feather name="share-2" size={19} /></Pressable></View>
    </View>
    <View style={styles.viewer}>
      {!file.uri && <UnsupportedBody message="이 예시 문서는 실제 로컬 파일이 아닙니다." />}
      {file.uri && isPdf(file) && <PdfView style={styles.pdf} uri={file.uri} pageGap={10} doubleTapToZoom autoScale fitMode="width" onLoadComplete={({ pageCount: count }) => setPageCount(count)} onPageChanged={({ pageIndex, pageCount: count }) => { setPage(pageIndex + 1); setPageCount(count); }} onError={({ message }) => setError(message)} />}
      {file.uri && isImage(file) && <ScrollView contentContainerStyle={styles.imageWrap} maximumZoomScale={4} minimumZoomScale={1}><Image source={{ uri: file.uri }} style={styles.image} resizeMode="contain" /></ScrollView>}
      {file.uri && isText(file) && <ScrollView style={styles.textView}><Text selectable style={styles.textContent}>{text}</Text></ScrollView>}
      {file.uri && !isPdf(file) && !isImage(file) && !isText(file) && <UnsupportedBody message="HWP/HWPX 및 Office 고정밀 렌더링은 별도 구현 트랙입니다. 현재 앱에서는 원본 파일을 보관하고 PC로 전송할 수 있습니다." />}
    </View>
    {error && <Text style={styles.error}>{error}</Text>}
  </View>;
}

export function PresentationScreen({ file, onBack }: { file: ViewableDocument | null; onBack: () => void }) {
  const [page, setPage] = useState(1); const [count, setCount] = useState(0);
  if (!file || !file.uri || !isPdf(file)) return <Unsupported title="PDF 발표 모드" message="발표 모드는 현재 PDF 문서에서 사용할 수 있습니다." onBack={onBack} />;
  return <View style={styles.presentationRoot}>
    <View style={styles.presentationHeader}><Pressable onPress={onBack} style={styles.titleRow}><Feather name="x" size={20} color="#FFFFFF" /><Text style={styles.presentationName} numberOfLines={1}>{file.name}</Text></Pressable><Text style={styles.presentationCount}>{page} / {count || "–"}</Text></View>
    <PdfView style={styles.presentationPdf} uri={file.uri} horizontal pagingEnabled doubleTapToZoom fitMode="both" autoScale pageGap={0} onLoadComplete={({ pageCount }) => setCount(pageCount)} onPageChanged={({ pageIndex, pageCount }) => { setPage(pageIndex + 1); setCount(pageCount); }} />
    <Text style={styles.presentationHint}>좌우로 넘겨 슬라이드를 이동합니다 · 더블 탭으로 확대</Text>
  </View>;
}

function Unsupported({ title, message, onBack }: { title: string; message?: string; onBack: () => void }) {
  return <View style={styles.root}><View style={styles.header}><Pressable onPress={onBack} style={styles.titleRow}><Feather name="arrow-left" size={20} /><Text style={styles.title}>{title}</Text></Pressable></View><UnsupportedBody message={message ?? "문서를 다시 선택해 주세요."} /></View>;
}

function UnsupportedBody({ message }: { message: string }) { return <View style={styles.unsupported}><View style={styles.unsupportedIcon}><Feather name="file-text" size={26} color={colors.primary} /></View><Text style={styles.unsupportedTitle}>미리보기 준비 중</Text><Text style={styles.unsupportedText}>{message}</Text></View>; }

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 20, backgroundColor: colors.background },
  header: { height: 60, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 1 },
  titleBlock: { flexShrink: 1 }, title: { fontSize: 14, fontWeight: "800", color: colors.text, maxWidth: 240 }, meta: { marginTop: 3, color: colors.textMuted, fontSize: 11 },
  headerActions: { flexDirection: "row" }, iconButton: { width: 38, height: 38, alignItems: "center", justifyContent: "center" },
  viewer: { flex: 1, borderRadius: radius.md, overflow: "hidden", backgroundColor: colors.surfaceMuted }, pdf: { flex: 1 },
  imageWrap: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 12 }, image: { width: "100%", height: 620 },
  textView: { flex: 1, padding: 20, backgroundColor: colors.surface }, textContent: { fontSize: 14, lineHeight: 22, color: colors.text },
  unsupported: { flex: 1, minHeight: 420, alignItems: "center", justifyContent: "center", paddingHorizontal: 34, backgroundColor: colors.surfaceMuted, borderRadius: radius.md },
  unsupportedIcon: { width: 54, height: 54, borderRadius: 16, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" }, unsupportedTitle: { marginTop: 14, fontWeight: "800", color: colors.text }, unsupportedText: { marginTop: 8, textAlign: "center", color: colors.textMuted, fontSize: 12, lineHeight: 19 },
  error: { color: colors.danger, fontSize: 11, paddingVertical: 8 },
  presentationRoot: { flex: 1, backgroundColor: "#0B1020" }, presentationHeader: { height: 58, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, presentationName: { color: "#FFFFFF", fontSize: 13, fontWeight: "700", maxWidth: 260 }, presentationCount: { color: "#CBD5E1", fontSize: 12 }, presentationPdf: { flex: 1, backgroundColor: "#0B1020" }, presentationHint: { height: 38, textAlign: "center", color: "#94A3B8", fontSize: 10, paddingTop: 10 },
});
