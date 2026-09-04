import assert from "node:assert/strict";
import test from "node:test";
import { BINARY_FRAME_HEADER_BYTES, DEFAULT_CHUNK_SIZE, PROTOCOL_VERSION, assertPairingPayloadFresh, decodeChunkFrame, encodeChunkFrame, parsePairingPayload, parseTransferControlMessage } from "../src/index.ts";
const TRANSFER_ID = "123e4567-e89b-42d3-a456-426614174000";
test("validates transfer start and preserves Korean filenames", () => {
  const message = parseTransferControlMessage({ type: "transfer:start", transferId: TRANSFER_ID, destinationDeviceId: "school-pc", name: "학급교육과정.pdf", size: 1882723, mime: "application/pdf", sha256: "a".repeat(64), chunkSize: DEFAULT_CHUNK_SIZE });
  assert.equal(message.type, "transfer:start"); assert.equal(message.name, "학급교육과정.pdf");
});
test("rejects malformed transfer messages", () => assert.throws(() => parseTransferControlMessage({ type: "transfer:start", transferId: TRANSFER_ID, destinationDeviceId: "pc", name: "x.pdf", size: -1, mime: "application/pdf", sha256: "bad", chunkSize: DEFAULT_CHUNK_SIZE }), /invalid_control_message/));
test("chunk frames use fixed binary headers and round-trip", () => {
  const payload = Uint8Array.from([0, 1, 2, 253, 254, 255]); const encoded = encodeChunkFrame({ transferId: TRANSFER_ID, chunkIndex: 17, payload }); const decoded = decodeChunkFrame(encoded);
  assert.equal(encoded.byteLength, BINARY_FRAME_HEADER_BYTES + payload.length); assert.equal(decoded.transferId, TRANSFER_ID); assert.equal(decoded.chunkIndex, 17); assert.deepEqual(decoded.payload, payload);
});
test("rejects corrupt binary payload length", () => {
  const encoded = encodeChunkFrame({ transferId: TRANSFER_ID, chunkIndex: 0, payload: Uint8Array.from([1,2,3]) }); const broken = encoded.slice(); new DataView(broken.buffer).setUint32(22, 100, false);
  assert.throws(() => decodeChunkFrame(broken), /invalid_payload_length/);
});
test("pairing payload is versioned and expiration-aware", () => {
  const payload = parsePairingPayload({ version: PROTOCOL_VERSION, desktopId: "desktop_school", roomId: "room_123", publicKey: "public-key", pairingToken: "one-time-token", expiresAt: 1800000000000 });
  assert.doesNotThrow(() => assertPairingPayloadFresh(payload, 1700000000000)); assert.throws(() => assertPairingPayloadFresh(payload, 1900000000000), /pairing_expired/);
});
