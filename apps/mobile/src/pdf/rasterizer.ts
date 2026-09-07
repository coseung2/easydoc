export type RenderPdfPageRequest = {
  uri: string;
  pageIndex: number;
  maxDimension?: number;
  /** Output quality normalized to 0..1. */
  quality?: number;
};

export interface PdfPageRasterizer {
  getPageCount(uri: string): Promise<number>;
  renderPage(request: RenderPdfPageRequest): Promise<string>;
  release?(uri: string): Promise<void> | void;
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
