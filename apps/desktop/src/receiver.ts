import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, open, readFile, rename, rm, stat, statfs, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { TransferStartMessage } from "../../../packages/protocol/src/index.ts";

export type ReceiveProgress = { receivedThroughChunk: number; bytesWritten: number; complete: boolean; finalPath?: string };
type ReceiveMetadata = { version: 1; transfer: TransferStartMessage; finalName: string; nextChunk: number; bytesWritten: number };
type FreeSpaceCheck = (directory: string) => Promise<number>;

const defaultFreeSpaceCheck: FreeSpaceCheck = async (directory) => {
  const info = await statfs(directory);
  return Number(info.bavail) * Number(info.bsize);
};
function safeFilename(input: string): string {
  const name = path.basename(input).replaceAll("\0", "").trim();
  if (!name || name === "." || name === "..") throw new Error("invalid_filename");
  return name;
}
async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}
async function collisionSafeName(directory: string, requested: string): Promise<string> {
  const parsed = path.parse(requested); let candidate = requested;
  for (let index = 0; await exists(path.join(directory, candidate)); index += 1) candidate = `${parsed.name} (${index + 1})${parsed.ext}`;
  return candidate;
}
async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export class IncomingTransfer {
  readonly rootDir: string;
  readonly metadataPath: string;
  readonly partPath: string;
  private metadata: ReceiveMetadata;
  private handle: FileHandle;

  private constructor(rootDir: string, metadataPath: string, partPath: string, metadata: ReceiveMetadata, handle: FileHandle) {
    this.rootDir = rootDir; this.metadataPath = metadataPath; this.partPath = partPath; this.metadata = metadata; this.handle = handle;
  }

  static async create(transfer: TransferStartMessage, rootDir: string, freeSpaceCheck: FreeSpaceCheck = defaultFreeSpaceCheck): Promise<IncomingTransfer> {
    await mkdir(rootDir, { recursive: true });
    if (await freeSpaceCheck(rootDir) < transfer.size) throw new Error("insufficient_space");
    const finalName = await collisionSafeName(rootDir, safeFilename(transfer.name));
    const metadataPath = path.join(rootDir, `.easydoc-${transfer.transferId}.json`);
    const partPath = path.join(rootDir, `${finalName}.part`);
    if (await exists(metadataPath)) return IncomingTransfer.resume(transfer.transferId, rootDir);
    const handle = await open(partPath, "wx+");
    const metadata: ReceiveMetadata = { version: 1, transfer, finalName, nextChunk: 0, bytesWritten: 0 };
    const receiver = new IncomingTransfer(rootDir, metadataPath, partPath, metadata, handle);
    await receiver.persistMetadata();
    return receiver;
  }

  static async resume(transferId: string, rootDir: string): Promise<IncomingTransfer> {
    const metadataPath = path.join(rootDir, `.easydoc-${transferId}.json`); let metadata: ReceiveMetadata;
    try { metadata = JSON.parse(await readFile(metadataPath, "utf8")); } catch { throw new Error("transfer_not_found"); }
    if (metadata.version !== 1 || metadata.transfer.transferId !== transferId) throw new Error("transfer_not_found");
    const partPath = path.join(rootDir, `${metadata.finalName}.part`); const partStat = await stat(partPath);
    if (partStat.size !== metadata.bytesWritten) throw new Error("resume_state_mismatch");
    return new IncomingTransfer(rootDir, metadataPath, partPath, metadata, await open(partPath, "r+"));
  }

  get resumeFromChunk(): number { return this.metadata.nextChunk; }
  get receivedThroughChunk(): number { return this.metadata.nextChunk - 1; }
  get bytesWritten(): number { return this.metadata.bytesWritten; }

  async writeChunk(index: number, payload: Uint8Array): Promise<ReceiveProgress> {
    if (index < this.metadata.nextChunk) return { receivedThroughChunk: this.receivedThroughChunk, bytesWritten: this.bytesWritten, complete: false };
    if (index !== this.metadata.nextChunk) throw new Error("unexpected_chunk");
    if (payload.byteLength > this.metadata.transfer.chunkSize) throw new Error("chunk_too_large");
    if (this.metadata.bytesWritten + payload.byteLength > this.metadata.transfer.size) throw new Error("transfer_size_exceeded");
    const result = await this.handle.write(payload, 0, payload.byteLength, this.metadata.bytesWritten);
    if (result.bytesWritten !== payload.byteLength) throw new Error("write_failed");
    this.metadata.bytesWritten += payload.byteLength; this.metadata.nextChunk += 1;
    if (this.metadata.nextChunk % 8 === 0 || this.metadata.bytesWritten === this.metadata.transfer.size) await this.handle.sync();
    await this.persistMetadata();
    if (this.metadata.bytesWritten === this.metadata.transfer.size) return this.finalize();
    return { receivedThroughChunk: this.receivedThroughChunk, bytesWritten: this.bytesWritten, complete: false };
  }

  async cancel(removePartial = true): Promise<void> {
    await this.handle.close(); await rm(this.metadataPath, { force: true }); if (removePartial) await rm(this.partPath, { force: true });
  }
  private async finalize(): Promise<ReceiveProgress> {
    await this.handle.sync(); await this.handle.close();
    if (await sha256File(this.partPath) !== this.metadata.transfer.sha256.toLowerCase()) throw new Error("checksum_mismatch");
    const finalPath = path.join(this.rootDir, this.metadata.finalName); await rename(this.partPath, finalPath); await rm(this.metadataPath, { force: true });
    return { receivedThroughChunk: this.receivedThroughChunk, bytesWritten: this.bytesWritten, complete: true, finalPath };
  }
  private async persistMetadata(): Promise<void> {
    const temporary = `${this.metadataPath}.tmp`; await writeFile(temporary, JSON.stringify(this.metadata), "utf8"); await rename(temporary, this.metadataPath);
  }
}
