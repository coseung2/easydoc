import assert from "node:assert/strict";
import test from "node:test";
import { removePageAt, reorderPages, replacePageAt, scanImageName } from "../src/scanner/scanner-flow.ts";
import type { EditableScanPage } from "../src/scanner/process-page.ts";

const page = (id: string): EditableScanPage => ({ id, uri: "file://" + id + ".jpg", rotation: 0, filter: "color" });

test("scanner editing preserves order changes and selection data", () => {
  const pages = [page("one"), page("two"), page("three")];
  assert.deepEqual(reorderPages(pages, 1, -1).map((item) => item.id), ["two", "one", "three"]);
  assert.deepEqual(reorderPages(pages, 1, 1).map((item) => item.id), ["one", "three", "two"]);
  assert.deepEqual(removePageAt(pages, 1).map((item) => item.id), ["one", "three"]);
  assert.deepEqual(replacePageAt(pages, 1, { ...page("replacement"), rotation: 90 }).map((item) => item.id), ["one", "replacement", "three"]);
});

test("scanner image output names match the prepared image type", () => {
  assert.equal(scanImageName(0, "file:///scan.jpg"), "scan_001.jpg");
  assert.equal(scanImageName(1, "file:///scan.PNG"), "scan_002.png");
});
