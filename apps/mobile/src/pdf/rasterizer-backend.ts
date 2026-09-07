import type { PdfPageRasterizer } from "./rasterizer.ts";
import { legacyPdfRasterizer } from "./legacy-rasterizer.ts";

export async function getPdfPageRasterizer(): Promise<PdfPageRasterizer> {
  if (process.env.EXPO_PUBLIC_PDF_RASTERIZER_BACKEND === "page") {
    const { nativePagePdfRasterizer } = await import("./page-rasterizer.ts");
    return nativePagePdfRasterizer;
  }
  return legacyPdfRasterizer;
}
