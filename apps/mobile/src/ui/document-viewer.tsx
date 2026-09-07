import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { PdfView } from "@kishannareshpal/expo-pdf";
import { File } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { getPdfPageRasterizer } from "../pdf/rasterizer-backend.ts";
import { colors, radius } from "./theme";
import { recognizeDocument } from "../ocr/client";
import { joinRecognizedPages, searchRecognizedPages, type RecognizedPage } from "../ocr/text";

export type ViewableDocument = { name: string; uri?: string; mime?: string; type: string };

function isPdf(file: ViewableDocument) { return file.mime === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"); }
function isImage(file: ViewableDocument) { return file.mime?.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/iu.test(file.name); }
function isText(file: ViewableDocument) { return file.mime === "text/plain" || /\.txt$/iu.test(file.name); }
function externalMime(file: ViewableDocument): string {
  const name = file.name.toLowerCase();
  if (name.endsWith(".hwp")) return "application/vnd.hancom.hwp";
  if (name.endsWith(".hwpx")) return "application/vnd.hancom.hwpx";
  if (file.mime && file.mime !== "application/octet-stream") return file.mime;
  if (name.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (name.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (name.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  return file.mime ?? "application/octet-stream";
}

function RasterizedThumbnail({ index, active, presentation = false, renderPage, onPress }: { index: number; active: boolean; presentation?: boolean; renderPage: (index: number) => Promise<string>; onPress: () => void }) {
  const [uri, setUri] = useState("");
  useEffect(() => {
    let mounted = true;
    renderPage(index).then((value) => { if (mounted) setUri(value); }).catch(() => {});
    return () => { mounted = false; };
  }, [index, renderPage]);
  const containerStyle = presentation ? [styles.thumbnail, active && styles.thumbnailActive] : [styles.readerThumbnail, active && styles.readerThumbnailActive];
  const imageStyle = presentation ? styles.thumbnailImage : styles.readerThumbnailImage;
  const numberStyle = presentation ? styles.thumbnailNumber : styles.readerThumbnailNumber;
  return <Pressable style={containerStyle} onPress={onPress} disabled={!uri}>{uri ? <Image source={{ uri }} style={imageStyle} resizeMode="cover" /> : <View style={styles.thumbnailLoading}><ActivityIndicator size="small" color={presentation ? "#94A3B8" : colors.primary} /></View>}<Text style={numberStyle}>{index + 1}</Text></Pressable>;
}

export function DocumentViewerScreen({ file, onBack, onPresent, onSend, onOcr }: { file: ViewableDocument | null; onBack: () => void; onPresent: () => void; onSend?: () => void | Promise<void>; onOcr?: () => void }) {
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pageImages, setPageImages] = useState<Record<number, string>>({});
  const [pagePickerOpen, setPagePickerOpen] = useState(false);
  const [pageImagesLoading, setPageImagesLoading] = useState(false);
  const [jumpedPage, setJumpedPage] = useState<number | null>(null);
  const [recognizedPages, setRecognizedPages] = useState<RecognizedPage[]>([]);
  const [recognizing, setRecognizing] = useState(false);
  const [recognitionProgress, setRecognitionProgress] = useState("");
  const recognitionRunning = useRef(false);
  const generation = useRef(0);
  const recognitionAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    setPage(1); setPageCount(0); setText(""); setError(""); setSearchOpen(false); setQuery(""); setPageImages({}); setPagePickerOpen(false); setPageImagesLoading(false); setJumpedPage(null);
    generation.current += 1;
    const current = generation.current;
    setRecognizedPages([]); setRecognizing(false); recognitionRunning.current = false;
    if (file?.uri && isText(file)) new File(file.uri).text().then(setText).catch((cause) => setError(String(cause)));
    return () => { if (generation.current === current) generation.current += 1; recognitionAbort.current?.abort(); };
  }, [file?.uri]);

  const searchCount = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle || !text) return 0;
    return text.toLocaleLowerCase().split(needle).length - 1;
  }, [query, text]);
  const matchingPages = useMemo(() => searchRecognizedPages(recognizedPages, query), [recognizedPages, query]);
  const pageIndexes = useMemo(() => Array.from({ length: pageCount }, (_, index) => index), [pageCount]);
  const renderRasterizedPage = useCallback(async (index: number, maxDimension?: number, quality?: number) => {
    if (!file?.uri || !isPdf(file)) throw new Error("pdf_uri_required");
    const rasterizer = await getPdfPageRasterizer();
    return rasterizer.renderPage({ uri: file.uri, pageIndex: index, maxDimension, quality });
  }, [file?.uri]);
  const renderPageImage = useCallback(async (index: number) => {
    const uri = await renderRasterizedPage(index);
    setPageImages((current) => current[index] ? current : { ...current, [index]: uri });
    return uri;
  }, [renderRasterizedPage]);
  const renderThumbnailImage = useCallback((index: number) => renderRasterizedPage(index, 240, 0.72), [renderRasterizedPage]);

  useEffect(() => {
    const uri = file?.uri;
    if (!uri || !isPdf(file)) return;
    return () => { void getPdfPageRasterizer().then((rasterizer) => rasterizer.release?.(uri)); };
  }, [file?.uri]);

  if (!file) return <Unsupported title="선택된 문서가 없습니다" onBack={onBack} />;

  const share = async () => { if (file.uri && await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType: externalMime(file), dialogTitle: file.name }); };
  const openExternally = async () => {
    if (!file.uri || !await Sharing.isAvailableAsync()) {
      setError("이 기기에서 외부 문서 앱을 열 수 없습니다.");
      return;
    }
    try {
      await Sharing.shareAsync(file.uri, { mimeType: externalMime(file), dialogTitle: `${file.name} 열기` });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const search = async () => {
    if (isText(file)) { setError(""); setSearchOpen((value) => !value); return; }
    if (!isPdf(file) || recognitionRunning.current) return;
    setSearchOpen(true); setError("");
    if (recognizedPages.length) return;
    recognitionRunning.current = true; setRecognizing(true);
    const current = generation.current;
    const controller = new AbortController();
    recognitionAbort.current = controller;
    try {
      const result = await recognizeDocument(file, (page, total) => { if (generation.current === current) setRecognitionProgress(`${page} / ${total}페이지 문자 인식 중`); }, controller.signal);
      if (generation.current !== current) return;
      setRecognizedPages(result); setText(joinRecognizedPages(result));
      if (!result.some(({ text }) => text.trim())) setError("검색할 문자를 찾지 못했습니다.");
    } catch (cause) { if (generation.current === current) setError(cause instanceof Error ? cause.message : "문자를 인식하지 못했습니다."); }
    finally { if (generation.current === current) { setRecognizing(false); recognitionRunning.current = false; } }
  };

  const openPagePicker = async (targetPage?: number) => {
    if (!file.uri || !isPdf(file)) return;
    setError("");
    setPagePickerOpen(true);
    if (pageCount > 0) {
      if (targetPage !== undefined) await jumpToPage(targetPage);
      return;
    }
    if (pageImagesLoading) return;
    setPageImagesLoading(true);
    try {
      const rasterizer = await getPdfPageRasterizer();
      const count = await rasterizer.getPageCount(file.uri);
      setPageCount(count);
      if (targetPage !== undefined && targetPage >= 0 && targetPage < count) await jumpToPage(targetPage);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPagePickerOpen(false);
    } finally {
      setPageImagesLoading(false);
    }
  };

  const jumpToPage = async (index: number) => {
    if (index < 0 || index >= pageCount) return;
    try {
      await renderPageImage(index);
      setJumpedPage(index);
      setPage(index + 1);
      setPagePickerOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return <View style={styles.root}>
    <View style={styles.header}>
      <Pressable onPress={onBack} style={styles.titleRow}><Feather name="arrow-left" size={20} color={colors.text} /><View style={styles.titleBlock}><Text style={styles.title} numberOfLines={1}>{file.name}</Text><Text style={styles.meta}>{pageCount > 0 ? `${page} / ${pageCount}` : file.type}</Text></View></Pressable>
      <View style={styles.headerActions}>
        {(isPdf(file) || isText(file)) && <Pressable accessibilityLabel="문서 검색" style={styles.iconButton} onPress={search}><Feather name="search" size={19} /></Pressable>}
        {onOcr && (isPdf(file) || isImage(file)) && <Pressable accessibilityLabel="문자 인식" style={styles.iconButton} onPress={onOcr}><Feather name="type" size={18} /></Pressable>}
        {isPdf(file) && <Pressable accessibilityLabel="페이지 이동" style={styles.iconButton} onPress={() => openPagePicker()}><Feather name="copy" size={18} /></Pressable>}
        {isPdf(file) && <Pressable style={styles.iconButton} onPress={onPresent}><Feather name="maximize-2" size={19} /></Pressable>}
        {file.uri && onSend && <Pressable style={styles.iconButton} onPress={() => onSend()}><Feather name="send" size={18} color={colors.primary} /></Pressable>}
        <Pressable style={styles.iconButton} onPress={share}><Feather name="share-2" size={19} /></Pressable>
      </View>
    </View>
    {searchOpen && <View style={styles.searchBar}><Feather name="search" size={16} color={colors.textMuted} /><TextInput accessibilityLabel="문서에서 찾기" value={query} onChangeText={setQuery} autoFocus placeholder="문서에서 찾기" placeholderTextColor={colors.textMuted} style={styles.searchInput} /><Text style={styles.searchCount}>{query.trim() ? `${searchCount}개` : ""}</Text><Pressable accessibilityLabel="검색 닫기" style={styles.iconButton} onPress={() => { recognitionAbort.current?.abort(); setSearchOpen(false); setQuery(""); }}><Feather name="x" size={17} color={colors.textMuted} /></Pressable></View>}
    {searchOpen && recognizing && <Text style={styles.searchNotice}>{recognitionProgress}</Text>}
    {searchOpen && isPdf(file) && !recognizing && !!query.trim() && <ScrollView horizontal style={{ maxHeight: 50 }} contentContainerStyle={{ gap: 8, alignItems: "center" }}>{matchingPages.map((result) => <Pressable key={result.page} style={styles.matchPage} onPress={() => openPagePicker(result.page - 1)}><Text style={styles.continuousText}>{result.page}페이지</Text></Pressable>)}{!matchingPages.length && <Text style={styles.searchNotice}>일치하는 페이지가 없습니다.</Text>}</ScrollView>}
    <View style={styles.viewer}>
      {!file.uri && <UnsupportedBody message="이 예시 문서는 실제 로컬 파일이 아닙니다." />}
      {file.uri && isPdf(file) && jumpedPage === null && <PdfView style={styles.pdf} uri={file.uri} pageGap={10} doubleTapToZoom autoScale fitMode="width" onLoadComplete={({ pageCount: count }) => setPageCount(count)} onPageChanged={({ pageIndex, pageCount: count }) => { setPage(pageIndex + 1); setPageCount(count); }} onError={({ message }) => setError(message)} />}
      {file.uri && isPdf(file) && jumpedPage !== null && pageImages[jumpedPage] && <View style={styles.jumpView}><ScrollView contentContainerStyle={styles.jumpImageWrap} maximumZoomScale={4} minimumZoomScale={1}><Image source={{ uri: pageImages[jumpedPage] }} style={styles.jumpImage} resizeMode="contain" /></ScrollView><View style={styles.jumpControls}><Pressable style={styles.jumpButton} disabled={jumpedPage <= 0} onPress={() => jumpToPage(Math.max(0, jumpedPage - 1))}><Feather name="chevron-left" size={18} color={jumpedPage <= 0 ? colors.textMuted : colors.text} /></Pressable><Pressable style={styles.continuousButton} onPress={() => setJumpedPage(null)}><Feather name="list" size={15} color={colors.primary} /><Text style={styles.continuousText}>연속 보기</Text></Pressable><Pressable style={styles.jumpButton} disabled={jumpedPage >= pageCount - 1} onPress={() => jumpToPage(Math.min(pageCount - 1, jumpedPage + 1))}><Feather name="chevron-right" size={18} color={jumpedPage >= pageCount - 1 ? colors.textMuted : colors.text} /></Pressable></View></View>}
      {file.uri && isImage(file) && <ScrollView contentContainerStyle={styles.imageWrap} maximumZoomScale={4} minimumZoomScale={1}><Image source={{ uri: file.uri }} style={styles.image} resizeMode="contain" /></ScrollView>}
      {file.uri && isText(file) && <ScrollView style={styles.textView}><Text selectable style={styles.textContent}>{text}</Text></ScrollView>}
      {file.uri && !isPdf(file) && !isImage(file) && !isText(file) && <UnsupportedBody message="HWP/HWPX 및 Office 문서는 기기 내 미리보기를 지원하지 않습니다. 설치된 한글 또는 문서 앱에서 원본 파일을 열 수 있습니다." actionLabel="외부 앱에서 열기" onAction={openExternally} />}
    </View>
    {pagePickerOpen && isPdf(file) && <View style={styles.pagePicker}><View style={styles.pagePickerHeader}><Text style={styles.pagePickerTitle}>페이지 이동</Text><Pressable onPress={() => setPagePickerOpen(false)}><Feather name="x" size={18} color={colors.textMuted} /></Pressable></View>{pageImagesLoading ? <View style={styles.pagePickerLoading}><ActivityIndicator color={colors.primary} /><Text style={styles.pagePickerLoadingText}>페이지 수 확인 중...</Text></View> : <FlatList horizontal data={pageIndexes} keyExtractor={(index) => String(index)} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.readerThumbnailRow} initialNumToRender={6} maxToRenderPerBatch={6} windowSize={3} getItemLayout={(_, index) => ({ length: 70, offset: 70 * index, index })} renderItem={({ item: index }) => <RasterizedThumbnail index={index} active={page === index + 1} renderPage={renderThumbnailImage} onPress={() => { void jumpToPage(index); }} />} />}</View>}
    {error && <Text style={styles.error}>{error}</Text>}
  </View>;
}

export function PresentationScreen({ file, onBack }: { file: ViewableDocument | null; onBack: () => void }) {
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [pages, setPages] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const pageIndexes = useMemo(() => Array.from({ length: pageCount }, (_, index) => index), [pageCount]);
  const renderRasterizedPage = useCallback(async (index: number, maxDimension?: number, quality?: number) => {
    if (!file?.uri || !isPdf(file)) throw new Error("pdf_uri_required");
    const rasterizer = await getPdfPageRasterizer();
    return rasterizer.renderPage({ uri: file.uri, pageIndex: index, maxDimension, quality });
  }, [file?.uri]);
  const renderPageImage = useCallback(async (index: number) => {
    const uri = await renderRasterizedPage(index);
    setPages((current) => current[index] ? current : { ...current, [index]: uri });
    return uri;
  }, [renderRasterizedPage]);
  const renderThumbnailImage = useCallback((index: number) => renderRasterizedPage(index, 220, 0.7), [renderRasterizedPage]);

  useEffect(() => {
    setPage(1); setPageCount(0); setPages({}); setError("");
    if (!file?.uri || !isPdf(file)) return;
    let mounted = true;
    setLoading(true);
    getPdfPageRasterizer().then((rasterizer) => rasterizer.getPageCount(file.uri!)).then((count) => { if (mounted) setPageCount(count); }).catch((cause) => { if (mounted) { setError(cause instanceof Error ? cause.message : String(cause)); setLoading(false); } });
    return () => {
      mounted = false;
      void getPdfPageRasterizer().then((rasterizer) => rasterizer.release?.(file.uri!));
    };
  }, [file?.uri]);

  useEffect(() => {
    if (!file?.uri || !isPdf(file) || pageCount <= 0) return;
    let mounted = true;
    const currentIndex = page - 1;
    setLoading(true);
    renderPageImage(currentIndex).then(() => { if (mounted) setLoading(false); }).catch((cause) => { if (mounted) { setError(cause instanceof Error ? cause.message : String(cause)); setLoading(false); } });
    const prefetch = [currentIndex - 1, currentIndex + 1, currentIndex + 2].filter((index) => index >= 0 && index < pageCount);
    void Promise.allSettled(prefetch.map((index) => renderPageImage(index)));
    return () => { mounted = false; };
  }, [file?.uri, page, pageCount, renderPageImage]);

  if (!file || !file.uri || !isPdf(file)) return <Unsupported title="PDF 발표 모드" message="발표 모드는 현재 PDF 문서에서 사용할 수 있습니다." onBack={onBack} />;

  const count = pageCount;
  const previous = () => setPage((value) => Math.max(1, value - 1));
  const next = () => setPage((value) => Math.min(count || 1, value + 1));
  const share = async () => { if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri!, { mimeType: file.mime, dialogTitle: file.name }); };

  return <View style={styles.presentationRoot}>
    <View style={styles.presentationHeader}><Pressable onPress={onBack} style={styles.titleRow}><Feather name="x" size={20} color="#FFFFFF" /><Text style={styles.presentationName} numberOfLines={1}>{file.name}</Text></Pressable><View style={styles.presentationHeaderRight}><Text style={styles.presentationCount}>{page} / {count || "–"}</Text><Pressable onPress={share}><Feather name="share-2" size={18} color="#FFFFFF" /></Pressable></View></View>
    <View style={styles.presentationStage}>
      {loading && <View style={styles.loading}><ActivityIndicator color="#FFFFFF" /><Text style={styles.loadingText}>페이지 준비 중...</Text></View>}
      {!loading && pages[page - 1] && <Image source={{ uri: pages[page - 1] }} style={styles.presentationImage} resizeMode="contain" />}
      {!loading && !pages[page - 1] && <Text style={styles.loadingText}>{error || "페이지를 렌더링하지 못했습니다."}</Text>}
      {count > 1 && <><Pressable style={[styles.pageArrow, styles.pageArrowLeft]} onPress={previous} disabled={page <= 1}><Feather name="chevron-left" size={30} color={page <= 1 ? "#475569" : "#FFFFFF"} /></Pressable><Pressable style={[styles.pageArrow, styles.pageArrowRight]} onPress={next} disabled={page >= count}><Feather name="chevron-right" size={30} color={page >= count ? "#475569" : "#FFFFFF"} /></Pressable></>}
    </View>
    <FlatList horizontal data={pageIndexes} keyExtractor={(index) => String(index)} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbnailRow} initialNumToRender={5} maxToRenderPerBatch={5} windowSize={3} getItemLayout={(_, index) => ({ length: 84, offset: 84 * index, index })} renderItem={({ item: index }) => <RasterizedThumbnail index={index} active={page === index + 1} presentation renderPage={renderThumbnailImage} onPress={() => setPage(index + 1)} />} />
    <Text style={styles.presentationHint}>좌우 버튼 또는 썸네일로 페이지 이동</Text>
  </View>;
}

