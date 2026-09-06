import assert from "node:assert/strict";
import test from "node:test";
import { installRandomUuidPolyfill } from "../src/polyfills/crypto.ts";

test("randomUUID polyfill creates RFC 4122 version 4 identifiers", () => {
  const crypto = { getRandomValues(bytes: Uint8Array) { bytes.fill(0xab); return bytes; } } as unknown as Crypto;
  installRandomUuidPolyfill(crypto);
  assert.match(crypto.randomUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
});
