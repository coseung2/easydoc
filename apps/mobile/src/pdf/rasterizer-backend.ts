import type { PdfPageRasterizer } from "./rasterizer.ts";
import { createCachedPdfPageRasterizer } from "./rasterizer.ts";
import { legacyPdfRasterizer } from "./legacy-rasterizer.ts";

export type CachedPdfPageRasterizer = PdfPageRasterizer & { invalidate(documentId?: string, revision?: string | number): number; clear(): void };

let rasterizerPromise: Promise<CachedPdfPageRasterizer> | null = null;

export async function getPdfPageRasterizer(): Promise<CachedPdfPageRasterizer> {
  rasterizerPromise ??= (async () => {
    const backend = process.env.EXPO_PUBLIC_PDF_RASTERIZER_BACKEND === "page"
      ? (await import("./page-rasterizer.ts")).nativePagePdfRasterizer
      : legacyPdfRasterizer;
    return createCachedPdfPageRasterizer(backend);
  })();
  return rasterizerPromise;
}

/** Drop cached pages for a replaced document while retaining other documents. */
export async function invalidatePdfPageCache(documentId?: string, revision?: string | number): Promise<number> {
  return (await getPdfPageRasterizer()).invalidate(documentId, revision);
}

/** Primarily useful after logout or when reclaiming all temporary page files. */
export async function clearPdfPageCache(): Promise<void> {
  (await getPdfPageRasterizer()).clear();
}
