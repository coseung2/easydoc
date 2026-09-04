import assert from "node:assert/strict";
import test from "node:test";
import { verifySessionCredential } from "../src/auth.ts";
import { DurablePairingStore, SESSION_TTL_MS, type DurableStorageLike } from "../src/durable-pairing.ts";

class MemoryStorage implements DurableStorageLike {
  values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
}

function fixture(now = 1_800_000_000_000) {
  let serial = 0;
  const storage = new MemoryStorage();
  const store = new DurablePairingStore(storage, {
    now: () => now,
    randomSecret: () => `secret_${++serial}`,
    randomRoomId: () => "room_school",
  });
  return { store, storage, now };
}

test("desktop bootstrap secret stays outside QR and only its hash is persisted", async () => {
  const { store, storage } = fixture();
  const issued = await store.issue("school-pc", "desktop-public-key");
  assert.equal(issued.desktopSecret, "secret_1");
  assert.equal(issued.pairing.pairingToken, "secret_2");
  assert.equal(JSON.stringify(issued.pairing).includes(issued.desktopSecret), false);
  assert.equal(JSON.stringify([...storage.values.values()]).includes(issued.desktopSecret), false);
});

test("claim is single use and creates a refreshable mobile bootstrap secret", async () => {
  const { store } = fixture();
  const issued = await store.issue("school-pc", "desktop-public-key");
  const claimed = await store.claim(issued.pairing, "phone", "mobile-public-key");
  assert.equal(claimed.relationship.mobileId, "phone");
  assert.equal(claimed.mobileSecret, "secret_3");
  await assert.rejects(() => store.claim(issued.pairing, "other", "key"), /pairing_invalid/);
});

test("both endpoints exchange only their own bootstrap secret for role-bound session tokens", async () => {
  const { store, now } = fixture();
  const issued = await store.issue("school-pc", "desktop-public-key");
  const claimed = await store.claim(issued.pairing, "phone", "mobile-public-key");
  const secret = "session-signing-secret";
  const desktop = await store.issueSessionToken("room_school", "desktop", "school-pc", issued.desktopSecret, secret);
  const mobile = await store.issueSessionToken("room_school", "mobile", "phone", claimed.mobileSecret, secret);
  assert.equal(desktop.expiresAt, now + SESSION_TTL_MS);
  assert.equal((await verifySessionCredential(desktop.token, secret, now)).role, "desktop");
  assert.equal((await verifySessionCredential(mobile.token, secret, now)).role, "mobile");
  await assert.rejects(() => store.issueSessionToken("room_school", "desktop", "school-pc", claimed.mobileSecret, secret), /pairing_invalid/);
});

test("either paired endpoint can revoke the relationship", async () => {
  const { store } = fixture();
  const issued = await store.issue("school-pc", "desktop-public-key");
  await store.claim(issued.pairing, "phone", "mobile-public-key");
  assert.equal(await store.revoke("room_school", "mobile", "phone"), true);
  assert.equal(await store.getRelationship("room_school"), undefined);
});
