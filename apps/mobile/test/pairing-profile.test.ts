import assert from "node:assert/strict";
import test from "node:test";
import { applyDesktopAlias } from "../src/pairing/profile.ts";

test("profile updates only its room/device pair without mutating or resurrecting entries", () => {
  const pairings = [
    { roomId: "a", desktopId: "pc", desktopAlias: "old" },
    { roomId: "b", desktopId: "pc", desktopAlias: "other" },
  ];
  const updated = applyDesktopAlias(pairings, pairings[0], "new");
  assert.equal(updated[0].desktopAlias, "new");
  assert.equal(updated[1], pairings[1]);
  assert.equal(pairings[0].desktopAlias, "old");
  assert.deepEqual(applyDesktopAlias([], pairings[0], "new"), []);
});
