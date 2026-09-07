import { PdfPageImage } from "@dariyd/react-native-pdf-page-image";
import type { PdfPageRasterizer } from "./rasterizer.ts";

const openDocuments = new Map<string, Promise<number>>();

async function ensureOpen(uri: string): Promise<number> {
  let pending = openDocuments.get(uri);
  if (!pending) {
    pending = PdfPageImage.open(uri).then((info) => info.pageCount);
    openDocuments.set(uri, pending);
    pending.catch(() => openDocuments.delete(uri));
  }
  return pending;
}

export const nativePagePdfRasterizer: PdfPageRasterizer = {
  getPageCount(uri) {
    return ensureOpen(uri);
  },
  async renderPage({ uri, pageIndex, maxDimension, quality }) {
    const count = await ensureOpen(uri);
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= count) throw new Error("invalid_pdf_page_index");
    const image = await PdfPageImage.generate(uri, pageIndex, 1, {
      format: "jpeg",
      quality: Math.round(Math.max(1, Math.min(100, (quality ?? 0.82) * 100))),
      maxDimension: maxDimension ?? 0,
    });
    return image.uri;
  },
  async release(uri) {
    openDocuments.delete(uri);
    await PdfPageImage.close(uri);
  },
};
