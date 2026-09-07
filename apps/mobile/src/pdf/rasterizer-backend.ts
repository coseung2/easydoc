import type { PdfPageRasterizer } from "./rasterizer.ts";
import { legacyPdfRasterizer } from "./legacy-rasterizer.ts";

export async function getPdfPageRasterizer(): Promise<PdfPageRasterizer> {
  return legacyPdfRasterizer;
}
