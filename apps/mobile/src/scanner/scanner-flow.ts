import type { EditableScanPage } from "./process-page";

export function imageMimeType(uri: string): "image/png" | "image/jpeg" {
  return uri.toLocaleLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
}

export function scanImageName(index: number, uri: string): string {
  return "scan_" + String(index + 1).padStart(3, "0") + (imageMimeType(uri) === "image/png" ? ".png" : ".jpg");
}

export function reorderPages(pages: readonly EditableScanPage[], index: number, direction: -1 | 1): EditableScanPage[] {
  const target = index + direction;
  if (index < 0 || target < 0 || index >= pages.length || target >= pages.length) return [...pages];
  const next = [...pages];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function removePageAt(pages: readonly EditableScanPage[], index: number): EditableScanPage[] {
  return pages.filter((_, item) => item !== index);
}

export function replacePageAt(pages: readonly EditableScanPage[], index: number, replacement: EditableScanPage): EditableScanPage[] {
  return pages.map((page, item) => item === index ? replacement : page);
}
