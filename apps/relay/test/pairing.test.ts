import assert from "node:assert/strict";
import test from "node:test";
import { verifySessionCredential } from "../src/auth.ts";
import { PAIRING_TTL_MS, PairingRegistry } from "../src/pairing.ts";

const SECRET = "test-pairing-signing-secret";

function registryAt(now: { value: number }) {
  return new PairingRegistry({
    now: () => now.value,
    token: () => "single-use-token",
    roomId: () => "room_school",
  });
}

test("pairing QR defaults to a five minute lifetime and binds desktop identity", () => {
  const now = { value: 1_700_000_000_000 };
  const registry = registryAt(now);
  const payload = registry.issue("school-pc", "desktop-public-key");
  assert.equal(payload.expiresAt, now.value + PAIRING_TTL_MS);
  assert.equal(payload.desktopId, "school-pc");
  assert.equal(payload.roomId, "room_school");
  assert.equal(payload.pairingToken, "single-use-token");
});

test("pairing token is single use and creates an authorized device relationship", () => {
  const now = { value: 1_700_000_000_000 };
  const registry = registryAt(now);
  const payload = registry.issue("school-pc", "desktop-public-key");
  const relationship = registry.claim(payload, "phone-1", "mobile-public-key");
  assert.equal(relationship.roomId, "room_school");
  assert.equal(registry.isAuthorized("room_school", "desktop", "school-pc"), true);
  assert.equal(registry.isAuthorized("room_school", "mobile", "phone-1"), true);
  assert.throws(() => registry.claim(payload, "phone-2", "other-key"), /pairing_invalid/);
});

test("expired pairing token is rejected", () => {
  const now = { value: 1_700_000_000_000 };
  const registry = registryAt(now);
  const payload = registry.issue("school-pc", "desktop-public-key");
  now.value += PAIRING_TTL_MS + 1;
  assert.throws(() => registry.claim(payload, "phone-1", "mobile-public-key"), /pairing_expired/);
});

test("tampered QR payload cannot consume the pending token", () => {
  const now = { value: 1_700_000_000_000 };
  const registry = registryAt(now);
  const payload = registry.issue("school-pc", "desktop-public-key");
  assert.throws(() => registry.claim({ ...payload, desktopId: "attacker-pc" }, "phone-1", "mobile-public-key"), /pairing_invalid/);
  assert.doesNotThrow(() => registry.claim(payload, "phone-1", "mobile-public-key"));
});

test("paired devices receive room-bound role-specific session credentials and can be revoked", async () => {
  const now = { value: 1_700_000_000_000 };
  const registry = registryAt(now);
  const relationship = registry.claim(registry.issue("school-pc", "desktop-public-key"), "phone-1", "mobile-public-key");
  const expiresAt = now.value + 60_000;
  const tokens = await registry.issueSessionTokens(relationship, SECRET, expiresAt);
  const desktop = await verifySessionCredential(tokens.desktopToken, SECRET, now.value);
  const mobile = await verifySessionCredential(tokens.mobileToken, SECRET, now.value);
  assert.deepEqual([desktop.roomId, desktop.role, desktop.deviceId], ["room_school", "desktop", "school-pc"]);
  assert.deepEqual([mobile.roomId, mobile.role, mobile.deviceId], ["room_school", "mobile", "phone-1"]);
  assert.equal(registry.revoke("room_school"), true);
  assert.equal(registry.isAuthorized("room_school", "mobile", "phone-1"), false);
});
