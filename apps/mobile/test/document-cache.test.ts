import assert from "node:assert/strict";
import test from "node:test";
import { BoundedAsyncCache } from "../src/cache/bounded-cache.ts";
import { createCachedPdfPageRasterizer } from "../src/pdf/rasterizer.ts";
import { cacheOcrSearchQuery, cacheRecognizedPages, getCachedOcrSearchQuery, getCachedRecognizedPages, invalidateOcrCache } from "../src/ocr/cache.ts";

test("bounded cache shares in-flight loads and retries after failures", async () => {
  const cache = new BoundedAsyncCache<string>({ maxEntries: 4, maxWeight: 100 });
  let calls = 0;
  let reject = true;
  const load = () => {
    calls += 1;
    return reject ? Promise.reject(new Error("temporary")) : Promise.resolve("ready");
  };
  await assert.rejects(Promise.all([cache.getOrLoad("same", load), cache.getOrLoad("same", load)]), /temporary/);
  assert.equal(calls, 1);
  reject = false;
  assert.equal(await cache.getOrLoad("same", load), "ready");
  assert.equal(calls, 2);
});

test("invalidating pending work prevents stale results from repopulating the cache", async () => {
  const cache = new BoundedAsyncCache<string>({ maxEntries: 2, maxWeight: 100 });
  let release!: (value: string) => void;
  const first = cache.getOrLoad("document", () => new Promise<string>((resolve) => { release = resolve; }));
  assert.equal(cache.invalidateWhere((key) => key === "document"), 0);
  const replacement = cache.getOrLoad("document", () => Promise.resolve("new"));
  release("old");
  assert.equal(await first, "old");
  assert.equal(await replacement, "new");
  assert.equal(cache.get("document"), "new");
});

test("page cache keys identity, revision, resolution and evicts least-recently-used pages", async () => {
  let renders = 0;
  const rasterizer = createCachedPdfPageRasterizer({
    getPageCount: async () => 3,
    renderPage: async ({ pageIndex, revision, maxDimension }) => {
      renders += 1;
      return `file://page-${pageIndex}-${revision}-${maxDimension ?? 0}`;
    },
  }, { maxEntries: 2, maxBytes: 20_000_000 });
  const base = { uri: "file://doc.pdf", documentId: "doc", revision: 1, pageIndex: 0 };
  assert.equal(await rasterizer.renderPage(base), "file://page-0-1-0");
  assert.equal(await rasterizer.renderPage(base), "file://page-0-1-0");
  assert.equal(renders, 1);
  assert.equal(await rasterizer.renderPage({ ...base, revision: 2 }), "file://page-0-2-0");
  assert.equal(await rasterizer.renderPage({ ...base, pageIndex: 1 }), "file://page-1-1-0");
  assert.equal(renders, 3);
  // Revision 1 page 0 was the oldest entry and is evicted; revision 2 is a miss.
  assert.equal(await rasterizer.renderPage(base), "file://page-0-1-0");
  assert.equal(renders, 4);
  assert.equal(rasterizer.invalidate("doc", 1), 2);
});

test("OCR cache preserves search state and separates revisions/languages", () => {
  const file = { name: "sample.pdf", uri: "file://sample", localId: "sample", revision: 1 };
  cacheRecognizedPages(file, [{ page: 1, text: "안내" }], "kor");
  cacheOcrSearchQuery(file, "안내", "kor");
  assert.deepEqual(getCachedRecognizedPages(file, "kor"), [{ page: 1, text: "안내" }]);
  assert.equal(getCachedOcrSearchQuery(file, "kor"), "안내");
  assert.equal(getCachedRecognizedPages(file, "eng"), undefined);
  assert.equal(getCachedRecognizedPages({ ...file, revision: 2 }, "kor"), undefined);
  assert.equal(invalidateOcrCache(file, 1), 2);
  assert.equal(getCachedRecognizedPages(file, "kor"), undefined);
});
