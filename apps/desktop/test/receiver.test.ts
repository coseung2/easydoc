import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IncomingTransfer } from "../src/receiver.ts";
import type { TransferStartMessage } from "../../../packages/protocol/src/index.ts";

const TRANSFER_ID = "123e4567-e89b-42d3-a456-426614174000";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const startFor = (name: string, bytes: Uint8Array, chunkSize = 4): TransferStartMessage => ({ type: "transfer:start", transferId: TRANSFER_ID, destinationDeviceId: "school-pc", name, size: bytes.byteLength, mime: "application/pdf", sha256: sha256(bytes), chunkSize });

async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easydoc-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("streams Korean-named files to .part and atomically finalizes after checksum", () => withTempDir(async (dir) => {
  const bytes = new TextEncoder().encode("hello document"); const start = startFor("학급교육과정.pdf", bytes, 5);
  const receiver = await IncomingTransfer.create(start, dir, async () => 1_000_000);
  assert.equal(receiver.resumeFromChunk, 0);
  await receiver.writeChunk(0, bytes.subarray(0, 5)); await receiver.writeChunk(1, bytes.subarray(5, 10));
  const done = await receiver.writeChunk(2, bytes.subarray(10));
  assert.equal(done.complete, true); assert.equal(path.basename(done.finalPath!), "학급교육과정.pdf");
  assert.deepEqual(await readFile(done.finalPath!), Buffer.from(bytes));
}));

test("resume survives receiver recreation and duplicate chunks are idempotent", () => withTempDir(async (dir) => {
  const bytes = new TextEncoder().encode("abcdefgh"); const start = startFor("scan.pdf", bytes, 4);
  const first = await IncomingTransfer.create(start, dir, async () => 1_000_000); await first.writeChunk(0, bytes.subarray(0, 4));
  const resumed = await IncomingTransfer.resume(TRANSFER_ID, dir); assert.equal(resumed.resumeFromChunk, 1);
  const duplicate = await resumed.writeChunk(0, bytes.subarray(0, 4)); assert.equal(duplicate.receivedThroughChunk, 0);
  const done = await resumed.writeChunk(1, bytes.subarray(4)); assert.equal(done.complete, true);
}));

test("filename collisions use numbered copies", () => withTempDir(async (dir) => {
  await writeFile(path.join(dir, "scan.pdf"), "existing"); const bytes = new TextEncoder().encode("next");
  const receiver = await IncomingTransfer.create(startFor("scan.pdf", bytes), dir, async () => 1_000_000);
  const done = await receiver.writeChunk(0, bytes); assert.equal(path.basename(done.finalPath!), "scan (1).pdf");
}));

test("checksum mismatch leaves the partial file unexposed", () => withTempDir(async (dir) => {
  const bytes = new TextEncoder().encode("data"); const start = { ...startFor("bad.pdf", bytes), sha256: "0".repeat(64) };
  const receiver = await IncomingTransfer.create(start, dir, async () => 1_000_000);
  await assert.rejects(() => receiver.writeChunk(0, bytes), /checksum_mismatch/);
  await assert.rejects(() => readFile(path.join(dir, "bad.pdf")));
  assert.deepEqual(await readFile(path.join(dir, "bad.pdf.part")), Buffer.from(bytes));
}));

test("fails before transfer when free space is insufficient", () => withTempDir(async (dir) => {
  const bytes = new Uint8Array(10);
  await assert.rejects(() => IncomingTransfer.create(startFor("big.pdf", bytes, 10), dir, async () => 9), /insufficient_space/);
}));
