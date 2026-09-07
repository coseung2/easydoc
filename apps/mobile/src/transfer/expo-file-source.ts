import { File } from "expo-file-system";
import { sha256 } from "@noble/hashes/sha2.js";
import type { ChunkSource } from "./sender.ts";

type FileRevision = { size: number; modificationTime: number };
const hashCache = new Map<string, string>();
const pendingHashes = new Map<string, Promise<string>>();
const MAX_HASH_CACHE_ENTRIES = 64;

export class ExpoFileChunkSource implements ChunkSource {
  readonly size: number;
  private readonly handle: ReturnType<File["open"]>;
  private closed = false;

  constructor(readonly uri: string) {
    const file = new File(uri);
    this.size = file.size;
    this.handle = file.open();
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (this.closed) throw new Error("source_closed");
    this.handle.offset = offset;
    return this.handle.readBytes(length);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handle.close();
  }
}

function revisionFor(file: File): FileRevision | null {
  const modificationTime = (file as File & { modificationTime?: number | null }).modificationTime;
  // A cache without a reliable revision could return a hash for a replaced
  // content:// document. In that case hashing is still correct; it is simply
  // not reused.
  if (typeof modificationTime !== "number" || !Number.isFinite(modificationTime)) return null;
  return { size: file.size, modificationTime };
}

function cacheKey(uri: string, revision: FileRevision): string {
  return `${uri}\u0000${revision.size}\u0000${revision.modificationTime}`;
}

function rememberHash(key: string, value: string): void {
  hashCache.delete(key);
  hashCache.set(key, value);
  while (hashCache.size > MAX_HASH_CACHE_ENTRIES) hashCache.delete(hashCache.keys().next().value!);
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Hashes in bounded native reads and yields between batches. Expo's FileHandle
 * readBytes API is synchronous, so this cannot move the cryptographic loop to
 * a worker without a native worker module; yielding keeps the JS event loop
 * responsive and avoids one giant full-file read. Revisions make reuse safe.
 */
export async function sha256File(uri: string, chunkSize = 1024 * 1024, options: { shouldCancel?: () => boolean } = {}): Promise<string> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error("invalid_hash_chunk_size");
  const file = new File(uri);
  const revision = revisionFor(file);
  const key = revision ? cacheKey(uri, revision) : null;
  if (key) {
    const cached = hashCache.get(key);
    if (cached) return cached;
    const pending = pendingHashes.get(key);
    if (pending) return pending;
  }

  const task = (async () => {
    const handle = file.open();
    const hash = sha256.create();
    try {
      let chunks = 0;
      while ((handle.offset ?? 0) < file.size) {
        if (options.shouldCancel?.()) throw new Error("transfer_cancelled");
        const remaining = file.size - (handle.offset ?? 0);
        const payload = handle.readBytes(Math.min(chunkSize, remaining));
        if (payload.byteLength === 0) throw new Error("source_short_read");
        hash.update(payload);
        chunks += 1;
        if (chunks % 4 === 0) await yieldToUi();
      }
      const digest = hash.digest().reduce((hex, byte) => hex + byte.toString(16).padStart(2, "0"), "");
      const finalRevision = revisionFor(new File(uri));
      if (key && finalRevision && cacheKey(uri, finalRevision) === key) rememberHash(key, digest);
      return digest;
    } finally {
      handle.close();
    }
  })();
  if (key) pendingHashes.set(key, task);
  try { return await task; }
  finally { if (key && pendingHashes.get(key) === task) pendingHashes.delete(key); }
}

export function clearSha256Cache(): void {
  hashCache.clear();
  pendingHashes.clear();
}
