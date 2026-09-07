import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const encoder = new TextEncoder();
const KEY_BYTES = 32;
const NONCE_BYTES = 24;

export type DeviceKeyPair = { publicKey: string; secretKey: string };

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  let binary: string;
  try { binary = atob(padded); } catch { throw new Error("invalid_key_encoding"); }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function generateDeviceKeyPair(): DeviceKeyPair {
  const pair = x25519.keygen();
  return { publicKey: bytesToBase64Url(pair.publicKey), secretKey: bytesToBase64Url(pair.secretKey) };
}

export function publicKeyFromSecret(secretKey: string): string {
  const secret = base64UrlToBytes(secretKey);
  return bytesToBase64Url(x25519.getPublicKey(secret));
}

export function deriveTransferKey(secretKey: string, peerPublicKey: string, transferId: string): Uint8Array {
  const shared = x25519.getSharedSecret(base64UrlToBytes(secretKey), base64UrlToBytes(peerPublicKey));
  return hkdf(sha256, shared, encoder.encode(`easydoc-transfer:${transferId}`), encoder.encode("easydoc/x25519+xchacha20poly1305/v1"), KEY_BYTES);
}

function nonceForChunk(chunkIndex: number): Uint8Array {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 0xffffffff) throw new Error("invalid_chunk_index");
  const nonce = new Uint8Array(NONCE_BYTES);
  new DataView(nonce.buffer).setUint32(NONCE_BYTES - 4, chunkIndex, false);
  return nonce;
}

function aadForChunk(transferId: string, chunkIndex: number): Uint8Array {
  return encoder.encode(`easydoc:v1:${transferId}:${chunkIndex}`);
}

export function encryptChunk(key: Uint8Array, transferId: string, chunkIndex: number, plaintext: Uint8Array): Uint8Array {
  if (key.byteLength !== KEY_BYTES) throw new Error("invalid_transfer_key");
  return xchacha20poly1305(key, nonceForChunk(chunkIndex), aadForChunk(transferId, chunkIndex)).encrypt(plaintext);
}

export function decryptChunk(key: Uint8Array, transferId: string, chunkIndex: number, ciphertext: Uint8Array): Uint8Array {
  if (key.byteLength !== KEY_BYTES) throw new Error("invalid_transfer_key");
  try { return xchacha20poly1305(key, nonceForChunk(chunkIndex), aadForChunk(transferId, chunkIndex)).decrypt(ciphertext); }
  catch { throw new Error("chunk_authentication_failed"); }
}
