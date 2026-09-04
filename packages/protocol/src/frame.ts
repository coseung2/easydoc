import { BINARY_FRAME_HEADER_BYTES, BINARY_FRAME_TYPE, MAX_CHUNK_SIZE, PROTOCOL_VERSION } from "./constants.ts";

export type ChunkFrame = { version: typeof PROTOCOL_VERSION; type: typeof BINARY_FRAME_TYPE.chunk; transferId: string; chunkIndex: number; payload: Uint8Array };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function uuidToBytes(uuid: string): Uint8Array {
  if (!UUID_PATTERN.test(uuid)) throw new Error("invalid_transfer_id");
  return Uint8Array.from(uuid.replaceAll("-", "").match(/.{2}/g)!.map((part) => Number.parseInt(part, 16)));
}
function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}
export function encodeChunkFrame(input: { transferId: string; chunkIndex: number; payload: Uint8Array }): Uint8Array {
  if (!Number.isSafeInteger(input.chunkIndex) || input.chunkIndex < 0) throw new Error("invalid_chunk_index");
  if (input.chunkIndex > 0xffffffff) throw new Error("chunk_index_too_large");
  if (input.payload.byteLength > MAX_CHUNK_SIZE) throw new Error("chunk_too_large");
  const output = new Uint8Array(BINARY_FRAME_HEADER_BYTES + input.payload.byteLength);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, BINARY_FRAME_TYPE.chunk);
  output.set(uuidToBytes(input.transferId), 2);
  view.setUint32(18, input.chunkIndex, false);
  view.setUint32(22, input.payload.byteLength, false);
  output.set(input.payload, BINARY_FRAME_HEADER_BYTES);
  return output;
}
export function decodeChunkFrame(data: ArrayBuffer | Uint8Array): ChunkFrame {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < BINARY_FRAME_HEADER_BYTES) throw new Error("frame_too_short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0); const type = view.getUint8(1);
  const chunkIndex = view.getUint32(18, false); const payloadLength = view.getUint32(22, false);
  if (version !== PROTOCOL_VERSION) throw new Error("unsupported_protocol");
  if (type !== BINARY_FRAME_TYPE.chunk) throw new Error("unsupported_binary_frame_type");
  if (payloadLength > MAX_CHUNK_SIZE) throw new Error("chunk_too_large");
  if (bytes.byteLength !== BINARY_FRAME_HEADER_BYTES + payloadLength) throw new Error("invalid_payload_length");
  return { version: PROTOCOL_VERSION, type: BINARY_FRAME_TYPE.chunk, transferId: bytesToUuid(bytes.subarray(2, 18)), chunkIndex, payload: bytes.slice(BINARY_FRAME_HEADER_BYTES) };
}
