import assert from "node:assert/strict";
import test from "node:test";
import { joinRecognizedPages, searchRecognizedPages } from "../src/ocr/text.ts";

test("OCR pages preserve Korean text and original page numbers when searching", () => {
  const pages = [{ page: 1, text: "  학급 안내\nEasyDoc  " }, { page: 2, text: " " }, { page: 3, text: "학교 안내" }];
  assert.equal(joinRecognizedPages(pages), "학급 안내\nEasyDoc\n\n학교 안내");
  assert.deepEqual(searchRecognizedPages(pages, "안내").map(({ page }) => page), [1, 3]);
  assert.equal(searchRecognizedPages(pages, "easydoc")[0]?.page, 1);
  assert.deepEqual(searchRecognizedPages(pages, " "), []);
});
