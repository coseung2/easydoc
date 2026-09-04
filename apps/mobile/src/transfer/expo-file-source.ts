import { File } from "expo-file-system";
import { sha256 } from "@noble/hashes/sha2.js";
import type { ChunkSource } from "./sender.ts";

export class ExpoFileChunkSource implements ChunkSource {
  readonly size: number;
  private readonly handle: ReturnType<File["open"]>;

  constructor(readonly uri: string) {
    const file = new File(uri);
    this.size = file.size;
    this.handle = file.open();
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    this.handle.offset = offset;
    return this.handle.readBytes(length);
  }

  close(): void { this.handle.close(); }
}

export function sha256File(uri: string, chunkSize = 1024 * 1024): string {
  const file = new File(uri); const handle = file.open(); const hash = sha256.create();
  try { while ((handle.offset ?? 0) < file.size) { const remaining = file.size - (handle.offset ?? 0); hash.update(handle.readBytes(Math.min(chunkSize, remaining))); } return hash.digest().reduce((hex, byte) => hex + byte.toString(16).padStart(2, "0"), ""); }
  finally { handle.close(); }
}
