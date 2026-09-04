import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IncomingTransfer } from "../apps/desktop/src/receiver.ts";
import { TransferSender, type ChunkSource } from "../apps/mobile/src/transfer/sender.ts";
import { decodeChunkFrame, type TransferStartMessage } from "../packages/protocol/src/index.ts";

const TRANSFER_ID = "123e4567-e89b-42d3-a456-426614174000";

test("Milestone 0 core transfer resumes after interruption and final checksum matches", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easydoc-e2e-"));
  try {
    const bytes = new TextEncoder().encode("교실 네트워크가 중간에 끊겨도 문서는 이어서 전송되어야 한다.");
    const chunkSize = 16;
    const transfer: TransferStartMessage = {
      type: "transfer:start",
      transferId: TRANSFER_ID,
      destinationDeviceId: "school-pc",
      name: "수업자료.pdf",
      size: bytes.byteLength,
      mime: "application/pdf",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      chunkSize,
    };
    const source: ChunkSource = { size: bytes.byteLength, async read(offset, length) { return bytes.slice(offset, offset + length); } };
    const queue: Uint8Array[] = [];
    const sender = new TransferSender(transfer, source, (frame) => queue.push(frame), chunkSize * 2);
    const firstReceiver = await IncomingTransfer.create(transfer, directory, async () => 1_000_000);

    await sender.start();
    const firstFrame = decodeChunkFrame(queue.shift()!);
    const firstProgress = await firstReceiver.writeChunk(firstFrame.chunkIndex, firstFrame.payload);
    await sender.acknowledge(firstProgress.receivedThroughChunk);

    await firstReceiver.interrupt();
    queue.length = 0;
    const resumedReceiver = await IncomingTransfer.resume(TRANSFER_ID, directory);
    assert.equal(resumedReceiver.receivedThroughChunk, 0);
    await sender.resume(resumedReceiver.receivedThroughChunk);

    let finalPath: string | undefined;
    while (!sender.progress().complete) {
      const encoded = queue.shift();
      assert.ok(encoded, "sender should have a frame available while transfer is incomplete");
      const frame = decodeChunkFrame(encoded);
      const progress = await resumedReceiver.writeChunk(frame.chunkIndex, frame.payload);
      if (progress.complete) finalPath = progress.finalPath;
      await sender.acknowledge(progress.receivedThroughChunk);
    }

    assert.ok(finalPath);
    const received = await readFile(finalPath);
    assert.deepEqual(received, Buffer.from(bytes));
    assert.equal(createHash("sha256").update(received).digest("hex"), transfer.sha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
