import assert from "node:assert/strict";
import test from "node:test";
import { documentMatchesFilter, filterLocalDocuments } from "../src/documents/store.ts";

const documents = [
  { id: "hwp", title: "학급교육과정.hwp", uri: "file:///hwp", pageCount: 0, size: 1, mimeType: "application/octet-stream", createdAt: 1, folderId: null },
  { id: "pdf", title: "영수증.pdf", uri: "file:///pdf", pageCount: 1, size: 2, mimeType: "application/pdf", createdAt: 2, folderId: "receipts" },
  { id: "docx", title: "수업안.docx", uri: "file:///docx", pageCount: 0, size: 3, mimeType: "application/octet-stream", createdAt: 3, folderId: "lessons" },
  { id: "image", title: "사진.jpg", uri: "file:///image", pageCount: 0, size: 4, mimeType: "image/jpeg", createdAt: 4, folderId: null },
];

test("document filters use extension and mime type, including generic HWP mime types", () => {
  assert.equal(documentMatchesFilter(documents[0]!, "hwp"), true);
  assert.deepEqual(filterLocalDocuments(documents, "수업", "office").map((document) => document.id), ["docx"]);
  assert.deepEqual(filterLocalDocuments(documents, "", "pdf").map((document) => document.id), ["pdf"]);
});

test("folder filtering distinguishes all documents from unfiled documents", () => {
  assert.deepEqual(filterLocalDocuments(documents, "", "all", "receipts").map((document) => document.id), ["pdf"]);
  assert.deepEqual(filterLocalDocuments(documents, "", "all", null).map((document) => document.id), ["hwp", "image"]);
  assert.equal(filterLocalDocuments(documents).length, documents.length);
});
