import { convert as pdfToImages } from "react-native-pdf-to-image";
import { createFullDocumentPdfRasterizer } from "./rasterizer.ts";

export const legacyPdfRasterizer = createFullDocumentPdfRasterizer(pdfToImages);
