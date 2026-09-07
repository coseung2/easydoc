import { requireNativeModule } from "expo-modules-core";
import { File, Directory, Paths } from "expo-file-system";
import { importLocalFile } from "../documents/store";
import type { RecognizedPage } from "./text";
import { getPdfPageRasterizer } from "../pdf/rasterizer-backend.ts";
import { documentIdentity, documentRevision, getCachedRecognizedPages, getOrLoadRecognizedPages, type OcrDocument } from "./cache.ts";

type OcrModule = { recognize(uri: string): Promise<string>; copyText(text: string): Promise<void> };
const native = () => requireNativeModule<OcrModule>("EasyDocOcr");

export async function recognizeDocument(
  file: OcrDocument,
  onProgress?: (page: number, total: number) => void,
  signal?: AbortSignal,
  language = "default",
): Promise<RecognizedPage[]> {
  if (!file.uri) throw new Error("인식할 파일을 선택해 주세요.");
  const pdf = file.mime === "application/pdf" || /\.pdf$/iu.test(file.name);
  const checkCancelled = () => { if (signal?.aborted) throw new Error("문자 인식을 취소했습니다."); };
  checkCancelled();
  const cached = getCachedRecognizedPages(file, language);
  if (cached) {
    onProgress?.(cached.length, cached.length);
    return cached;
  }

  return getOrLoadRecognizedPages(file, async () => {
    const rasterizer = pdf ? await getPdfPageRasterizer() : null;
    const total = pdf ? await rasterizer!.getPageCount(file.uri!) : 1;
    if (total <= 0) throw new Error("문서에서 페이지를 읽을 수 없습니다.");
    const pages: RecognizedPage[] = [];
    for (let index = 0; index < total; index += 1) {
      checkCancelled();
      onProgress?.(index + 1, total);
      const imageUri = pdf
        ? await rasterizer!.renderPage({
          uri: file.uri!,
          pageIndex: index,
          // OCR needs the full page; this resolution is intentionally distinct
          // from thumbnails so both can remain useful in the shared cache.
          quality: 1,
          documentId: documentIdentity(file),
          revision: documentRevision(file),
        })
        : file.uri!;
      pages.push({ page: index + 1, text: await native().recognize(new File(imageUri).uri) });
    }
    checkCancelled();
    return pages;
  }, language);
}

export async function copyRecognizedText(text: string): Promise<void> {
  await native().copyText(text);
}

export async function saveRecognizedText(text: string, sourceName: string) {
  if (!text.trim()) throw new Error("저장할 문자가 없습니다.");
  const directory = new Directory(Paths.cache, "EasyDoc", "ocr");
  directory.create({ intermediates: true, idempotent: true });
  const temporary = new File(directory, `${crypto.randomUUID()}.txt`);
  temporary.create();
  temporary.write(text);
  try {
    return await importLocalFile({ uri: temporary.uri, name: `${sourceName.replace(/\.[^.]+$/u, "")}_문자인식.txt`, mimeType: "text/plain" });
  } finally {
    if (temporary.exists) temporary.delete();
  }
}
