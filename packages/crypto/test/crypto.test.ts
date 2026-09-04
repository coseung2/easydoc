import assert from "node:assert/strict";
import test from "node:test";
import { decryptChunk, deriveTransferKey, encryptChunk, generateDeviceKeyPair } from "../src/index.ts";

const transferId = "123e4567-e89b-42d3-a456-426614174000";

test("X25519 peers derive the same transfer-scoped key", () => {
  const mobile = generateDeviceKeyPair(); const desktop = generateDeviceKeyPair();
  const left = deriveTransferKey(mobile.secretKey, desktop.publicKey, transferId);
  const right = deriveTransferKey(desktop.secretKey, mobile.publicKey, transferId);
  assert.deepEqual(left, right);
});

test("chunk encryption round-trips and authenticates transfer/index AAD", () => {
  const mobile = generateDeviceKeyPair(); const desktop = generateDeviceKeyPair();
  const key = deriveTransferKey(mobile.secretKey, desktop.publicKey, transferId);
  const clear = new TextEncoder().encode("sensitive classroom document bytes");
  const encrypted = encryptChunk(key, transferId, 7, clear);
  assert.notDeepEqual(encrypted, clear);
  assert.deepEqual(decryptChunk(key, transferId, 7, encrypted), clear);
  assert.throws(() => decryptChunk(key, transferId, 8, encrypted), /chunk_authentication_failed/);
});

test("different transfer ids cannot reuse ciphertext", () => {
  const mobile = generateDeviceKeyPair(); const desktop = generateDeviceKeyPair();
  const key = deriveTransferKey(mobile.secretKey, desktop.publicKey, transferId);
  const encrypted = encryptChunk(key, transferId, 0, new Uint8Array([1,2,3]));
  assert.throws(() => decryptChunk(key, "223e4567-e89b-42d3-a456-426614174000", 0, encrypted), /chunk_authentication_failed/);
});
