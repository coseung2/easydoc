import { BoundedAsyncCache } from "../cache/bounded-cache.ts";

export type RenderPdfPageRequest = {
  uri: string;
  pageIndex: number;
  maxDimension?: number;
  /** Output quality normalized to 0..1. */
  quality?: number;
  /** Stable identity/revision prevent stale images when a file is replaced. */
  documentId?: string;
  revision?: string | number;
};

export interface PdfPageRasterizer {
  getPageCount(uri: string): Promise<number>;
  renderPage(request: RenderPdfPageRequest): Promise<string>;
  release?(uri: string): Promise<void> | void;
}

export type CachedPdfPageRasterizerOptions = {
  maxEntries?: number;
  maxBytes?: number;
};

function pageRequestKey(request: RenderPdfPageRequest): string {
  const documentId = request.documentId ?? request.uri;
  const revision = String(request.revision ?? request.uri);
  // Include every output-affecting option. Undefined means the backend's
  // default, so normalize it to the same explicit value for all callers.
  const maxDimension = request.maxDimension ?? 0;
  const quality = request.quality ?? 0.82;
  return JSON.stringify([documentId, revision, request.uri, request.pageIndex, maxDimension, quality]);
}

function estimatedPageBytes(request: RenderPdfPageRequest): number {
  // We cache file URIs rather than image bytes. This estimate keeps the cache
  // bounded without requiring a native stat call for every render. Thumbnails
  // are much smaller than full-size pages.
  const dimension = request.maxDimension && request.maxDimension > 0 ? request.maxDimension : 1600;
  const quality = Math.max(0.25, Math.min(1, request.quality ?? 0.82));
  return Math.max(64 * 1024, Math.round(dimension * dimension * quality * 0.55));
}

/**
 * Adds shared, bounded page-image caching to any page-oriented rasterizer.
 * Multiple screens can use the returned object and share in-flight renders.
 */
export function createCachedPdfPageRasterizer(
  rasterizer: PdfPageRasterizer,
  options: CachedPdfPageRasterizerOptions = {},
): PdfPageRasterizer & { invalidate(documentId?: string, revision?: string | number): number; clear(): void } {
  const keyInfo = new Map<string, { documentId: string; revision: string }>();
  const uriRevisions = new Map<string, string>();
  const cache = new BoundedAsyncCache<string>({
    maxEntries: options.maxEntries ?? 48,
    maxWeight: options.maxBytes ?? 32 * 1024 * 1024,
    weightOf: (uri) => uri.length,
    onDelete: (_uri, key) => {
      keyInfo.delete(key);
    },
  });

  return {
    getPageCount: (uri) => rasterizer.getPageCount(uri),
    renderPage(request) {
      if (!Number.isInteger(request.pageIndex) || request.pageIndex < 0) throw new Error("invalid_pdf_page_index");
      const key = pageRequestKey(request);
      keyInfo.set(key, { documentId: request.documentId ?? request.uri, revision: String(request.revision ?? request.uri) });
      return cache.getOrLoad(key, async () => {
        try {
          const revision = String(request.revision ?? request.uri);
          if (uriRevisions.get(request.uri) !== undefined && uriRevisions.get(request.uri) !== revision) {
            // A URI can be reused by an importer. Reopen the backend document so
            // its own URI-level conversion/open cache cannot serve stale pixels.
            await rasterizer.release?.(request.uri);
          }
          uriRevisions.set(request.uri, revision);
          return await rasterizer.renderPage(request);
        } catch (error) {
          keyInfo.delete(key);
          throw error;
        }
      }, estimatedPageBytes(request)).then((uri) => {
        // A concurrent invalidation/clear can intentionally skip insertion;
        // do not retain metadata for that uncached result.
        if (cache.get(key) !== uri) keyInfo.delete(key);
        return uri;
      });
    },
    release(uri) {
      uriRevisions.delete(uri);
      return rasterizer.release?.(uri);
    },
    invalidate(documentId, revision) {
      const matches = (key: string) => {
        const info = keyInfo.get(key);
        if (!info) return false;
        return (documentId === undefined || info.documentId === documentId)
          && (revision === undefined || info.revision === String(revision));
      };
      const removed = cache.invalidateWhere(matches);
      for (const key of Array.from(keyInfo.keys())) if (matches(key)) keyInfo.delete(key);
      return removed;
    },
    clear() {
      cache.clear();
      keyInfo.clear();
    },
  };
}

export type FullDocumentPdfConverter = (uri: string) => Promise<{ outputFiles?: string[] | null }>;

export function createFullDocumentPdfRasterizer(convert: FullDocumentPdfConverter): PdfPageRasterizer {
  const cache = new Map<string, Promise<string[]>>();

  const pages = (uri: string) => {
    let pending = cache.get(uri);
    if (!pending) {
      pending = convert(uri).then((result) => result.outputFiles ?? []);
      cache.set(uri, pending);
      pending.catch(() => cache.delete(uri));
    }
    return pending;
  };

  return {
    async getPageCount(uri) {
      return (await pages(uri)).length;
    },
    async renderPage({ uri, pageIndex }) {
      if (!Number.isInteger(pageIndex) || pageIndex < 0) throw new Error("invalid_pdf_page_index");
      const output = await pages(uri);
      const page = output[pageIndex];
      if (!page) throw new Error("pdf_page_missing");
      return page;
    },
    release(uri) {
      cache.delete(uri);
    },
  };
}
