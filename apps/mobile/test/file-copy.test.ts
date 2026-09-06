import test from "node:test";
import assert from "node:assert/strict";
import { copyFileAndMeasure } from "../src/documents/file-copy.ts";

test("file import measures the destination only after asynchronous copy completes", async () => {
  let copied = false;
  const target = { get size() { assert.equal(copied, true); return 123; } };
  const source = { async copy() { await Promise.resolve(); copied = true; } };
  assert.equal(await copyFileAndMeasure(source, target), 123);
});

test("copy failures and unreadable size cannot become saved documents", async () => {
  await assert.rejects(copyFileAndMeasure({ async copy() { throw new Error("copy_failed"); } }, { size: 0 }), /copy_failed/u);
  await assert.rejects(copyFileAndMeasure({ async copy() {} }, { size: NaN }));
  assert.equal(await copyFileAndMeasure({ async copy() {} }, { size: 0 }), 0);
});