function Unsupported({ title, message, onBack }: { title: string; message?: string; onBack: () => void }) {
  return <View style={styles.root}><View style={styles.header}><Pressable onPress={onBack} style={styles.titleRow}><Feather name="arrow-left" size={20} /><Text style={styles.title}>{title}</Text></Pressable></View><UnsupportedBody message={message ?? "문서를 다시 선택해 주세요."} /></View>;
}

function UnsupportedBody({ message, actionLabel, onAction }: { message: string; actionLabel?: string; onAction?: () => void | Promise<void> }) { return <View style={styles.unsupported}><View style={styles.unsupportedIcon}><Feather name="file-text" size={26} color={colors.primary} /></View><Text style={styles.unsupportedTitle}>미리보기 준비 중</Text><Text style={styles.unsupportedText}>{message}</Text>{actionLabel && onAction && <Pressable style={styles.externalButton} onPress={onAction}><Feather name="external-link" size={15} color="#FFFFFF" /><Text style={styles.externalButtonText}>{actionLabel}</Text></Pressable>}</View>; }

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 20, backgroundColor: colors.background },
  header: { minHeight: 60, justifyContent: "center", gap: 4, paddingVertical: 6 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 1 },
  titleBlock: { flexShrink: 1 }, title: { fontSize: 14, fontWeight: "800", color: colors.text, maxWidth: 220 }, meta: { marginTop: 3, color: colors.textMuted, fontSize: 11 },
  headerActions: { flexDirection: "row", justifyContent: "flex-end" }, iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  searchNotice: { fontSize: 12, paddingVertical: 8, color: colors.textMuted }, matchPage: { minHeight: 44, paddingHorizontal: 12, justifyContent: "center", borderRadius: 10, backgroundColor: colors.primarySoft },
  searchBar: { height: 44, marginBottom: 8, paddingHorizontal: 12, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, flexDirection: "row", alignItems: "center", gap: 8 },
  searchInput: { flex: 1, fontSize: 12, color: colors.text, paddingVertical: 0 }, searchCount: { fontSize: 10, color: colors.textMuted, fontWeight: "700" },
  viewer: { flex: 1, borderRadius: radius.md, overflow: "hidden", backgroundColor: colors.surfaceMuted }, pdf: { flex: 1 },
  jumpView: { flex: 1 }, jumpImageWrap: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 12 }, jumpImage: { width: "100%", height: 560 }, jumpControls: { height: 48, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 18 }, jumpButton: { width: 40, height: 36, alignItems: "center", justifyContent: "center" }, continuousButton: { height: 34, paddingHorizontal: 12, borderRadius: 10, backgroundColor: colors.primarySoft, flexDirection: "row", alignItems: "center", gap: 6 }, continuousText: { fontSize: 11, fontWeight: "800", color: colors.primary },
  pagePicker: { marginTop: 8, paddingVertical: 8, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }, pagePickerHeader: { paddingHorizontal: 10, paddingBottom: 7, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, pagePickerTitle: { fontSize: 11, fontWeight: "800", color: colors.text }, pagePickerLoading: { height: 72, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8 }, pagePickerLoadingText: { fontSize: 10, color: colors.textMuted }, readerThumbnailRow: { gap: 8, paddingHorizontal: 8 }, readerThumbnail: { width: 62, height: 82, borderRadius: 7, overflow: "hidden", borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceMuted }, readerThumbnailActive: { borderWidth: 2, borderColor: colors.primary }, readerThumbnailImage: { width: "100%", height: "100%" }, readerThumbnailNumber: { position: "absolute", right: 3, bottom: 3, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: "rgba(15,23,42,0.75)", color: "#FFFFFF", fontSize: 9, lineHeight: 16, textAlign: "center" },
  imageWrap: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 12 }, image: { width: "100%", height: 620 },
  textView: { flex: 1, padding: 20, backgroundColor: colors.surface }, textContent: { fontSize: 14, lineHeight: 22, color: colors.text },
  unsupported: { flex: 1, minHeight: 420, alignItems: "center", justifyContent: "center", paddingHorizontal: 34, backgroundColor: colors.surfaceMuted, borderRadius: radius.md },
  unsupportedIcon: { width: 54, height: 54, borderRadius: 16, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" }, unsupportedTitle: { marginTop: 14, fontWeight: "800", color: colors.text }, unsupportedText: { marginTop: 8, textAlign: "center", color: colors.textMuted, fontSize: 12, lineHeight: 19 },
  externalButton: { marginTop: 18, minHeight: 40, paddingHorizontal: 14, borderRadius: 10, backgroundColor: colors.primary, flexDirection: "row", alignItems: "center", gap: 7 }, externalButtonText: { color: "#FFFFFF", fontSize: 12, fontWeight: "800" },
  error: { color: colors.danger, fontSize: 11, paddingVertical: 8 },
  presentationRoot: { flex: 1, backgroundColor: "#0B1020" }, presentationHeader: { height: 58, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, presentationName: { color: "#FFFFFF", fontSize: 13, fontWeight: "700", maxWidth: 235 }, presentationHeaderRight: { flexDirection: "row", alignItems: "center", gap: 14 }, presentationCount: { color: "#CBD5E1", fontSize: 12 },
  presentationStage: { flex: 1, marginHorizontal: 12, borderRadius: 10, overflow: "hidden", backgroundColor: "#111827", alignItems: "center", justifyContent: "center" }, presentationImage: { width: "100%", height: "100%" }, loading: { alignItems: "center", gap: 10 }, loadingText: { color: "#94A3B8", fontSize: 11 },
  pageArrow: { position: "absolute", top: "45%", width: 48, height: 64, borderRadius: 12, backgroundColor: "rgba(15,23,42,0.68)", alignItems: "center", justifyContent: "center" }, pageArrowLeft: { left: 10 }, pageArrowRight: { right: 10 },
  thumbnailRow: { minHeight: 76, alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8 }, thumbnail: { width: 76, height: 54, borderRadius: 7, overflow: "hidden", borderWidth: 1, borderColor: "#334155", backgroundColor: "#1E293B" }, thumbnailActive: { borderWidth: 2, borderColor: "#60A5FA" }, thumbnailImage: { width: "100%", height: "100%" }, thumbnailLoading: { flex: 1, alignItems: "center", justifyContent: "center" }, thumbnailNumber: { position: "absolute", right: 3, bottom: 2, minWidth: 16, height: 16, borderRadius: 8, textAlign: "center", color: "#FFFFFF", fontSize: 9, lineHeight: 16, backgroundColor: "rgba(15,23,42,0.75)" },
  presentationHint: { height: 30, textAlign: "center", color: "#94A3B8", fontSize: 10, paddingTop: 5 },
});
