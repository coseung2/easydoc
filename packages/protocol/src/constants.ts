export const PROTOCOL_VERSION = 1 as const;
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;
export const MAX_CHUNK_SIZE = 4 * 1024 * 1024;
export const BINARY_FRAME_TYPE = { chunk: 1 } as const;
export const BINARY_FRAME_HEADER_BYTES = 26;
export const TRANSFER_ERROR_CODES = [
  "destination_offline",
  "pairing_invalid",
  "transfer_not_found",
  "insufficient_space",
  "write_failed",
  "checksum_mismatch",
  "unsupported_protocol",
  "cancelled",
  "relay_unavailable",
] as const;
export type TransferErrorCode = (typeof TRANSFER_ERROR_CODES)[number];
