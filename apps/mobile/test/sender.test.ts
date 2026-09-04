import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { decodeChunkFrame, type TransferStartMessage } from "../../../packages/protocol/src/index.ts";
import { TransferSender, type ChunkSource } from "../src/transfer/sender.ts";

const TRANSFER_ID = "123e4567-e89b-42d3-a456-426614174000";
const bytes = new TextEncoder().encode("abcdefghijklmnopqrst");
const source: ChunkSource = { size: bytes.byteLength, async read(offset, length) { return bytes.slice(offset, offset + length); } };
const transfer: TransferStartMessage = { type: "transfer:start", transferId: TRANSFER_ID, destinationDeviceId: "school-pc", name: "테스트.pdf", size: bytes.byteLength, mime: "application/pdf", sha256: createHash("sha256").update(bytes).digest("hex"), chunkSize: 4 };

test("bounded window stops until cumulative acknowledgement advances", async () => {
  const frames: Uint8Array[] = [];
  const sender = new TransferSender(transfer, source, (frame) => frames.push(frame), 8);
  let progress = await sender.start();
  assert.equal(frames.length, 2); assert.equal(progress.inFlightBytes, 8); assert.equal(progress.sentBytes, 8);
  progress = await sender.acknowledge(0);
  assert.equal(frames.length, 3); assert.equal(progress.inFlightBytes, 8); assert.equal(decodeChunkFrame(frames[2]).chunkIndex, 2);
});

test("resume discards stale in-flight state and restarts after durable receiver position", async () => {
  const frames: Uint8Array[] = [];
  const sender = new TransferSender(transfer, source, (frame) => frames.push(frame), 8);
  await sender.start(); frames.length = 0;
  const progress = await sender.resume(0);
  assert.equal(decodeChunkFrame(frames[0]).chunkIndex, 1); assert.equal(decodeChunkFrame(frames[1]).chunkIndex, 2); assert.equal(progress.acknowledgedBytes, 4);
});

test("sender completes only after receiver acknowledges the final chunk", async () => {
  const frames: Uint8Array[] = [];
  const sender = new TransferSender(transfer, source, (frame) => frames.push(frame), 8);
  await sender.start();
  await sender.acknowledge(1); await sender.acknowledge(3);
  const beforeFinalAck = sender.progress(); assert.equal(beforeFinalAck.complete, false);
  const done = await sender.acknowledge(4); assert.equal(done.complete, true); assert.equal(done.acknowledgedBytes, bytes.byteLength);
});

test("sender rejects acknowledgements for chunks it has not sent", async () => {
  const sender = new TransferSender(transfer, source, () => undefined, 8);
  await sender.start();
  await assert.rejects(() => sender.acknowledge(2), /ack_beyond_sent/);
});

test("source short reads fail instead of silently corrupting the transfer", async () => {
  const shortSource: ChunkSource = { size: bytes.byteLength, async read(_offset, length) { return new Uint8Array(Math.max(0, length - 1)); } };
  const sender = new TransferSender(transfer, shortSource, () => undefined, 8);
  await assert.rejects(() => sender.start(), /source_short_read/);
});
