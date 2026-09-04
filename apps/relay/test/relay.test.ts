import assert from "node:assert/strict";
import test from "node:test";
import { signSessionCredential, verifySessionCredential, type SessionCredential } from "../src/auth.ts";
import { RelayRoom, type RelayPayload, type RelaySocket } from "../src/room.ts";

const SECRET = "test-secret-at-least-random-in-production";
const TRANSFER_ID = "123e4567-e89b-42d3-a456-426614174000";
class FakeSocket implements RelaySocket { sent: RelayPayload[] = []; closed = false; send(data: RelayPayload) { this.sent.push(data); } close() { this.closed = true; } }
const credential = (role: "mobile" | "desktop", deviceId: string): SessionCredential => ({ version: 1, roomId: "room-a", deviceId, role, expiresAt: 1800000000000 });

test("session credentials reject tampering and expiration", async () => {
  const token = await signSessionCredential(credential("desktop", "school-pc"), SECRET);
  assert.equal((await verifySessionCredential(token, SECRET, 1700000000000)).deviceId, "school-pc");
  await assert.rejects(() => verifySessionCredential(`${token}x`, SECRET, 1700000000000), /pairing_invalid/);
  await assert.rejects(() => verifySessionCredential(token, SECRET, 1900000000000), /pairing_invalid/);
});

test("room forwards binary frames without inspecting document bytes", () => {
  const room = new RelayRoom(); const mobile = new FakeSocket(); const desktop = new FakeSocket();
  room.attach(credential("mobile", "phone"), mobile); room.attach(credential("desktop", "school-pc"), desktop);
  const bytes = Uint8Array.from([9,8,7,6]); room.handle("mobile", bytes);
  assert.equal(desktop.sent.at(-1), bytes);
});

test("transfer start is rejected when the requested desktop is offline", () => {
  const room = new RelayRoom(); const mobile = new FakeSocket(); room.attach(credential("mobile", "phone"), mobile);
  room.handle("mobile", JSON.stringify({ type: "transfer:start", transferId: TRANSFER_ID, destinationDeviceId: "school-pc", name: "한글.pdf", size: 4, mime: "application/pdf", sha256: "a".repeat(64), chunkSize: 1048576 }));
  const rejection = JSON.parse(String(mobile.sent.at(-1)));
  assert.equal(rejection.type, "transfer:reject"); assert.equal(rejection.reason, "destination_offline");
});

test("reconnecting the same role replaces the stale socket", () => {
  const room = new RelayRoom(); const first = new FakeSocket(); const second = new FakeSocket();
  room.attach(credential("desktop", "school-pc"), first); room.attach(credential("desktop", "school-pc"), second);
  assert.equal(first.closed, true);
});
