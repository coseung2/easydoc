import { degrees, PDFDocument } from "@cantoo/pdf-lib";

const LOAD_OPTIONS = { ignoreEncryption: false } as const;

export async function pageCount(pdfBytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(pdfBytes, LOAD_OPTIONS)).getPageCount();
}

export async function mergePdfs(inputs: Uint8Array[]): Promise<Uint8Array> {
  if (inputs.length < 2) throw new Error("merge_requires_two_pdfs");
  const output = await PDFDocument.create();
  for (const bytes of inputs) {
    const source = await PDFDocument.load(bytes, LOAD_OPTIONS);
    const pages = await output.copyPages(source, source.getPageIndices());
    for (const page of pages) output.addPage(page);
  }
  return output.save({ useObjectStreams: true });
}

export async function splitPdf(input: Uint8Array): Promise<Uint8Array[]> {
  const source = await PDFDocument.load(input, LOAD_OPTIONS);
  const outputs: Uint8Array[] = [];
  for (let index = 0; index < source.getPageCount(); index += 1) {
    const document = await PDFDocument.create();
    const [page] = await document.copyPages(source, [index]);
    if (!page) throw new Error("pdf_page_missing");
    document.addPage(page);
    outputs.push(await document.save({ useObjectStreams: true }));
  }
  return outputs;
}

export async function rotatePdf(input: Uint8Array, rotation: 90 | 180 | 270, pageIndexes?: number[]): Promise<Uint8Array> {
  const document = await PDFDocument.load(input, LOAD_OPTIONS);
  const targets = new Set(pageIndexes ?? document.getPageIndices());
  for (const [index, page] of document.getPages().entries()) {
    if (!targets.has(index)) continue;
    const current = page.getRotation().angle;
    page.setRotation(degrees((current + rotation) % 360));
  }
  return document.save({ useObjectStreams: true });
}

export async function reorderAndDeletePdf(input: Uint8Array, pageOrder: number[]): Promise<Uint8Array> {
  const source = await PDFDocument.load(input, LOAD_OPTIONS);
  if (pageOrder.length === 0) throw new Error("pdf_requires_page");
  const count = source.getPageCount();
  const seen = new Set<number>();
  for (const index of pageOrder) {
    if (!Number.isInteger(index) || index < 0 || index >= count || seen.has(index)) throw new Error("invalid_page_order");
    seen.add(index);
  }
  const output = await PDFDocument.create();
  const pages = await output.copyPages(source, pageOrder);
  for (const page of pages) output.addPage(page);
  return output.save({ useObjectStreams: true });
}

export type ImageInput = { bytes: Uint8Array; mimeType: string };
export async function imagesToPdf(inputs: ImageInput[]): Promise<Uint8Array> {
  if (inputs.length === 0) throw new Error("images_required");
  const document = await PDFDocument.create();
  const pageWidth = 595.28, pageHeight = 841.89, margin = 18;
  for (const input of inputs) {
    const image = input.mimeType.includes("png") ? await document.embedPng(input.bytes) : await document.embedJpg(input.bytes);
    const scale = Math.min((pageWidth - margin * 2) / image.width, (pageHeight - margin * 2) / image.height);
    const width = image.width * scale, height = image.height * scale;
    const page = document.addPage([pageWidth, pageHeight]);
    page.drawImage(image, { x: (pageWidth - width) / 2, y: (pageHeight - height) / 2, width, height });
  }
  return document.save({ useObjectStreams: true });
}

export async function optimizePdf(input: Uint8Array): Promise<Uint8Array> {
  const document = await PDFDocument.load(input, { ...LOAD_OPTIONS, updateMetadata: false });
  return document.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
}
