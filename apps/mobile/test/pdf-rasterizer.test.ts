import assert from "node:assert/strict";
import test from "node:test";
import { createFullDocumentPdfRasterizer } from "../src/pdf/rasterizer.ts";

test("full-document PDF rasterizer hides conversion behind page-oriented calls and caches by URI", async () => {
  let conversions = 0;
  const rasterizer = createFullDocumentPdfRasterizer(async (uri) => {
    conversions += 1;
    return { outputFiles: [`${uri}/1.png`, `${uri}/2.png`, `${uri}/3.png`] };
  });

  assert.equal(await rasterizer.getPageCount("file://sample.pdf"), 3);
  assert.equal(await rasterizer.renderPage({ uri: "file://sample.pdf", pageIndex: 1 }), "file://sample.pdf/2.png");
  assert.equal(await rasterizer.renderPage({ uri: "file://sample.pdf", pageIndex: 2 }), "file://sample.pdf/3.png");
  assert.equal(conversions, 1);

  await rasterizer.release?.("file://sample.pdf");
  assert.equal(await rasterizer.renderPage({ uri: "file://sample.pdf", pageIndex: 0 }), "file://sample.pdf/1.png");
  assert.equal(conversions, 2);
});

test("full-document PDF rasterizer validates page indexes", async () => {
  const rasterizer = createFullDocumentPdfRasterizer(async () => ({ outputFiles: ["page-1.png"] }));
  await assert.rejects(() => rasterizer.renderPage({ uri: "file://sample.pdf", pageIndex: -1 }), /invalid_pdf_page_index/);
  await assert.rejects(() => rasterizer.renderPage({ uri: "file://sample.pdf", pageIndex: 2 }), /pdf_page_missing/);
});
