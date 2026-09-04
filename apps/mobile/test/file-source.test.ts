import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileChunkSource } from "../src/transfer/file-source.ts";

test("file chunk source reads only requested ranges and closes explicitly", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easydoc-source-"));
  const filePath = path.join(directory, "input.bin");
  try {
    await writeFile(filePath, Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const source = await FileChunkSource.open(filePath);
    assert.equal(source.size, 10);
    assert.deepEqual(await source.read(3, 4), Uint8Array.from([3, 4, 5, 6]));
    assert.deepEqual(await source.read(8, 10), Uint8Array.from([8, 9]));
    await source.close();
    await assert.rejects(() => source.read(0, 1), /source_closed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
