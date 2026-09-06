import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { mergePdfs, optimizePdf, pageCount, reorderAndDeletePdf, rotatePdf, splitPdf } from "../src/index.ts";

async function sample(count: number) {
  const document = await PDFDocument.create();
  for (let index = 0; index < count; index += 1) document.addPage([300 + index, 400 + index]);
  return document.save();
}

test("merge preserves all source pages", async () => {
  const merged = await mergePdfs([await sample(2), await sample(3)]);
  assert.equal(await pageCount(merged), 5);
});

test("split produces one PDF per page", async () => {
  const parts = await splitPdf(await sample(3));
  assert.equal(parts.length, 3);
  assert.deepEqual(await Promise.all(parts.map(pageCount)), [1, 1, 1]);
});

test("reorder and delete emits only requested unique pages", async () => {
  const result = await reorderAndDeletePdf(await sample(4), [3, 1, 0]);
  const document = await PDFDocument.load(result);
  assert.equal(document.getPageCount(), 3);
  assert.equal(document.getPage(0).getWidth(), 303);
  assert.equal(document.getPage(1).getWidth(), 301);
});

test("rotation updates target pages only", async () => {
  const result = await rotatePdf(await sample(2), 90, [1]);
  const document = await PDFDocument.load(result);
  assert.equal(document.getPage(0).getRotation().angle, 0);
  assert.equal(document.getPage(1).getRotation().angle, 90);
});

test("optimization keeps the document readable", async () => {
  const output = await optimizePdf(await sample(2));
  assert.equal(await pageCount(output), 2);
});

test("PDF tools reject an encryption dictionary instead of silently rewriting protected content", async () => {
  const document = await PDFDocument.create();
  document.addPage();
  document.context.trailerInfo.Encrypt = document.context.register(document.context.obj({ Filter: "Standard", V: 1, R: 2 }));
  const protectedPdf = await document.save();
  await assert.rejects(() => optimizePdf(protectedPdf), /encrypted/i);
  await assert.rejects(() => mergePdfs([protectedPdf, protectedPdf]), /encrypted/i);
  await assert.rejects(() => splitPdf(protectedPdf), /encrypted/i);
});
