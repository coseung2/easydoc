import { open, stat, type FileHandle } from "node:fs/promises";
import type { ChunkSource } from "./sender.ts";

export class FileChunkSource implements ChunkSource {
  readonly size: number;
  readonly filePath: string;
  private readonly handle: FileHandle;
  private closed = false;

  private constructor(filePath: string, size: number, handle: FileHandle) {
    this.filePath = filePath;
    this.size = size;
    this.handle = handle;
  }

  static async open(filePath: string): Promise<FileChunkSource> {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("source_not_file");
    const handle = await open(filePath, "r");
    return new FileChunkSource(filePath, info.size, handle);
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (this.closed) throw new Error("source_closed");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw new Error("invalid_source_range");
    if (offset >= this.size || length === 0) return new Uint8Array();
    const requested = Math.min(length, this.size - offset);
    const output = new Uint8Array(requested);
    const result = await this.handle.read(output, 0, requested, offset);
    return output.subarray(0, result.bytesRead);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.handle.close();
    this.closed = true;
  }
}
