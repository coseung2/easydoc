import { BoundedAsyncCache } from "../cache/bounded-cache.ts";
import type { RecognizedPage } from "./text.ts";

export type OcrDocument = {
  uri?: string;
  name: string;
  mime?: string;
  id?: string;
  localId?: string;
  revision?: string | number;
  size?: number;
  updatedAt?: string | number;
};

/** Stable identity and revision used by both viewer and OCR screens. */
export function documentIdentity(file: OcrDocument): string {
  return file.localId ?? file.id ?? file.uri ?? file.name;
}

export function documentRevision(file: OcrDocument): string {
  if (file.revision !== undefined) return String(file.revision);
  // URI is a useful fallback for imported immutable files. Callers that can
  // observe file updates should pass revision explicitly.
  if (file.updatedAt !== undefined || file.size !== undefined) return `${file.updatedAt ?? ""}:${file.size ?? ""}`;
  return file.uri ?? file.name;
}

export function ocrCacheKey(file: OcrDocument, language = "default"): string {
  return JSON.stringify([documentIdentity(file), documentRevision(file), language]);
}

const resultCache = new BoundedAsyncCache<RecognizedPage[]>({
  maxEntries: 12,
  maxWeight: 8 * 1024 * 1024,
  weightOf: (pages) => Math.max(1, pages.reduce((sum, page) => sum + page.text.length * 2 + 16, 0)),
});

const searchStateCache = new BoundedAsyncCache<string>({
  maxEntries: 24,
  maxWeight: 64 * 1024,
  weightOf: (query) => query.length * 2 + 1,
});

function clonePages(pages: readonly RecognizedPage[]): RecognizedPage[] {
  return pages.map(({ page, text }) => ({ page, text }));
}

export function getCachedRecognizedPages(file: OcrDocument, language = "default"): RecognizedPage[] | undefined {
  const pages = resultCache.get(ocrCacheKey(file, language));
  return pages ? clonePages(pages) : undefined;
}

export function cacheRecognizedPages(file: OcrDocument, pages: readonly RecognizedPage[], language = "default"): void {
  resultCache.set(ocrCacheKey(file, language), clonePages(pages));
}

export function getOrLoadRecognizedPages(
  file: OcrDocument,
  loader: () => Promise<RecognizedPage[]>,
  language = "default",
): Promise<RecognizedPage[]> {
  return resultCache.getOrLoad(ocrCacheKey(file, language), async () => clonePages(await loader())).then(clonePages);
}

export function getCachedOcrSearchQuery(file: OcrDocument, language = "default"): string {
  return searchStateCache.get(ocrCacheKey(file, language)) ?? "";
}

export function cacheOcrSearchQuery(file: OcrDocument, query: string, language = "default"): void {
  const key = ocrCacheKey(file, language);
  if (!query) {
    searchStateCache.remove(key);
    return;
  }
  searchStateCache.set(key, query);
}

/** Test/reset hook and a useful escape hatch when a local document is deleted. */
export function invalidateOcrCache(file?: OcrDocument, revision?: string | number): number {
  if (!file) {
    const before = resultCache.size;
    resultCache.clear();
    searchStateCache.clear();
    return before;
  }
  const identity = documentIdentity(file);
  const expectedRevision = revision === undefined ? documentRevision(file) : String(revision);
  const matches = (key: string) => {
    try {
      const [keyIdentity, keyRevision] = JSON.parse(key) as [string, string, string];
      return keyIdentity === identity && keyRevision === expectedRevision;
    } catch {
      return false;
    }
  };
  return resultCache.invalidateWhere(matches) + searchStateCache.invalidateWhere(matches);
}
