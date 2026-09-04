import { encodeChunkFrame, type TransferStartMessage } from "../../../../packages/protocol/src/index.ts";

export type ChunkSource = { size: number; read(offset: number, length: number): Promise<Uint8Array> };
export type FrameSender = (frame: Uint8Array) => void | Promise<void>;
export type SenderProgress = { sentBytes: number; acknowledgedBytes: number; inFlightBytes: number; nextChunk: number; complete: boolean };
type InFlightChunk = { index: number; bytes: number };

export class TransferSender {
  private readonly transfer: TransferStartMessage;
  private readonly source: ChunkSource;
  private readonly sendFrame: FrameSender;
  private readonly maxInFlightBytes: number;
  private nextChunk = 0;
  private acknowledgedThrough = -1;
  private sentBytes = 0;
  private acknowledgedBytes = 0;
  private inFlight = new Map<number, InFlightChunk>();
  private pumping = false;

  constructor(transfer: TransferStartMessage, source: ChunkSource, sendFrame: FrameSender, maxInFlightBytes = 8 * 1024 * 1024) {
    if (source.size !== transfer.size) throw new Error("source_size_mismatch");
    if (maxInFlightBytes < transfer.chunkSize) throw new Error("window_smaller_than_chunk");
    this.transfer = transfer; this.source = source; this.sendFrame = sendFrame; this.maxInFlightBytes = maxInFlightBytes;
  }

  async start(resumeFromChunk = 0): Promise<SenderProgress> {
    if (!Number.isSafeInteger(resumeFromChunk) || resumeFromChunk < 0) throw new Error("invalid_resume_position");
    this.nextChunk = resumeFromChunk;
    this.acknowledgedThrough = resumeFromChunk - 1;
    this.sentBytes = Math.min(resumeFromChunk * this.transfer.chunkSize, this.transfer.size);
    this.acknowledgedBytes = this.sentBytes;
    this.inFlight.clear();
    await this.pump();
    return this.progress();
  }

  async acknowledge(receivedThroughChunk: number): Promise<SenderProgress> {
    if (!Number.isSafeInteger(receivedThroughChunk) || receivedThroughChunk < -1) throw new Error("invalid_ack");
    if (receivedThroughChunk < this.acknowledgedThrough) return this.progress();
    this.acknowledgedThrough = receivedThroughChunk;
    for (const [index] of this.inFlight) if (index <= receivedThroughChunk) this.inFlight.delete(index);
    this.acknowledgedBytes = Math.min((receivedThroughChunk + 1) * this.transfer.chunkSize, this.transfer.size);
    await this.pump();
    return this.progress();
  }

  async resume(receivedThroughChunk: number): Promise<SenderProgress> {
    if (!Number.isSafeInteger(receivedThroughChunk) || receivedThroughChunk < -1) throw new Error("invalid_resume_position");
    return this.start(receivedThroughChunk + 1);
  }

  progress(): SenderProgress {
    const inFlightBytes = Array.from(this.inFlight.values()).reduce((total, item) => total + item.bytes, 0);
    return { sentBytes: this.sentBytes, acknowledgedBytes: this.acknowledgedBytes, inFlightBytes, nextChunk: this.nextChunk, complete: this.acknowledgedBytes === this.transfer.size };
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (true) {
        const offset = this.nextChunk * this.transfer.chunkSize;
        if (offset >= this.transfer.size) return;
        const length = Math.min(this.transfer.chunkSize, this.transfer.size - offset);
        const inFlightBytes = Array.from(this.inFlight.values()).reduce((total, item) => total + item.bytes, 0);
        if (inFlightBytes + length > this.maxInFlightBytes) return;
        const payload = await this.source.read(offset, length);
        if (payload.byteLength !== length) throw new Error("source_short_read");
        const index = this.nextChunk;
        await this.sendFrame(encodeChunkFrame({ transferId: this.transfer.transferId, chunkIndex: index, payload }));
        this.inFlight.set(index, { index, bytes: length });
        this.nextChunk += 1;
        this.sentBytes = Math.max(this.sentBytes, offset + length);
      }
    } finally { this.pumping = false; }
  }
}
