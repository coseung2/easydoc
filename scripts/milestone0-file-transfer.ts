import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { IncomingTransfer } from "../apps/desktop/src/receiver.ts";
import { RelayRoom, type RelayPayload, type RelaySocket } from "../apps/relay/src/room.ts";
import { FileChunkSource } from "../apps/mobile/src/transfer/file-source.ts";
import { TransferSender } from "../apps/mobile/src/transfer/sender.ts";
import { DEFAULT_CHUNK_SIZE, decodeChunkFrame, type TransferStartMessage } from "../packages/protocol/src/index.ts";

const MiB = 1024 * 1024;
const ACCEPTANCE_SIZES: Record<string, number> = {
  "1mb": 1 * MiB,
  "100mb": 100 * MiB,
  "500mb": 500 * MiB,
  "1gb": 1024 * MiB,
};

type HarnessResult = {
  sizeBytes: number;
  chunkSize: number;
  chunks: number;
  peakInFlightBytes: number;
  sha256: string;
  elapsedMs: number;
};

class NullSocket implements RelaySocket {
  send(_data: RelayPayload): void {}
  close(): void {}
}

class FrameQueueSocket implements RelaySocket {
  readonly frames: Uint8Array[] = [];
  send(data: RelayPayload): void {
    if (typeof data === "string") return;
    this.frames.push(data instanceof Uint8Array ? data : new Uint8Array(data));
  }
  close(): void {}
}

async function createFixture(filePath: string, sizeBytes: number): Promise<string> {
  const handle = await open(filePath, "wx");
  const hash = createHash("sha256");
  const block = new Uint8Array(MiB);
  for (let index = 0; index < block.length; index += 1) block[index] = index % 251;
  try {
    let offset = 0;
    while (offset < sizeBytes) {
      const length = Math.min(block.length, sizeBytes - offset);
      const piece = block.subarray(0, length);
      const result = await handle.write(piece, 0, length, offset);
      if (result.bytesWritten !== length) throw new Error("fixture_short_write");
      hash.update(piece);
      offset += length;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function runMilestone0FileTransfer(sizeBytes: number, chunkSize = DEFAULT_CHUNK_SIZE): Promise<HarnessResult> {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw new Error("invalid_size");
  const directory = await mkdtemp(path.join(os.tmpdir(), "easydoc-m0-"));
  const inputPath = path.join(directory, "source.bin");
  const receiveDir = path.join(directory, "received");
  let source: FileChunkSource | undefined;
  let receiver: IncomingTransfer | undefined;
  const startedAt = performance.now();
  try {
    const expectedSha256 = await createFixture(inputPath, sizeBytes);
    source = await FileChunkSource.open(inputPath);
    const transfer: TransferStartMessage = {
      type: "transfer:start",
      transferId: randomUUID(),
      destinationDeviceId: "school-pc",
      name: "대용량_전송_검증.bin",
      size: sizeBytes,
      mime: "application/octet-stream",
      sha256: expectedSha256,
      chunkSize,
    };

    const room = new RelayRoom();
    const mobileSocket = new NullSocket();
    const desktopSocket = new FrameQueueSocket();
    const expiresAt = Date.now() + 60_000;
    room.attach({ version: 1, roomId: "benchmark-room", deviceId: "phone", role: "mobile", expiresAt }, mobileSocket);
    room.attach({ version: 1, roomId: "benchmark-room", deviceId: "school-pc", role: "desktop", expiresAt }, desktopSocket);

    receiver = await IncomingTransfer.create(transfer, receiveDir, async () => sizeBytes * 2 + 10 * MiB);
    const sender = new TransferSender(transfer, source, (frame) => room.handle("mobile", frame), 8 * MiB);
    let progress = await sender.start();
    let peakInFlightBytes = progress.inFlightBytes;
    let chunks = 0;
    let finalPath: string | undefined;

    while (!progress.complete) {
      const encoded = desktopSocket.frames.shift();
      if (!encoded) throw new Error("relay_frame_starvation");
      const frame = decodeChunkFrame(encoded);
      const received = await receiver.writeChunk(frame.chunkIndex, frame.payload);
      chunks += 1;
      if (received.complete) finalPath = received.finalPath;
      progress = await sender.acknowledge(received.receivedThroughChunk);
      peakInFlightBytes = Math.max(peakInFlightBytes, progress.inFlightBytes);
    }

    if (!finalPath) throw new Error("missing_final_file");
    const output = await stat(finalPath);
    if (output.size !== sizeBytes) throw new Error("final_size_mismatch");
    const actualSha256 = await sha256File(finalPath);
    if (actualSha256 !== expectedSha256) throw new Error("final_checksum_mismatch");

    return { sizeBytes, chunkSize, chunks, peakInFlightBytes, sha256: actualSha256, elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100 };
  } finally {
    if (source) await source.close().catch(() => undefined);
    if (receiver) await receiver.interrupt().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

function requestedSizes(args: string[]): number[] {
  const sizeIndex = args.indexOf("--size");
  const requested = sizeIndex >= 0 ? args[sizeIndex + 1]?.toLowerCase() : "1mb";
  if (!requested) throw new Error("missing_size");
  if (requested === "all") return Object.values(ACCEPTANCE_SIZES);
  const bytes = ACCEPTANCE_SIZES[requested];
  if (!bytes) throw new Error(`unsupported_size:${requested}`);
  return [bytes];
}

async function main(): Promise<void> {
  for (const sizeBytes of requestedSizes(process.argv.slice(2))) {
    const result = await runMilestone0FileTransfer(sizeBytes);
    console.log(JSON.stringify(result));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
