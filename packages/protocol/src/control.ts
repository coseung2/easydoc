import { MAX_CHUNK_SIZE, TRANSFER_ERROR_CODES, type TransferErrorCode } from "./constants.ts";

export type TransferStartMessage = { type: "transfer:start"; transferId: string; destinationDeviceId: string; name: string; size: number; mime: string; sha256: string; chunkSize: number };
export type TransferAcceptMessage = { type: "transfer:accept"; transferId: string; resumeFromChunk: number };
export type TransferRejectMessage = { type: "transfer:reject"; transferId: string; reason: TransferErrorCode };
export type TransferAckMessage = { type: "transfer:ack"; transferId: string; receivedThroughChunk: number };
export type TransferResumeMessage = { type: "transfer:resume"; transferId: string; receivedThroughChunk: number };
export type TransferCompleteMessage = { type: "transfer:complete"; transferId: string; bytes: number; sha256: string };
export type TransferCancelMessage = { type: "transfer:cancel"; transferId: string };
export type TransferControlMessage = TransferStartMessage | TransferAcceptMessage | TransferRejectMessage | TransferAckMessage | TransferResumeMessage | TransferCompleteMessage | TransferCancelMessage;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown, max = 1024): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const isTransferId = (value: unknown): value is string => typeof value === "string" && UUID_PATTERN.test(value);
const isSha256 = (value: unknown): value is string => typeof value === "string" && SHA256_PATTERN.test(value);
const isNonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const isReceivedThroughChunk = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= -1;
const isErrorCode = (value: unknown): value is TransferErrorCode => typeof value === "string" && (TRANSFER_ERROR_CODES as readonly string[]).includes(value);

export function isTransferControlMessage(value: unknown): value is TransferControlMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "transfer:start": return isTransferId(value.transferId) && isString(value.destinationDeviceId, 256) && isString(value.name) && isNonNegativeInteger(value.size) && isString(value.mime, 256) && isSha256(value.sha256) && Number.isSafeInteger(value.chunkSize) && Number(value.chunkSize) > 0 && Number(value.chunkSize) <= MAX_CHUNK_SIZE;
    case "transfer:accept": return isTransferId(value.transferId) && isNonNegativeInteger(value.resumeFromChunk);
    case "transfer:reject": return isTransferId(value.transferId) && isErrorCode(value.reason);
    case "transfer:ack":
    case "transfer:resume": return isTransferId(value.transferId) && isReceivedThroughChunk(value.receivedThroughChunk);
    case "transfer:complete": return isTransferId(value.transferId) && isNonNegativeInteger(value.bytes) && isSha256(value.sha256);
    case "transfer:cancel": return isTransferId(value.transferId);
    default: return false;
  }
}

export function parseTransferControlMessage(value: string | unknown): TransferControlMessage {
  let candidate: unknown = value;
  if (typeof value === "string") {
    try { candidate = JSON.parse(value); } catch { throw new Error("invalid_control_json"); }
  }
  if (!isTransferControlMessage(candidate)) throw new Error("invalid_control_message");
  return candidate;
}
