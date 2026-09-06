import { requireNativeModule } from "expo-modules-core";
import { File, Directory, Paths } from "expo-file-system";
import { convert } from "react-native-pdf-to-image";
import { importLocalFile } from "../documents/store";
import type { RecognizedPage } from "./text";
import { discardRenderedPages } from "../documents/rendered-pages";

type OcrModule = { recognize(uri: string): Promise<string>; copyText(text: string): Promise<void> };
const native = () => requireNativeModule<OcrModule>("EasyDocOcr");

export async function recognizeDocument(
  file: { uri?: string; name: string; mime?: string },
  onProgress?: (page: number, total: number) => void,
  signal?: AbortSignal,
): Promise<RecognizedPage[]> {
  if (!file.uri) throw new Error("인식할 파일을 선택해 주세요.");
  const pdf = file.mime === "application/pdf" || /\.pdf$/iu.test(file.name);
  const checkCancelled = () => { if (signal?.aborted) throw new Error("문자 인식을 취소했습니다."); };
  checkCancelled();
  const images = pdf ? (await convert(file.uri)).outputFiles ?? [] : [file.uri];
  try {
    if (!images.length) throw new Error("문서에서 페이지를 읽을 수 없습니다.");
    const pages: RecognizedPage[] = [];
    for (let index = 0; index < images.length; index += 1) {
      checkCancelled();
      onProgress?.(index + 1, images.length);
      pages.push({ page: index + 1, text: await native().recognize(new File(images[index]!).uri) });
    }
    checkCancelled();
    return pages;
  } finally {
    if (pdf) discardRenderedPages(images);
  }
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
