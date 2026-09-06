import assert from "node:assert/strict";
import test from "node:test";
import { pairingRefKey } from "../../../packages/protocol/src/index.ts";
import { groupTransfersByTarget } from "../src/transfer/targets.ts";

test("queued transfers stay grouped by their enqueue-time room and desktop", () => {
  const targetA = { roomId: "room-a", desktopId: "desktop-a" };
  const targetB = { roomId: "room-b", desktopId: "desktop-b" };
  const items = [
    { id: "a-1", target: targetA },
    { id: "legacy", target: null },
    { id: "b-1", target: targetB },
    { id: "a-2", target: targetA },
  ];
  const grouped = groupTransfersByTarget(items);
  assert.deepEqual(grouped.byTarget.get(pairingRefKey(targetA))?.map((item) => item.id), ["a-1", "a-2"]);
  assert.deepEqual(grouped.byTarget.get(pairingRefKey(targetB))?.map((item) => item.id), ["b-1"]);
  assert.deepEqual(grouped.unassigned.map((item) => item.id), ["legacy"]);
});
